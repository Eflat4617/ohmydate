import { instantToEpochMs, type Clock, type Id, type IdGenerator } from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import type {
  IdempotencyCompleteInput,
  IdempotencyReservation,
  IdempotencyReserveInput,
  IdempotencyStore,
  StoredResponse,
} from '../application/ports.js';
import { jsonb, type Database, type JsonValue } from '../db/types.js';

export interface PgIdempotencyStoreOptions {
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly ttlMs: number;
}

function parseResponse(value: JsonValue | null): StoredResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('idempotency_record.response is not an object');
  }
  const record = value as unknown as StoredResponse;
  return {
    status: record.status,
    body: record.body,
    headers: record.headers ?? {},
  };
}

/**
 * PG-backed idempotency store (ADR-016 §2).
 *
 * The reservation is committed as `pending` before the repository is called.
 * Completion updates the record and inserts outbox rows in one PG transaction.
 * In M1 the TaskRepository is in-memory, so the repository mutation is outside
 * that transaction; the PG repository will join it by accepting the same
 * transaction handle when it lands.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  readonly #db: PgIdempotencyStoreOptions['db'];
  readonly #clock: PgIdempotencyStoreOptions['clock'];
  readonly #ids: PgIdempotencyStoreOptions['ids'];
  readonly #ttlMs: number;

  constructor(options: PgIdempotencyStoreOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#ttlMs = options.ttlMs;
  }

  async reserve(input: IdempotencyReserveInput): Promise<IdempotencyReservation> {
    const nowMs = instantToEpochMs(this.#clock.now());

    return this.#db.transaction().execute(async (trx) => {
      const existing = await trx
        .selectFrom('idempotency_record')
        .selectAll()
        .where('owner_id', '=', input.ownerId)
        .where('key', '=', input.key)
        .executeTakeFirst();

      if (existing !== undefined) {
        if (existing.expires_at.getTime() <= nowMs) {
          await trx
            .deleteFrom('idempotency_record')
            .where('id', '=', existing.id)
            .execute();
        } else {
          if (existing.request_hash !== input.requestHash) return { kind: 'mismatch' };
          if (existing.status === 'completed' && existing.response !== null) {
            return { kind: 'replay', response: parseResponse(existing.response) };
          }
          return { kind: 'pending' };
        }
      }

      await trx
        .insertInto('idempotency_record')
        .values({
          id: this.#ids.next(),
          owner_id: input.ownerId,
          key: input.key,
          route: input.route,
          request_hash: input.requestHash,
          status: 'pending',
          expires_at: new Date(nowMs + this.#ttlMs),
        })
        .execute();

      return { kind: 'reserved' };
    });
  }

  async complete(input: IdempotencyCompleteInput): Promise<void> {
    const now = new Date(instantToEpochMs(this.#clock.now()));
    const response = {
      status: input.response.status,
      body: (input.response.body ?? null) as JsonValue,
      headers: { ...input.response.headers },
    };

    await this.#db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable('idempotency_record')
        .set({
          status: 'completed',
          response: jsonb(response as unknown as JsonValue),
          updated_at: now,
        })
        .where('owner_id', '=', input.ownerId)
        .where('key', '=', input.key)
        .where('status', '=', 'pending')
        .returning('id')
        .executeTakeFirst();

      if (updated === undefined) {
        throw new Error('idempotency reservation disappeared before completion');
      }

      for (const event of input.outbox) {
        await trx
          .insertInto('outbox_event')
          .values({
            id: this.#ids.next(),
            owner_id: input.ownerId,
            topic: event.topic,
            payload: jsonb({ taskId: event.taskId, version: event.version }),
          })
          .execute();
      }
    });
  }

  async release(ownerId: Id, key: string): Promise<void> {
    await this.#db
      .deleteFrom('idempotency_record')
      .where('owner_id', '=', ownerId)
      .where('key', '=', key)
      .where('status', '=', 'pending')
      .execute();
  }
}
