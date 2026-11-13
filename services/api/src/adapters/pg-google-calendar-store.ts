import type {
  Availability,
  CalendarDayEvent,
  GoogleCalendarAccessRole,
  GoogleIntegrationSettings,
  GoogleSyncErrorCode,
} from '@ohmydate/contracts';
import { GOOGLE_CALENDAR_ACCESS_ROLES, GOOGLE_SYNC_ERROR_CODES } from '@ohmydate/contracts';
import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  instantToEpochMs,
  type Clock,
  type Id,
  type IdGenerator,
  type Instant,
} from '@ohmydate/domain';
import { sql, type Kysely, type Transaction } from 'kysely';
import { DEFAULT_GOOGLE_SETTINGS } from '../application/google-integration.js';
import type {
  ExportLocalKind,
  ExportMappingRecord,
  ExportSource,
  GoogleCalendarRecord,
  GoogleCalendarStore,
  GoogleConnectionRecord,
  GoogleConnectionStatus,
  ImportChanges,
  ImportedCommitmentRow,
  ImportedCommitmentValues,
  ImportedDayEventRow,
  ImportedDayEventValues,
  ListedCalendar,
} from '../application/google-calendar-ports.js';
import { jsonb, type Database, type JsonValue } from '../db/types.js';
import { bumpAvailabilityVersion } from './pg-planning-store.js';

type Db = Kysely<Database>;
type Trx = Transaction<Database>;

function toDate(value: Instant | string): Date {
  return new Date(instantToEpochMs(value as Instant));
}

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as Instant;
}

function toDateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

const ACCESS_ROLES: ReadonlySet<string> = new Set(GOOGLE_CALENDAR_ACCESS_ROLES);
const ERROR_CODES: ReadonlySet<string> = new Set(GOOGLE_SYNC_ERROR_CODES);

/** Stored settings are validated field by field; anything else falls back to defaults. */
export function parseGoogleSettings(value: unknown): GoogleIntegrationSettings {
  const record =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const bool = (key: keyof GoogleIntegrationSettings): boolean => {
    const raw = record[key];
    return typeof raw === 'boolean' ? raw : (DEFAULT_GOOGLE_SETTINGS[key] as boolean);
  };
  const minutes = record['reminderMinutes'];
  return {
    exportBlocks: bool('exportBlocks'),
    exportCommitments: bool('exportCommitments'),
    dailySummary: bool('dailySummary'),
    reminderMinutes:
      minutes === null
        ? null
        : typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0 && minutes <= 40_320
          ? minutes
          : DEFAULT_GOOGLE_SETTINGS.reminderMinutes,
  };
}

function settingsJson(settings: GoogleIntegrationSettings): JsonValue {
  return { ...settings } as unknown as JsonValue;
}

interface ConnectionRow {
  id: string;
  owner_id: string;
  status: string;
  refresh_token_ciphertext: Buffer | null;
  token_key_id: string | null;
  granted_scopes: string[];
  export_calendar_id: string | null;
  settings: unknown;
  last_sync_at: Date | string | null;
  last_error: string | null;
  version: number;
}

function mapConnection(row: ConnectionRow): GoogleConnectionRecord {
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    status: row.status as GoogleConnectionStatus,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    tokenKeyId: row.token_key_id,
    grantedScopes: [...row.granted_scopes],
    exportCalendarId: row.export_calendar_id,
    settings: parseGoogleSettings(row.settings),
    lastSyncAt: row.last_sync_at === null ? null : toInstant(row.last_sync_at),
    lastError:
      row.last_error !== null && ERROR_CODES.has(row.last_error)
        ? (row.last_error as GoogleSyncErrorCode)
        : null,
    version: row.version,
  };
}

/**
 * PostgreSQL side of CAL-03. Every query is owner-scoped. Imported 약속 writes
 * bump the owner's availability_version once per transaction that changed
 * anything (the same rule as manual commitment writes), so plan approval and
 * replan detection see them exactly like manual edits.
 */
