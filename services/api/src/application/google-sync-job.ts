import type { LeaderLock } from '../adapters/vikunja/reconciler.js';

export interface GoogleSyncRunner {
  /** One pass over every connected owner; never rejects for one owner's failure. */
  runScheduledSync(): Promise<number>;
}

export interface GoogleSyncJobOptions {
  readonly runner: GoogleSyncRunner;
  /** GOOGLE_SYNC_INTERVAL_MS; 0 (or less) disables the job. */
  readonly intervalMs: number;
  readonly leaderLock?: LeaderLock;
  readonly logger?: {
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
 * CAL-03 leader-only Google sync (08 §4 advisory lock, like the notification
 * and replan detection jobs). A tick that is still running when the next one
 * fires is skipped; `stop()` clears the timer and waits for the running tick
 * (the service's `close()` aborts its Google calls).
 */
export class GoogleSyncJob {
  readonly #options: GoogleSyncJobOptions;
  #timer: { stop(): void } | undefined;
  #inFlight: Promise<boolean> | undefined;

  constructor(options: GoogleSyncJobOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (!Number.isInteger(this.#options.intervalMs) || this.#options.intervalMs <= 0) return;
    const scheduler = this.#options.scheduler ?? defaultScheduler;
    this.#timer = scheduler(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#options.logger?.error('google sync job tick failed', {
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
    if (this.#options.leaderLock === undefined) {
      await this.#options.runner.runScheduledSync();
      return true;
    }
    return this.#options.leaderLock(async ({ signal, isLeader }) => {
      if (signal.aborted || !(await isLeader())) return;
      await this.#options.runner.runScheduledSync();
    });
  }
}
