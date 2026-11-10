import type { Clock, Id, Instant, Version } from '@ohmydate/domain';
import { NotFoundError, VersionConflictError } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, UserTable } from '../db/types.js';
import type { UserRecord, UserRepository, UserSettingsPatch } from '../application/ports.js';

type UserRow = Selectable<UserTable>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id as Id,
    email: row.email,
    passwordHash: row.password_hash,
    timeZone: row.time_zone,
    locale: row.locale,
    version: row.version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class PgUserRepository implements UserRepository {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;

  constructor(db: Kysely<Database>, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = await this.#db
      .selectFrom('user')
      .selectAll()
      .where('email', '=', normalizeEmail(email))
      .executeTakeFirst();
    return row === undefined ? null : mapUser(row);
  }

  async get(id: Id): Promise<UserRecord | null> {
    const row = await this.#db
      .selectFrom('user')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row === undefined ? null : mapUser(row);
  }

  async insert(input: {
    readonly id: Id;
    readonly email: string;
    readonly passwordHash: string;
    readonly timeZone?: string;
    readonly locale?: string;
  }): Promise<UserRecord> {
    const row = await this.#db
      .insertInto('user')
      .values({
        id: input.id,
        email: normalizeEmail(input.email),
        password_hash: input.passwordHash,
        ...(input.timeZone === undefined ? {} : { time_zone: input.timeZone }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapUser(row);
  }

  async updateSettings(
    id: Id,
    patch: UserSettingsPatch,
    expectedVersion: number,
  ): Promise<UserRecord> {
    const updated = await this.#db
      .updateTable('user')
      .set({
        ...(patch.timeZone === undefined ? {} : { time_zone: patch.timeZone }),
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        updated_at: new Date(this.#clock.now()),
        version: sql<number>`version + 1`,
      })
      .where('id', '=', id)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();

    if (updated !== undefined) return mapUser(updated);

    const current = await this.get(id);
    if (current === null) throw new NotFoundError('user', id);
    throw new VersionConflictError(expectedVersion as Version, current.version as Version);
  }
}