export class PgGoogleCalendarStore implements GoogleCalendarStore {
  readonly #db: Db;
  readonly #ids: IdGenerator;
  readonly #availability: (ownerId: Id) => Promise<Availability>;

  constructor(options: {
    readonly db: Db;
    readonly clock: Clock;
    readonly ids: IdGenerator;
    /** Owner time zone and day start (PlanningStore.getAvailability). */
    readonly availability: (ownerId: Id) => Promise<Availability>;
  }) {
    this.#db = options.db;
    this.#ids = options.ids;
    this.#availability = options.availability;
  }

  async getConnection(ownerId: Id): Promise<GoogleConnectionRecord | null> {
    const row = await this.#db
      .selectFrom('google_calendar_connection')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row === undefined ? null : mapConnection(row);
  }

  async saveGrant(
    ownerId: Id,
    grant: { readonly ciphertext: Buffer; readonly keyId: string; readonly scopes: readonly string[] },
    now: Instant,
  ): Promise<GoogleConnectionRecord> {
    const at = toDate(now);
    const row = await this.#db
      .insertInto('google_calendar_connection')
      .values({
        id: this.#ids.next(),
        owner_id: ownerId,
        status: 'connected',
        refresh_token_ciphertext: grant.ciphertext,
        token_key_id: grant.keyId,
        granted_scopes: [...grant.scopes],
        settings: jsonb(settingsJson(DEFAULT_GOOGLE_SETTINGS)),
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.column('owner_id').doUpdateSet({
          status: 'connected',
          refresh_token_ciphertext: grant.ciphertext,
          token_key_id: grant.keyId,
          granted_scopes: [...grant.scopes],
          last_error: null,
          updated_at: at,
          version: sql<number>`google_calendar_connection.version + 1`,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapConnection(row);
  }

  async markNeedsReauth(ownerId: Id, now: Instant): Promise<void> {
    await this.#db
      .updateTable('google_calendar_connection')
      .set({
        status: 'needs_reauth',
        last_error: 'auth_revoked',
        updated_at: toDate(now),
        version: sql<number>`version + 1`,
      })
      .where('owner_id', '=', ownerId)
      .where('status', '=', 'connected')
      .execute();
  }

  async recordSync(
    ownerId: Id,
    result: { readonly lastSyncAt?: Instant; readonly lastError: GoogleSyncErrorCode | null },
    now: Instant,
  ): Promise<void> {
    // Sync bookkeeping is a status field: it does not change the connection
    // version, so a settings PUT or disconnect is not refused (412) just
    // because a background sync ran (same rule as GET /today's volatile fields).
    await this.#db
      .updateTable('google_calendar_connection')
      .set({
        ...(result.lastSyncAt === undefined ? {} : { last_sync_at: toDate(result.lastSyncAt) }),
        last_error: result.lastError,
        updated_at: toDate(now),
      })
      .where('owner_id', '=', ownerId)
      .where('status', '=', 'connected')
      .execute();
  }

  async updateSettings(
    ownerId: Id,
    expectedVersion: number,
    input: { readonly selectedCalendarIds: readonly Id[]; readonly settings: GoogleIntegrationSettings },
    now: Instant,
  ): Promise<GoogleConnectionRecord> {
    return this.#db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('google_calendar_connection')
        .selectAll()
        .where('owner_id', '=', ownerId)
        .forUpdate()
        .executeTakeFirst();
      if (current === undefined) throw new NotFoundError('google connection');
      if (current.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      const known = await trx
        .selectFrom('google_calendar')
        .select('id')
        .where('owner_id', '=', ownerId)
        .execute();
      const knownIds = new Set(known.map((row) => row.id));
      const unknown = input.selectedCalendarIds.findIndex((id) => !knownIds.has(id));
      if (unknown >= 0) {
        throw new ValidationFailedError([
          { path: `/selectedCalendarIds/${String(unknown)}`, message: 'unknown calendar id' },
        ]);
      }
      const at = toDate(now);
      const selected = [...input.selectedCalendarIds];
      let deselect = trx
        .updateTable('google_calendar')
        .set({ selected: false, updated_at: at, version: sql<number>`version + 1` })
        .where('owner_id', '=', ownerId)
        .where('selected', '=', true);
      if (selected.length > 0) deselect = deselect.where('id', 'not in', selected);
      await deselect.execute();
      if (selected.length > 0) {
        await trx
          .updateTable('google_calendar')
          .set({ selected: true, updated_at: at, version: sql<number>`version + 1` })
          .where('owner_id', '=', ownerId)
          .where('selected', '=', false)
          .where('id', 'in', selected)
          .execute();
      }
      const row = await trx
        .updateTable('google_calendar_connection')
        .set({
          settings: jsonb(settingsJson(input.settings)),
          updated_at: at,
          version: expectedVersion + 1,
        })
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returningAll()
        .executeTakeFirstOrThrow();
      return mapConnection(row);
    });
  }

  async setExportCalendar(ownerId: Id, calendarId: string | null, now: Instant): Promise<void> {
    // One write: a calendars.insert result is never lost between two steps,
    // and no mapping of an older calendar survives the switch.
    await this.#db.transaction().execute(async (trx) => {
      await trx
        .updateTable('google_calendar_connection')
        .set({
          export_calendar_id: calendarId,
          updated_at: toDate(now),
          version: sql<number>`version + 1`,
        })
        .where('owner_id', '=', ownerId)
        .execute();
      await trx.deleteFrom('google_export_mapping').where('owner_id', '=', ownerId).execute();
    });
  }

  async disconnect(ownerId: Id, expectedVersion: number, now: Instant): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      const at = toDate(now);
      const updated = await trx
        .updateTable('google_calendar_connection')
        .set({
          status: 'disconnected',
          refresh_token_ciphertext: null,
          token_key_id: null,
          granted_scopes: [],
          export_calendar_id: null,
          last_error: null,
          updated_at: at,
          version: expectedVersion + 1,
        })
        .where('owner_id', '=', ownerId)
        .where('version', '=', expectedVersion)
        .returning('id')
        .executeTakeFirst();
      if (updated === undefined) {
        const current = await trx
          .selectFrom('google_calendar_connection')
          .select('version')
          .where('owner_id', '=', ownerId)
          .executeTakeFirst();
        if (current === undefined) throw new NotFoundError('google connection');
        throw new VersionConflictError(expectedVersion as never, current.version as never);
      }
      await trx.deleteFrom('google_calendar').where('owner_id', '=', ownerId).execute();
      await trx.deleteFrom('google_export_mapping').where('owner_id', '=', ownerId).execute();
      await this.#softDeleteImports(trx, ownerId, null, at);
    });
  }

  async listCalendars(ownerId: Id): Promise<readonly GoogleCalendarRecord[]> {
    const rows = await this.#db
      .selectFrom('google_calendar')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('is_primary', 'desc')
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      googleCalendarId: row.google_calendar_id,
      name: row.name,
      accessRole: (ACCESS_ROLES.has(row.access_role) ? row.access_role : 'reader') as GoogleCalendarAccessRole,
      primary: row.is_primary,
      selected: row.selected,
      timeZone: row.time_zone,
    }));
  }

  async replaceCalendarList(
    ownerId: Id,
    connectionId: Id,
    calendars: readonly ListedCalendar[],
    now: Instant,
  ): Promise<readonly GoogleCalendarRecord[]> {
    await this.#db.transaction().execute(async (trx) => {
      const at = toDate(now);
      const listedIds = calendars.map((calendar) => calendar.googleCalendarId);
      const existing = await trx
        .selectFrom('google_calendar')
        .select('google_calendar_id')
        .where('owner_id', '=', ownerId)
        .execute();
      const existingIds = new Set(existing.map((row) => row.google_calendar_id));
      const listed = new Set(listedIds);
      const membershipChanged =
        listedIds.some((id) => !existingIds.has(id)) || [...existingIds].some((id) => !listed.has(id));
      let removal = trx.deleteFrom('google_calendar').where('owner_id', '=', ownerId);
      if (listedIds.length > 0) removal = removal.where('google_calendar_id', 'not in', listedIds);
      await removal.execute();
      // A calendar added or removed changes what a full-replacement settings
      // PUT means, so it bumps the connection version (ETag); renames do not.
      if (membershipChanged) {
        await trx
          .updateTable('google_calendar_connection')
          .set({ updated_at: at, version: sql<number>`version + 1` })
          .where('owner_id', '=', ownerId)
          .where('id', '=', connectionId)
          .execute();
      }
      for (const calendar of calendars) {
        await trx
          .insertInto('google_calendar')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            connection_id: connectionId,
            google_calendar_id: calendar.googleCalendarId,
            name: calendar.name,
            access_role: calendar.accessRole,
            is_primary: calendar.primary,
            selected: calendar.defaultSelected,
            time_zone: calendar.timeZone,
            created_at: at,
            updated_at: at,
          })
          .onConflict((oc) =>
            oc
              .columns(['owner_id', 'google_calendar_id'])
              .doUpdateSet({
                name: calendar.name,
                access_role: calendar.accessRole,
                is_primary: calendar.primary,
                time_zone: calendar.timeZone,
                updated_at: at,
                version: sql<number>`google_calendar.version + 1`,
              })
              .where((eb) =>
                eb.or([
                  eb('google_calendar.name', '<>', calendar.name),
                  eb('google_calendar.access_role', '<>', calendar.accessRole),
                  eb('google_calendar.is_primary', '<>', calendar.primary),
                  eb('google_calendar.time_zone', 'is distinct from', calendar.timeZone),
                ]),
              ),
          )
          .execute();
      }
    });
    return this.listCalendars(ownerId);
  }

  async listConnectedOwnerIds(): Promise<readonly Id[]> {
    const rows = await this.#db
      .selectFrom('google_calendar_connection')
      .select('owner_id')
      .where('status', '=', 'connected')
      .orderBy('owner_id', 'asc')
      .execute();
    return rows.map((row) => row.owner_id as Id);
  }

  async listImportedCommitments(ownerId: Id, calendarId: string): Promise<readonly ImportedCommitmentRow[]> {
    const rows = await this.#db
      .selectFrom('commitment_event')
      .select(['id', 'external_calendar_id', 'external_event_id', 'title', 'start_at', 'end_at', 'time_zone', 'version'])
      .where('owner_id', '=', ownerId)
      .where('source', '=', 'google')
      .where('external_calendar_id', '=', calendarId)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      externalCalendarId: row.external_calendar_id ?? calendarId,
      externalEventId: row.external_event_id ?? '',
      title: row.title,
      startAt: toInstant(row.start_at),
      endAt: toInstant(row.end_at),
      timeZone: row.time_zone,
      version: row.version,
    }));
  }

  async applyCommitmentChanges(
    ownerId: Id,
    calendarId: string,
    changes: ImportChanges<ImportedCommitmentRow, ImportedCommitmentValues>,
    now: Instant,
  ): Promise<void> {
    if (changes.create.length + changes.update.length + changes.remove.length === 0) return;
    await this.#db.transaction().execute(async (trx) => {
      const at = toDate(now);
      for (const values of changes.create) {
        await trx
          .insertInto('commitment_event')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            title: values.title,
            start_at: toDate(values.startAt),
            end_at: toDate(values.endAt),
            rrule: null,
            time_zone: values.timeZone,
            source: 'google',
            external_calendar_id: calendarId,
            external_event_id: values.externalEventId,
            external_etag: values.etag,
            created_at: at,
            updated_at: at,
          })
          .execute();
      }
      for (const { row, values } of changes.update) {
        await trx
          .updateTable('commitment_event')
          .set({
            title: values.title,
            start_at: toDate(values.startAt),
            end_at: toDate(values.endAt),
            time_zone: values.timeZone,
            external_etag: values.etag,
            updated_at: at,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', row.id)
          .where('owner_id', '=', ownerId)
          .where('source', '=', 'google')
          .where('deleted_at', 'is', null)
          .execute();
      }
      if (changes.remove.length > 0) {
        await trx
          .updateTable('commitment_event')
          .set({ deleted_at: at, updated_at: at, version: sql<number>`version + 1` })
          .where('owner_id', '=', ownerId)
          .where('source', '=', 'google')
          .where('deleted_at', 'is', null)
          .where(
            'id',
            'in',
            changes.remove.map((row) => row.id),
          )
          .execute();
      }
      await bumpAvailabilityVersion(trx, ownerId, at);
    });
  }

  async removeImportsOutside(
    ownerId: Id,
    keepCalendarIds: readonly string[],
    now: Instant,
  ): Promise<{ readonly commitments: number; readonly dayEvents: number }> {
    return this.#db.transaction().execute(async (trx) =>
      this.#softDeleteImports(trx, ownerId, keepCalendarIds, toDate(now)),
    );
  }

  async removeAllImports(
    ownerId: Id,
    now: Instant,
  ): Promise<{ readonly commitments: number; readonly dayEvents: number }> {
    return this.#db.transaction().execute(async (trx) =>
      this.#softDeleteImports(trx, ownerId, null, toDate(now)),
    );
  }

  async listImportedDayEvents(ownerId: Id, calendarId: string): Promise<readonly ImportedDayEventRow[]> {
    const rows = await this.#db
      .selectFrom('calendar_day_event')
      .select(['id', 'external_calendar_id', 'external_event_id', 'title', 'start_date', 'end_date', 'version'])
      .where('owner_id', '=', ownerId)
      .where('external_calendar_id', '=', calendarId)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      externalCalendarId: row.external_calendar_id,
      externalEventId: row.external_event_id,
      title: row.title,
      startDate: toDateString(row.start_date),
      endDate: toDateString(row.end_date),
      version: row.version,
    }));
  }

  async applyDayEventChanges(
    ownerId: Id,
    calendarId: string,
    changes: ImportChanges<ImportedDayEventRow, ImportedDayEventValues>,
    now: Instant,
  ): Promise<void> {
    if (changes.create.length + changes.update.length + changes.remove.length === 0) return;
    await this.#db.transaction().execute(async (trx) => {
      const at = toDate(now);
      for (const values of changes.create) {
        await trx
          .insertInto('calendar_day_event')
          .values({
            id: this.#ids.next(),
            owner_id: ownerId,
            title: values.title,
            start_date: values.startDate,
            end_date: values.endDate,
            source: 'google',
            external_calendar_id: calendarId,
            external_event_id: values.externalEventId,
            external_etag: values.etag,
            created_at: at,
            updated_at: at,
          })
          .execute();
      }
      for (const { row, values } of changes.update) {
        await trx
          .updateTable('calendar_day_event')
          .set({
            title: values.title,
            start_date: values.startDate,
            end_date: values.endDate,
            external_etag: values.etag,
            updated_at: at,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', row.id)
          .where('owner_id', '=', ownerId)
          .where('deleted_at', 'is', null)
          .execute();
      }
      if (changes.remove.length > 0) {
        await trx
          .updateTable('calendar_day_event')
          .set({ deleted_at: at, updated_at: at, version: sql<number>`version + 1` })
          .where('owner_id', '=', ownerId)
          .where('deleted_at', 'is', null)
          .where(
            'id',
            'in',
            changes.remove.map((row) => row.id),
          )
          .execute();
      }
    });
  }

  async listDayEvents(ownerId: Id, from: string, to: string): Promise<readonly CalendarDayEvent[]> {
    const rows = await this.#db
      .selectFrom('calendar_day_event')
      .leftJoin('google_calendar', (join) =>
        join
          .onRef('google_calendar.owner_id', '=', 'calendar_day_event.owner_id')
          .onRef('google_calendar.google_calendar_id', '=', 'calendar_day_event.external_calendar_id'),
      )
      .select([
        'calendar_day_event.id',
        'calendar_day_event.title',
        'calendar_day_event.start_date',
        'calendar_day_event.end_date',
        'google_calendar.name as calendar_name',
      ])
      .where('calendar_day_event.owner_id', '=', ownerId)
      .where('calendar_day_event.deleted_at', 'is', null)
      // Inclusive `to`: overlaps [from, to + 1 day).
      .where('calendar_day_event.start_date', '<=', to)
      .where('calendar_day_event.end_date', '>', from)
      .orderBy('calendar_day_event.start_date', 'asc')
      .orderBy('calendar_day_event.id', 'asc')
      .limit(2_000)
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      title: row.title,
      startDate: toDateString(row.start_date),
      endDate: toDateString(row.end_date),
      source: 'google' as const,
      calendarName: row.calendar_name ?? null,
    }));
  }

  async ownerProfile(
    ownerId: Id,
  ): Promise<{ readonly timeZone: string; readonly locale: string; readonly dayStartLocal: string }> {
    const availability = await this.#availability(ownerId);
    const user = await this.#db
      .selectFrom('user')
      .select('locale')
      .where('id', '=', ownerId)
      .executeTakeFirst();
    return {
      timeZone: availability.timeZone,
      locale: user?.locale ?? 'ko-KR',
      dayStartLocal: availability.prefs.dayStartLocal,
    };
  }

  async loadExportSource(ownerId: Id, from: Instant, to: Instant): Promise<ExportSource> {
    const profile = await this.ownerProfile(ownerId);
    const blocks = await this.#db
      .selectFrom('schedule_block')
      .innerJoin('plan_version', 'plan_version.id', 'schedule_block.plan_version_id')
      .innerJoin('plan', 'plan.id', 'plan_version.plan_id')
      .leftJoin('task', (join) =>
        join
          .onRef('task.id', '=', 'schedule_block.task_id')
          .onRef('task.owner_id', '=', 'schedule_block.owner_id'),
      )
      .select([
        'schedule_block.id',
        'schedule_block.task_id',
        'schedule_block.start_at',
        'schedule_block.end_at',
        'schedule_block.status',
        'task.title_cache',
      ])
      .where('schedule_block.owner_id', '=', ownerId)
      .where('plan.owner_id', '=', ownerId)
      .where('schedule_block.status', 'in', ['planned', 'done'])
      .where('plan.deleted_at', 'is', null)
      .where('schedule_block.start_at', '<', toDate(to))
      .where('schedule_block.end_at', '>', toDate(from))
      .orderBy('schedule_block.start_at', 'asc')
      .orderBy('schedule_block.id', 'asc')
      .limit(2_000)
      .execute();
    const commitments = await this.#db
      .selectFrom('commitment_event')
      .select(['id', 'title', 'start_at', 'end_at', 'time_zone', 'rrule'])
      .where('owner_id', '=', ownerId)
      // Manual 약속 only: imported (google) and provider-synced (caldav,
      // vikunja) rows are not the user's own entries to push (ADR-024).
      .where('source', '=', 'manual')
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('rrule', 'is not', null),
          eb.and([eb('start_at', '<', toDate(to)), eb('end_at', '>', toDate(from))]),
        ]),
      )
      .orderBy('start_at', 'asc')
      .orderBy('id', 'asc')
      .limit(1_000)
      .execute();
    const cachedTaskTitles = new Map<string, string>();
    for (const block of blocks) {
      if (block.title_cache !== null && block.title_cache.length > 0) {
        cachedTaskTitles.set(block.task_id, block.title_cache);
      }
    }
    return {
      timeZone: profile.timeZone,
      dayStartLocal: profile.dayStartLocal,
      locale: profile.locale,
      blocks: blocks.map((block) => ({
        id: block.id as Id,
        taskId: block.task_id as Id,
        startAt: toInstant(block.start_at),
        endAt: toInstant(block.end_at),
        status: block.status,
      })),
      commitments: commitments.map((row) => ({
        id: row.id as Id,
        title: row.title,
        startAt: toInstant(row.start_at),
        endAt: toInstant(row.end_at),
        timeZone: row.time_zone,
        rrule: row.rrule,
      })),
      cachedTaskTitles,
    };
  }

  async listMappings(ownerId: Id): Promise<readonly ExportMappingRecord[]> {
    const rows = await this.#db
      .selectFrom('google_export_mapping')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('local_kind', 'asc')
      .orderBy('local_key', 'asc')
      .execute();
    return rows.map((row) => ({
      id: row.id as Id,
      kind: row.local_kind as ExportLocalKind,
      localKey: row.local_key,
      googleCalendarId: row.google_calendar_id,
      googleEventId: row.google_event_id,
      fingerprint: row.fingerprint,
      endsAt: row.ends_at === null ? null : toInstant(row.ends_at),
    }));
  }

  async upsertMapping(
    ownerId: Id,
    mapping: Omit<ExportMappingRecord, 'id'>,
    now: Instant,
  ): Promise<void> {
    const at = toDate(now);
    await this.#db
      .insertInto('google_export_mapping')
      .values({
        id: this.#ids.next(),
        owner_id: ownerId,
        local_kind: mapping.kind,
        local_key: mapping.localKey,
        google_calendar_id: mapping.googleCalendarId,
        google_event_id: mapping.googleEventId,
        fingerprint: mapping.fingerprint,
        ends_at: mapping.endsAt === null ? null : toDate(mapping.endsAt),
        created_at: at,
        updated_at: at,
      })
      .onConflict((oc) =>
        oc.columns(['owner_id', 'local_kind', 'local_key']).doUpdateSet({
          google_calendar_id: mapping.googleCalendarId,
          google_event_id: mapping.googleEventId,
          fingerprint: mapping.fingerprint,
          ends_at: mapping.endsAt === null ? null : toDate(mapping.endsAt),
          updated_at: at,
          version: sql<number>`google_export_mapping.version + 1`,
        }),
      )
      .execute();
  }

  async deleteMapping(ownerId: Id, kind: ExportLocalKind, localKey: string): Promise<void> {
    await this.#db
      .deleteFrom('google_export_mapping')
      .where('owner_id', '=', ownerId)
      .where('local_kind', '=', kind)
      .where('local_key', '=', localKey)
      .execute();
  }

  /**
   * Soft-delete imported rows of every calendar except `keep` (null = all).
   * Commitment removals bump availability_version once.
   */
  async #softDeleteImports(
    trx: Trx,
    ownerId: Id,
    keep: readonly string[] | null,
    at: Date,
  ): Promise<{ readonly commitments: number; readonly dayEvents: number }> {
    let commitments = trx
      .updateTable('commitment_event')
      .set({ deleted_at: at, updated_at: at, version: sql<number>`version + 1` })
      .where('owner_id', '=', ownerId)
      .where('source', '=', 'google')
      .where('deleted_at', 'is', null);
    if (keep !== null && keep.length > 0) {
      commitments = commitments.where('external_calendar_id', 'not in', [...keep]);
    }
    const removedCommitments = await commitments.returning('id').execute();
    let dayEvents = trx
      .updateTable('calendar_day_event')
      .set({ deleted_at: at, updated_at: at, version: sql<number>`version + 1` })
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null);
    if (keep !== null && keep.length > 0) {
      dayEvents = dayEvents.where('external_calendar_id', 'not in', [...keep]);
    }
    const removedDayEvents = await dayEvents.returning('id').execute();
    if (removedCommitments.length > 0) await bumpAvailabilityVersion(trx, ownerId, at);
    return { commitments: removedCommitments.length, dayEvents: removedDayEvents.length };
  }
}
