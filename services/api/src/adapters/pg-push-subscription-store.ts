import type { PushSubscription, PushSubscriptionCreate } from '@ohmydate/contracts';
import {
  NotFoundError,
  VersionConflictError,
  instantToEpochMs,
  type Clock,
  type Id,
  type Instant,
} from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import { DailyProblemError } from '../application/daily-errors.js';
import { encryptPushValue, type PushKey } from '../application/push-crypto.js';

type Db = Kysely<Database>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

export class PgPushSubscriptionStore {
  readonly #db: Db;
  readonly #ids: import('@ohmydate/domain').IdGenerator;
  readonly #key: PushKey;
  readonly #clock: Clock;

  constructor(options: {
    readonly db: Db;
    readonly ids: import('@ohmydate/domain').IdGenerator;
    readonly key: PushKey;
    readonly clock: Clock;
  }) {
    this.#db = options.db;
    this.#ids = options.ids;
    this.#key = options.key;
    this.#clock = options.clock;
  }

  async create(ownerId: Id, input: PushSubscriptionCreate): Promise<PushSubscription> {
    const now = new Date(instantToEpochMs(this.#clock.now()));
    try {
      const row = await this.#db
        .insertInto('push_subscription')
        .values({
          id: this.#ids.next(),
          owner_id: ownerId,
          endpoint: input.endpoint,
          p256dh_ciphertext: encryptPushValue(input.keys.p256dh, this.#key.key, this.#key.keyId),
          auth_ciphertext: encryptPushValue(input.keys.auth, this.#key.key, this.#key.keyId),
          key_id: this.#key.keyId,
          device_label: input.deviceLabel ?? null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return this.#map(row);
    } catch (error) {
      if (
        error instanceof Error &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new DailyProblemError({
          status: 409,
          code: 'illegal_transition',
          title: 'State conflict',
          detail: 'this push endpoint is already registered',
        });
      }
      throw error;
    }
  }

  async delete(ownerId: Id, id: Id, expectedVersion: number): Promise<void> {
    const deleted = await this.#db
      .deleteFrom('push_subscription')
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('version', '=', expectedVersion)
      .returning('id')
      .executeTakeFirst();
    if (deleted !== undefined) return;
    const current = await this.#db
      .selectFrom('push_subscription')
      .select(['version'])
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    if (current === undefined) throw new NotFoundError('push subscription', id);
    throw new VersionConflictError(expectedVersion as never, current.version as never);
  }

  #map(row: {
    id: string;
    endpoint: string;
    device_label: string | null;
    created_at: Date | string;
    version: number;
  }): PushSubscription {
    return {
      id: row.id as Id,
      endpoint: row.endpoint,
      ...(row.device_label === null ? {} : { deviceLabel: row.device_label }),
      createdAt: toInstant(row.created_at),
      version: row.version,
    };
  }
}
