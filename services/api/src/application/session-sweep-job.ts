/** Expired login sessions are swept at boot and then every ten minutes. */
export const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 600_000;

export interface SessionSweepStore {
  /** Deletes up to `limit` expired sessions; returns how many were removed. */
  sweepExpired(limit?: number): Promise<number>;
}

export interface SessionSweepJobOptions {
  readonly store: SessionSweepStore;
  /** 0 (or any non-positive value) disables the job, including the boot run. */
  readonly intervalMs: number;
  readonly batchSize?: number;
  readonly logger?: {
    warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  };
  readonly scheduler?: (callback: () => void, milliseconds: number) => { stop(): void };
}

const defaultScheduler = (callback: () => void, milliseconds: number) => {
  const handle = setInterval(callback, milliseconds);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
};

/**
 * FU-92: hygiene sweep for `auth_session`. Reads already reject expired
 * sessions, so this only bounds table growth: one batched DELETE per tick, no
 * leader lock (concurrent sweeps are harmless). `stop()` clears the timer and
 * waits for an in-flight sweep, so shutdown leaves no timer or query behind.
 */
export class SessionSweepJob {
  readonly #options: SessionSweepJobOptions;
  #timer: { stop(): void } | undefined;
  #inFlight: Promise<number> | undefined;
  #stopped = false;

  constructor(options: SessionSweepJobOptions) {
    this.#options = options;
  }

  start(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    if (!Number.isInteger(this.#options.intervalMs) || this.#options.intervalMs <= 0) return;
    const scheduler = this.#options.scheduler ?? defaultScheduler;
    this.#timer = scheduler(() => {
      void this.runOnce();
    }, this.#options.intervalMs);
    void this.runOnce();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#timer?.stop();
    this.#timer = undefined;
    await this.#inFlight;
  }

  /** One sweep; never rejects (failures are logged by error name only). */
  runOnce(): Promise<number> {
    if (this.#stopped) return Promise.resolve(0);
    if (this.#inFlight !== undefined) return this.#inFlight;
    let sweep: Promise<number>;
    try {
      sweep = this.#options.store.sweepExpired(this.#options.batchSize);
    } catch (error) {
      sweep = Promise.reject(error);
    }
    const promise = sweep
      .catch((error: unknown) => {
        this.#options.logger?.warn('expired session sweep failed', {
          name: error instanceof Error ? error.name : 'unknown',
        });
        return 0;
      })
      .finally(() => {
        if (this.#inFlight === promise) this.#inFlight = undefined;
      });
    this.#inFlight = promise;
    return promise;
  }
}
