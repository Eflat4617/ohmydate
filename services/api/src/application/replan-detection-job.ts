import type { Clock, Instant } from '@ohmydate/domain';
import type { LeaderLock } from '../adapters/vikunja/reconciler.js';

export interface ReplanDetectionRunner {
  runDetection(now: Instant): Promise<number>;
}

export interface ReplanDetectionJobOptions {
  readonly runner: ReplanDetectionRunner;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly leaderLock?: LeaderLock;
  readonly logger?: {
    warn(message: string, details?: Readonly<Record<string, unknown>>): void;
    error(message: string, details?: Readonly<Record<string, unknown>>): void;
  };
  readonly scheduler?: (callback: () => void, milliseconds: number) => { stop(): void };
}

const defaultScheduler = (callback: () => void, milliseconds: number) => {
  const handle = setInterval(callback, milliseconds);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
};

/**
 * Leader-only replan detection sweep (05 §11, 08 §4 advisory lock). The
 * store additionally serializes per owner and the pending (owner, reason)
 * partial unique index dedupes, so a second leader (or a lost lock) never
 * produces a duplicate proposal.
 */
export class ReplanDetectionJob {
  readonly #options: ReplanDetectionJobOptions;
  #timer: { stop(): void } | undefined;
  #inFlight: Promise<boolean> | undefined;

  constructor(options: ReplanDetectionJobOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (!Number.isInteger(this.#options.intervalMs) || this.#options.intervalMs <= 0) return;
    const scheduler = this.#options.scheduler ?? defaultScheduler;
    this.#timer = scheduler(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#options.logger?.error('replan detection job tick failed', {
          error: error instanceof Error ? error.name : 'unknown',
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
      await this.#options.runner.runDetection(now);
      return true;
    }
    return this.#options.leaderLock(async ({ signal, isLeader }) => {
      if (signal.aborted || !(await isLeader())) return;
      await this.#options.runner.runDetection(now);
    });
  }
}
