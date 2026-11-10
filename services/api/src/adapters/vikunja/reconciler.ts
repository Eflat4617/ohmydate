import type { Id, TaskRepository, Clock } from '@ohmydate/domain';
import pg from 'pg';

const { Client } = pg;

/**
 * Advisory-lock key for the in-process Vikunja reconciler. Kept stable so two
 * API instances (or a leftover session) cannot sweep the same database at once.
 */
export const VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY = 5_196_101;

export type LeaderRun = () => Promise<void>;
export type LeaderLock = (run: LeaderRun) => Promise<boolean>;

export interface PgSessionLeaderLockOptions {
  readonly connectionString: string;
  readonly key?: number;
}

/**
 * Session-level `pg_try_advisory_lock` on a dedicated connection (08 §4).
 *
 * The lock is intentionally NOT transaction-scoped: a sweep makes HTTP calls,
 * and holding an idle-in-transaction connection would exhaust the pool (or be
 * killed by idle_in_transaction_session_timeout). The connection is closed in
 * `finally`, which also releases the lock if the sweep throws.
 */
export function createPgSessionLeaderLock(options: PgSessionLeaderLockOptions): LeaderLock {
  const key = options.key ?? VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY;
  return async (run) => {
    const client = new Client({ connectionString: options.connectionString });
    await client.connect();
    try {
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );
      if (acquired.rows[0]?.locked !== true) return false;
      try {
        await run();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => undefined);
      }
      return true;
    } finally {
      await client.end();
    }
  };
}

export interface ReconcilerLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface IntervalScheduler {
  (callback: () => void, milliseconds: number): { stop(): void };
}

const defaultScheduler: IntervalScheduler = (callback, milliseconds) => {
  const handle = setInterval(callback, milliseconds);
  handle.unref?.();
  return { stop: () => clearInterval(handle) };
};

export interface VikunjaReconcilerOptions {
  /** Only `listChangedSince` is used; the adapter's null scan reconciles. */
  readonly taskRepository: Pick<TaskRepository, 'listChangedSince'>;
  /** Owners with a mapping or Vikunja account, including needs_reconcile rows. */
  readonly ownerIds: () => Promise<readonly Id[]>;
  readonly leaderLock: LeaderLock;
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly logger?: ReconcilerLogger;
  readonly scheduler?: IntervalScheduler;
}

/**
 * Periodic Vikunja reconciliation (08 §4, ADR-016 §3).
 *
 * Disabled by default (`VIKUNJA_RECONCILE_INTERVAL_MS=0`) until FU-22 wires
 * `expectedLocalVersion` into the adapter's non-create mapping puts; see the
 * config docs. On each tick the leader lists owners (the query includes owners
 * whose mapping has `needs_reconcile = true`) and calls
 * `listChangedSince(owner, null)`. That adapter call performs the remote
 * `updated >= watermark` scan, the deleted-task scan, and clears/commits any
 * staged `needs_reconcile` rows.
 */
export class VikunjaReconciler {
  readonly #options: VikunjaReconcilerOptions;
  #timer: { stop(): void } | undefined;
  #inFlight: Promise<boolean> | undefined;
  #lastRunAt: string | undefined;

  constructor(options: VikunjaReconcilerOptions) {
    this.#options = options;
  }

  get intervalMs(): number {
    return this.#options.intervalMs;
  }

  get lastRunAt(): string | undefined {
    return this.#lastRunAt;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    if (!Number.isInteger(this.#options.intervalMs) || this.#options.intervalMs <= 0) return;
    const scheduler = this.#options.scheduler ?? defaultScheduler;
    this.#timer = scheduler(() => {
      void this.runOnce().catch((error: unknown) => {
        this.#options.logger?.error('vikunja reconciliation tick failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#options.intervalMs);
  }

  /** Stops the timer and awaits any sweep already in flight. */
  async stop(): Promise<void> {
    this.#timer?.stop();
    this.#timer = undefined;
    await this.#inFlight?.catch(() => undefined);
  }

  /**
   * Runs one sweep. Returns false when another run is in flight or this process
   * is not the leader; the timer treats both as a no-op.
   */
  runOnce(): Promise<boolean> {
    if (this.#inFlight !== undefined) return Promise.resolve(false);
    const promise = this.#execute().finally(() => {
      if (this.#inFlight === promise) this.#inFlight = undefined;
    });
    this.#inFlight = promise;
    return promise;
  }

  async #execute(): Promise<boolean> {
    const owners = await this.#options.ownerIds();
    return this.#options.leaderLock(async () => {
      for (const ownerId of owners) {
        try {
          await this.#options.taskRepository.listChangedSince(ownerId, null);
        } catch (error) {
          this.#options.logger?.warn('vikunja reconciliation failed for owner', {
            ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.#lastRunAt = this.#options.clock.now();
    });
  }
}
