import { epochMsToInstant, instantToEpochMs, type Clock, type Id } from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import type { CreatedSession, SessionRecord, SessionStore } from '../application/ports.js';
import {
  createSessionSecret,
  hashSessionSecret,
  isSessionSecretShape,
  sessionHashesEqual,
} from '../application/session-tokens.js';
import type { Database } from '../db/types.js';

/** A session's sliding expiry is written at most once per minute. */
export const DEFAULT_SESSION_TOUCH_INTERVAL_MS = 60_000;
/** Rows removed per expired-session sweep (one cheap DELETE). */
export const DEFAULT_SESSION_SWEEP_BATCH_SIZE = 500;

export interface PgSessionStoreOptions {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly ttlMs: number;
  /**
   * Minimum gap between two sliding-expiry writes of one session. Requests
   * inside the gap only read, so the stored expiry trails "now + TTL" by at
   * most this much.
   */
  readonly touchIntervalMs?: number;
}

interface SessionRow {
  readonly id_hash: string;
  readonly user_id: string;
  readonly csrf_token_hash: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly expires_at: Date;
}

const SESSION_COLUMNS = [
  'id_hash',
  'user_id',
  'csrf_token_hash',
  'created_at',
  'last_seen_at',
  'expires_at',
] as const;

function toRecord(sessionId: string, row: SessionRow): SessionRecord {
  return {
    id: sessionId,
    userId: row.user_id as Id,
    csrfTokenHash: row.csrf_token_hash,
    createdAt: epochMsToInstant(row.created_at.getTime()),
    expiresAt: row.expires_at.getTime(),
  };
}

/**
 * FU-92: login sessions in the planner database (`auth_session`, 0015), so a
 * login survives API restarts. Same contract as InMemorySessionStore: expired
 * sessions read as null (and are deleted), `touch` slides the expiry to
 * now + TTL, logout deletes.
 *
 * Only SHA-256 digests of the `sid` and CSRF token are stored. Lookups use the
 * digest of the presented `sid` (a 256-bit random value, so the index lookup
 * reveals nothing useful about it), and digests are compared in constant time.
 * Time comes from the injected Clock, never from the database.
 */
export class PgSessionStore implements SessionStore {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #touchIntervalMs: number;

  constructor(options: PgSessionStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs;
    this.#touchIntervalMs = options.touchIntervalMs ?? DEFAULT_SESSION_TOUCH_INTERVAL_MS;
  }

  async create(userId: Id, csrfToken: string): Promise<CreatedSession> {
    const id = createSessionSecret();
    const nowMs = this.#nowMs();
    const expiresAt = nowMs + this.#ttlMs;
    const csrfTokenHash = hashSessionSecret(csrfToken);
    await this.#db
      .insertInto('auth_session')
      .values({
        id_hash: hashSessionSecret(id),
        user_id: userId,
        csrf_token_hash: csrfTokenHash,
        created_at: new Date(nowMs),
        last_seen_at: new Date(nowMs),
        expires_at: new Date(expiresAt),
      })
      .execute();
    return {
      id,
      userId,
      csrfToken,
      csrfTokenHash,
      createdAt: epochMsToInstant(nowMs),
      expiresAt,
    };
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const found = await this.#findLive(sessionId);
    return found === null ? null : toRecord(sessionId, found.row);
  }

  async touch(sessionId: string): Promise<SessionRecord | null> {
    const found = await this.#findLive(sessionId);
    if (found === null) return null;
    const { row, nowMs } = found;
    const sinceLastWrite = nowMs - row.last_seen_at.getTime();
    // Bounded write frequency: inside the interval the stored expiry stands.
    // A clock that moved backwards (negative gap) re-anchors the expiry.
    if (sinceLastWrite >= 0 && sinceLastWrite < this.#touchIntervalMs) {
      return toRecord(sessionId, row);
    }
    const updated = await this.#db
      .updateTable('auth_session')
      .set({
        last_seen_at: new Date(nowMs),
        expires_at: new Date(nowMs + this.#ttlMs),
      })
      .where('id_hash', '=', row.id_hash)
      .where('expires_at', '>', new Date(nowMs))
      .returning(SESSION_COLUMNS)
      .executeTakeFirst();
    // Logged out, swept or the user deleted between the read and the write.
    if (updated === undefined) return null;
    return toRecord(sessionId, updated);
  }

  async delete(sessionId: string): Promise<void> {
    if (!isSessionSecretShape(sessionId)) return;
    await this.#db
      .deleteFrom('auth_session')
      .where('id_hash', '=', hashSessionSecret(sessionId))
      .execute();
  }

  /**
   * Deletes up to `limit` sessions whose expiry has passed (oldest first) and
   * returns how many were removed. Safe to run from several processes.
   */
  async sweepExpired(limit = DEFAULT_SESSION_SWEEP_BATCH_SIZE): Promise<number> {
    const now = new Date(this.#nowMs());
    const result = await this.#db
      .deleteFrom('auth_session')
      .where('id_hash', 'in', (eb) =>
        eb
          .selectFrom('auth_session')
          .select('id_hash')
          .where('expires_at', '<=', now)
          .orderBy('expires_at')
          .limit(limit),
      )
      .executeTakeFirst();
    return Number(result.numDeletedRows);
  }

  #nowMs(): number {
    return instantToEpochMs(this.#clock.now());
  }

  async #findLive(
    sessionId: string,
  ): Promise<{ readonly row: SessionRow; readonly nowMs: number } | null> {
    // Tampered or foreign cookie values never reach the database.
    if (!isSessionSecretShape(sessionId)) return null;
    const idHash = hashSessionSecret(sessionId);
    const row = await this.#db
      .selectFrom('auth_session')
      .select(SESSION_COLUMNS)
      .where('id_hash', '=', idHash)
      .executeTakeFirst();
    if (row === undefined || !sessionHashesEqual(row.id_hash, idHash)) return null;
    const nowMs = this.#nowMs();
    if (row.expires_at.getTime() <= nowMs) {
      await this.#db
        .deleteFrom('auth_session')
        .where('id_hash', '=', idHash)
        .where('expires_at', '<=', new Date(nowMs))
        .execute();
      return null;
    }
    return { row, nowMs };
  }
}
