import type { Id } from '@ohmydate/domain';
import pg from 'pg';
import type {
  IntakeApprovalLock,
  IntakeApprovalLockHandle,
} from '../application/intake/ports.js';
import { intakeSessionLockKey } from './intake-session-advisory.js';

const { Client } = pg;

const LOCK_QUERY_TIMEOUT_MS = 5_000;
const LOCK_KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const LOCK_SERVER_KEEPALIVES = {
  idleSeconds: 30,
  intervalSeconds: 10,
  count: 3,
} as const;

export interface PgIntakeApprovalLockOptions {
  readonly connectionString: string;
  /** Logs connection loss without echoing the connection string or a token. */
  readonly logger?: {
    warn(message: string, details?: Readonly<Record<string, unknown>>): void;
  };
  readonly queryTimeoutMs?: number;
}

/**
 * ADR-020 §1: hold `pg_try_advisory_lock` on a dedicated connection for the
 * whole approval. The lock is session-scoped (approval makes provider HTTP
 * calls, so a transaction-scoped lock would idle inside a transaction). Process
 * death closes the connection and releases the lock automatically; there is no
 * lease and therefore no time-based takeover.
 */
export class PgIntakeApprovalLock implements IntakeApprovalLock {
  readonly #connectionString: string;
  readonly #logger: PgIntakeApprovalLockOptions['logger'];
  readonly #queryTimeoutMs: number;

  constructor(options: PgIntakeApprovalLockOptions) {
    this.#connectionString = options.connectionString;
    this.#logger = options.logger;
    this.#queryTimeoutMs = options.queryTimeoutMs ?? LOCK_QUERY_TIMEOUT_MS;
  }

  async tryAcquire(
    ownerId: Id,
    sessionId: Id,
  ): Promise<IntakeApprovalLockHandle | null> {
    void ownerId;
    const client = new Client({
      connectionString: this.#connectionString,
      keepAlive: true,
      keepAliveInitialDelayMillis: LOCK_KEEPALIVE_INITIAL_DELAY_MS,
      statement_timeout: this.#queryTimeoutMs,
      query_timeout: this.#queryTimeoutMs,
      connectionTimeoutMillis: this.#queryTimeoutMs,
      options:
        `-c tcp_keepalives_idle=${LOCK_SERVER_KEEPALIVES.idleSeconds} ` +
        `-c tcp_keepalives_interval=${LOCK_SERVER_KEEPALIVES.intervalSeconds} ` +
        `-c tcp_keepalives_count=${LOCK_SERVER_KEEPALIVES.count}`,
    });
    let closing = false;
    const controller = new AbortController();
    const recordLoss = (reason: unknown): void => {
      // A checked-out pg client without an 'error' listener crashes the
      // process. ADR-020 §6: propagate the loss so the approver stops before
      // its next provider call or ledger write instead of continuing unlocked.
      if (closing || controller.signal.aborted) return;
      this.#logger?.warn('intake approval lock connection lost', {
        error: reason instanceof Error ? reason.message : String(reason),
      });
      if (!controller.signal.aborted) {
        controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
      }
    };
    const onError = (error: Error): void => recordLoss(error);
    const onEnd = (): void =>
      recordLoss(new Error('intake approval lock connection ended'));
    client.on('error', onError);
    client.on('end', onEnd);
    const close = async (): Promise<void> => {
      closing = true;
      await client.end().catch(() => undefined);
      client.removeListener('error', onError);
      client.removeListener('end', onEnd);
    };
    try {
      await client.connect();
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked',
        [intakeSessionLockKey(sessionId)],
      );
      if (acquired.rows[0]?.locked !== true) {
        await close();
        return null;
      }
      return {
        signal: controller.signal,
        release: close,
      };
    } catch (error) {
      await close();
      throw error;
    }
  }
}
