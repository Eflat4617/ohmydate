import type { Id, TaskRepository, Clock } from '@ohmydate/domain';
import pg from 'pg';

const { Client } = pg;

/**
 * Advisory-lock key for the in-process Vikunja reconciler. Kept stable so two
 * API instances (or a leftover session) cannot sweep the same database at once.
 */
export const VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY = 5_196_101;

/**
 * A sweep receives a lease tied to the leader-lock connection. `signal` aborts
 * on a detected loss and `isLeader()` actively probes the lock session between
 * owners (a silent partition never fires 'error'/'end', so events alone are
 * not enough). Losing leadership stops the sweep instead of letting a second
 * leader run concurrently.
 */
export interface LeaderLease {
  readonly signal: AbortSignal;
  isLeader(): Promise<boolean>;
}

export type LeaderRun = (lease: LeaderLease) => Promise<void>;
export type LeaderLock = (run: LeaderRun) => Promise<boolean>;

/**
 * Upper bound for the advisory lock/unlock and leadership-probe queries. A
 * blackholed connection would otherwise keep `app.close()` waiting for the TCP
 * retransmission timeout (~15 min).
 */
export const LEADER_LOCK_QUERY_TIMEOUT_MS = 5_000;

/** TCP keepalive probe delay on the dedicated lock connection. */
export const LEADER_LOCK_KEEPALIVE_INITIAL_DELAY_MS = 10_000;

export interface ReconcilerLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export interface PgSessionLeaderLockOptions {
  readonly connectionString: string;
  readonly key?: number;
  /** Logs connection loss without echoing the connection string or token. */
  readonly logger?: ReconcilerLogger;
  /** Bound on lock/unlock/probe queries; defaults to 5 s. */
  readonly queryTimeoutMs?: number;
}

/**
 * Session-level `pg_try_advisory_lock` on a dedicated connection (08 §4).
 *
 * The lock is intentionally NOT transaction-scoped: a sweep makes HTTP calls,
 * and holding an idle-in-transaction connection would exhaust the pool (or be
 * killed by idle_in_transaction_session_timeout). The connection is closed in
 * `finally`, which also releases the lock if the sweep throws.
 *
 * The client is an EventEmitter: without an 'error' listener a terminated
 * backend (failover, pg_terminate_backend, idle_session_timeout) would crash
 * the process. The listener logs through ReconcilerLogger and aborts the sweep;
 * 'end' covers a clean disconnect. `run()` never sees an unhandled event.
 */
export function createPgSessionLeaderLock(options: PgSessionLeaderLockOptions): LeaderLock {
  const key = options.key ?? VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY;
  const logger = options.logger;
  const queryTimeoutMs = options.queryTimeoutMs ?? LEADER_LOCK_QUERY_TIMEOUT_MS;
  return async (run) => {
    const client = new Client({
      connectionString: options.connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: LEADER_LOCK_KEEPALIVE_INITIAL_DELAY_MS,
      statement_timeout: queryTimeoutMs,
      query_timeout: queryTimeoutMs,
    });
    const controller = new AbortController();
    let lossLogged = false;
    let sweeping = true;
    // Exactly one error line per lost leadership, no matter whether the loss is
    // reported by the 'error' event, 'end', or a failed active probe.
    const recordLoss = (message: string, reason: unknown): void => {
      if (!lossLogged) {
        lossLogged = true;
        logger?.error(message, {
          error: reason instanceof Error ? reason.message : String(reason),
        });
      }
      if (!controller.signal.aborted) {
        controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };
    const onError = (error: unknown): void => {
      if (!sweeping) return;
      recordLoss('vikunja leader lock connection lost; aborting sweep', error);
    };
    const onEnd = (): void => {
      if (!sweeping) return;
      recordLoss(
        'vikunja leader lock connection ended; aborting sweep',
        new Error('vikunja leader lock connection ended'),
      );
    };
    const isLeader = async (): Promise<boolean> => {
      if (!sweeping || controller.signal.aborted) return false;
      try {
        await client.query('SELECT 1');
        return true;
      } catch (error) {
        recordLoss('vikunja leader lock connection lost; aborting sweep', error);
        return false;
      }
    };
    client.on('error', onError);
    client.on('end', onEnd);
    try {
      await client.connect();
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [key],
      );
      if (acquired.rows[0]?.locked !== true) return false;
      try {
        await run({ signal: controller.signal, isLeader });
      } finally {
        sweeping = false;
        if (!controller.signal.aborted) {
          await client.query('SELECT pg_advisory_unlock($1)', [key]).catch((error: unknown) => {
            // The sweep already finished; a slow/failed unlock only affects
            // how quickly the next leader can take over. `client.end()` below
            // releases the session lock regardless.
            logger?.warn('vikunja leader lock unlock failed after sweep', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      return !controller.signal.aborted;
    } finally {
      client.removeListener('error', onError);
      client.removeListener('end', onEnd);
      await client.end().catch(() => undefined);
    }
  };
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
 * Enabled by default for `PROVIDER=vikunja` with a database URL (300 s; see
 * config.ts). On each tick the leader lists owners (the query includes owners
 * whose mapping has `needs_reconcile = true`) and calls
 * `listChangedSince(owner, null)`. That adapter call performs the remote
 * `updated >= watermark` scan, the deleted-task scan, and clears/commits any
 * staged `needs_reconcile` rows. Leadership is re-checked between owners (and
 * once after the last owner) so a silent lock loss aborts the sweep before
 * `lastRunAt` advances.
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
   * Runs one sweep. Returns false when another run is in flight, this process
   * is not the leader, or leadership was lost before the sweep finished; the
   * timer treats all of those as a no-op.
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
    return this.#options.leaderLock(async ({ signal, isLeader }) => {
      for (const ownerId of owners) {
        // Active probe between owners: 'error'/'end' never fire on a silent
        // partition, and a stale leader must not sweep alongside a new one.
        if (signal.aborted || !(await isLeader())) return;
        try {
          await this.#options.taskRepository.listChangedSince(ownerId, null);
        } catch (error) {
          this.#options.logger?.warn('vikunja reconciliation failed for owner', {
            ownerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // Also covers loss during the LAST owner: the sweep is still "in flight"
      // until this point, so lastRunAt must not advance after an abort.
      if (signal.aborted || !(await isLeader())) return;
      this.#lastRunAt = this.#options.clock.now();
    });
  }
}
