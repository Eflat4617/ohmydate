import type { Clock, Id, Instant, Version } from '@ohmydate/domain';
import { NotFoundError, VersionConflictError } from '@ohmydate/domain';
import { sql, type Kysely, type Selectable } from 'kysely';
import type { Database, JsonValue, JsonbParam, UserTable } from '../db/types.js';
import type {
  LlmBudgetSettings,
  LlmConsentSettings,
  LlmUserSettings,
  UserRecord,
  UserRepository,
  UserSettings,
  UserSettingsPatch,
} from '../application/ports.js';

type UserRow = Selectable<UserTable>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : value) as Instant;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseConsent(value: unknown): LlmConsentSettings | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value['granted'] === 'boolean' &&
    typeof value['at'] === 'string' &&
    typeof value['provider'] === 'string'
    ? {
        granted: value['granted'],
        at: value['at'] as Instant,
        provider: value['provider'],
      }
    : undefined;
}

function parseBudget(value: unknown): LlmBudgetSettings | undefined {
  if (!isRecord(value)) return undefined;
  const dailyUsd = value['dailyUsd'];
  const monthlyUsd = value['monthlyUsd'];
  return typeof dailyUsd === 'number' &&
    Number.isFinite(dailyUsd) &&
    typeof monthlyUsd === 'number' &&
    Number.isFinite(monthlyUsd)
    ? { dailyUsd, monthlyUsd }
    : undefined;
}

/** Parses the owner-scoped `user.settings` JSONB; unknown keys are ignored. */
export function parseUserSettings(value: JsonValue | undefined): UserSettings {
  if (!isRecord(value)) return {};
  const llm = value['llm'];
  if (!isRecord(llm)) return {};
  const consent = parseConsent(llm['consent']);
  const budget = parseBudget(llm['budget']);
  const parsed: LlmUserSettings = {
    ...(consent === undefined ? {} : { consent }),
    ...(budget === undefined ? {} : { budget }),
  };
  return Object.keys(parsed).length === 0 ? {} : { llm: parsed };
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id as Id,
    email: row.email,
    passwordHash: row.password_hash,
    timeZone: row.time_zone,
    locale: row.locale,
    settings: parseUserSettings(row.settings),
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
    const settings =
      patch.llm === undefined
        ? undefined
        : (sql`jsonb_set(coalesce(settings, '{}'::jsonb), '{llm}', coalesce(settings->'llm', '{}'::jsonb) || ${JSON.stringify(patch.llm)}::jsonb, true)` as unknown as JsonbParam);
    const updated = await this.#db
      .updateTable('user')
      .set({
        ...(patch.timeZone === undefined ? {} : { time_zone: patch.timeZone }),
        ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        ...(settings === undefined ? {} : { settings }),
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
