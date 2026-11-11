import type {
  Notification,
  NotificationPage,
  NotificationQuery,
} from '@ohmydate/contracts';
import type { Clock, Id, Instant } from '@ohmydate/domain';
import type { LeaderLock } from '../adapters/vikunja/reconciler.js';

export interface NotificationStore {
  /** Creates in-app notifications for blocks starting within ten minutes. */
  runUpcoming(now: Instant): Promise<number>;
  list(ownerId: Id, query: NotificationQuery): Promise<NotificationPage>;
  get(ownerId: Id, id: Id): Promise<Notification | null>;
  dismiss(ownerId: Id, id: Id, expectedVersion: number, now: Instant): Promise<Notification>;
}

export interface NotificationJobLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface NotificationJobOptions {
  readonly store: NotificationStore;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly leaderLock?: LeaderLock;
  readonly logger?: NotificationJobLogger;
  readonly scheduler?: (
    callback: () => void,
    milliseconds: number,
  ) => { stop(): void };
}

const defaultScheduler = (callback: () => void, milliseconds: number) => {
  const handle = setInterval(callback, milliseconds);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
};

/** Leader-only notification sweep (08 §4 advisory lock; dedupe by DB unique). */
export class NotificationJob {
  readonly #options: NotificationJobOptions;
  #timer: { stop(): void } | undefined;
  #inFlight: Promise<boolean> | undefined;

  constructor(options: NotificationJobOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (!Number.isInteger(this.#options.intervalMs) || this.#options.intervalMs <= 0) return;
    const scheduler = this.#options.scheduler ?? defaultScheduler;
    this.#timer = scheduler(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#options.logger?.error('notification job tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#options.intervalMs);
  }

  async stop(): Promise<void> {
    this.#timer?.stop();
    this.#timer = undefined;
    await this.#inFlight?.catch(() => undefined);
  }

  runOnce(): Promise<boolean> {
    if (this.#inFlight !== undefined) return Promise.resolve(false);
    const promise = this.#execute().finally(() => {
      if (this.#inFlight === promise) this.#inFlight = undefined;
    });
    this.#inFlight = promise;
    return promise;
  }

  async #execute(): Promise<boolean> {
    const now = this.#options.clock.now();
    if (this.#options.leaderLock === undefined) {
      await this.#options.store.runUpcoming(now);
      return true;
    }
    return this.#options.leaderLock(async ({ signal, isLeader }) => {
      if (signal.aborted || !(await isLeader())) return;
      await this.#options.store.runUpcoming(now);
    });
  }
}
