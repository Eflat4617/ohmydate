import type { Id, TaskRepository, Clock } from '@ohmydate/domain';
import { sql, type Kysely } from 'kysely';
import type { Database } from '../../db/types.js';

/**
 * Advisory-lock key for the in-process Vikunja reconciler. Kept stable so two
 * API instances (or a leftover session) cannot sweep the same database at once.
 */
export const VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY = 5_196_101;

export type LeaderRun = () => Promise<void>;
export type LeaderLock = (run: LeaderRun) => Promise<boolean>;

/**
 * `pg_try_advisory_xact_lock` leader election (08 §4). The lock is held for the
 * transaction that wraps one sweep; a non-leader run returns false immediately.
 */
export function createPgAdvisoryLeaderLock(db: Kysely<Database>): LeaderLock {
  return async (run) =>
    db.transaction().execute(async (trx) => {
      const result = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_xact_lock(${sql.lit(VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY)}) AS locked
      `.execute(trx);
      if (result.rows[0]?.locked !== true) return false;
      await run();
      return true;
    });
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
 * On each tick the leader lists owners (the query includes owners whose mapping
 * has `needs_reconcile = true`) and calls `listChangedSince(owner, null)`. That
 * adapter call performs the remote `updated >= watermark` scan, the deleted-task
 * scan, and clears/commits any staged `needs_reconcile` rows, so a single pass
 * is both the incremental feed refresh and the reconciliation sweep.
 */
export class VikunjaReconciler {
  readonly #options: VikunjaReconcilerOptions;
  #timer: { stop(): void } | undefined;
  #running = false;
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

  stop(): void {
    this.#timer?.stop();
    this.#timer = undefined;
  }

  /**
   * Runs one sweep. Returns false when another run is in flight or this process
   * is not the leader; the timer treats both as a no-op.
   */
  async runOnce(): Promise<boolean> {
    if (this.#running) return false;
    this.#running = true;
    try {
      const owners = await this.#options.ownerIds();
      return await this.#options.leaderLock(async () => {
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
    } finally {
      this.#running = false;
    }
  }
}
