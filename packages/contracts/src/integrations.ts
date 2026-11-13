import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { IdSchema, InstantSchema, VersionSchema } from './common.js';

/**
 * Google Calendar integration (CAL-03, ADR-024, 08 §2.11).
 *
 * The OAuth callback (`GET /integrations/google/callback`) is a browser
 * redirect, not a JSON operation: it is registered by the API next to the
 * contract routes and documented in 08 §2.11, but it is deliberately not part
 * of `contractRoutes` (no JSON body, no Problem responses, no header matrix).
 */
export const GOOGLE_OAUTH_CALLBACK_PATH = '/integrations/google/callback' as const;

/** Fixed web path the callback redirects to (`?google=<result>`). */
export const GOOGLE_SETTINGS_WEB_PATH = '/settings/calendar' as const;

export const GOOGLE_CALLBACK_RESULTS = ['connected', 'denied', 'error'] as const;

export type GoogleCallbackResult = (typeof GOOGLE_CALLBACK_RESULTS)[number];

/**
 * - `not_configured`: this server has no OAuth client file or token key
 *   (normal state; every action route answers 409 `illegal_transition`).
 * - `disconnected`: configured, no stored grant.
 * - `connected`: a refresh token is stored; sync runs.
 * - `needs_reauth`: Google answered `invalid_grant`; sync is stopped and
 *   nothing was deleted. Connect again (or disconnect).
 */
export const GOOGLE_INTEGRATION_STATUSES = [
  'not_configured',
  'disconnected',
  'connected',
  'needs_reauth',
] as const;

export type GoogleIntegrationStatusName = (typeof GOOGLE_INTEGRATION_STATUSES)[number];

export const GoogleIntegrationStatusSchema = Type.Union(
  GOOGLE_INTEGRATION_STATUSES.map((status) => Type.Literal(status)) as TLiteral<GoogleIntegrationStatusName>[],
);

/**
 * Closed set of sync failure codes recorded on the connection (`lastError`).
 * Never a Google message, an event title or a token.
 */
export const GOOGLE_SYNC_ERROR_CODES = [
  'auth_revoked',
  'rate_limited',
  'google_unavailable',
  'google_rejected',
  'too_many_events',
  'run_deadline',
  'internal_error',
] as const;

export type GoogleSyncErrorCode = (typeof GOOGLE_SYNC_ERROR_CODES)[number];

export const GoogleSyncErrorCodeSchema = Type.Union(
  GOOGLE_SYNC_ERROR_CODES.map((code) => Type.Literal(code)) as TLiteral<GoogleSyncErrorCode>[],
);

/** CalendarListEntry.accessRole values (Calendar API v3). */
export const GOOGLE_CALENDAR_ACCESS_ROLES = [
  'freeBusyReader',
  'reader',
  'writerWithoutPrivateAccess',
  'writer',
  'owner',
] as const;

export type GoogleCalendarAccessRole = (typeof GOOGLE_CALENDAR_ACCESS_ROLES)[number];

export const GoogleCalendarAccessRoleSchema = Type.Union(
  GOOGLE_CALENDAR_ACCESS_ROLES.map((role) => Type.Literal(role)) as TLiteral<GoogleCalendarAccessRole>[],
);

/** Reminder lead of exported events; `null` = no popup. Google allows 0..40320. */
export const GOOGLE_REMINDER_MAX_MINUTES = 40_320;

export const GoogleReminderMinutesSchema = Type.Union([
  Type.Integer({ minimum: 0, maximum: GOOGLE_REMINDER_MAX_MINUTES }),
  Type.Null(),
]);

export const GoogleIntegrationSettingsSchema = Type.Object(
  {
    /** Approved schedule blocks -> the "OhMyDate" calendar. */
    exportBlocks: Type.Boolean(),
    /** Manual 약속 (repeating ones as recurring events). Imported ones never. */
    exportCommitments: Type.Boolean(),
    /** One "오늘 할 일 N개" event per day that has blocks. */
    dailySummary: Type.Boolean(),
    reminderMinutes: GoogleReminderMinutesSchema,
  },
  { additionalProperties: false, $id: 'GoogleIntegrationSettings' },
);

export const GoogleCalendarEntrySchema = Type.Object(
  {
    /** OhMyDate id of the listed calendar (stable across re-listing). */
    id: IdSchema,
    name: Type.String({ maxLength: 200 }),
    primary: Type.Boolean(),
    accessRole: GoogleCalendarAccessRoleSchema,
    /** Imported when true. */
    selected: Type.Boolean(),
  },
  { additionalProperties: false, $id: 'GoogleCalendarEntry' },
);

export const GoogleIntegrationSchema = Type.Object(
  {
    status: GoogleIntegrationStatusSchema,
    /** Both read scopes were granted (and status is connected). */
    importAvailable: Type.Boolean(),
    /** `calendar.app.created` was granted (and status is connected). */
    exportAvailable: Type.Boolean(),
    /** The owner's calendars as last listed; the export calendar is never listed. */
    calendars: Type.Array(GoogleCalendarEntrySchema, { maxItems: 250 }),
    /** "OhMyDate" once the export calendar exists, else null. */
    exportCalendarName: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    settings: GoogleIntegrationSettingsSchema,
    lastSyncAt: Type.Union([InstantSchema, Type.Null()]),
    lastError: Type.Union([GoogleSyncErrorCodeSchema, Type.Null()]),
    version: VersionSchema,
  },
  { additionalProperties: false, $id: 'GoogleIntegration' },
);

export const GoogleConnectResponseSchema = Type.Object(
  {
    /** accounts.google.com consent URL; the browser navigates to it (top level). */
    authorizationUrl: Type.String({ format: 'uri', maxLength: 4_096 }),
  },
  { additionalProperties: false, $id: 'GoogleConnectResponse' },
);

/** Full replacement of the import selection and the export settings. */
export const GoogleIntegrationSettingsPutSchema = Type.Object(
  {
    /** Ids from `GoogleIntegration.calendars[]`; unknown ids are 422. */
    selectedCalendarIds: Type.Array(IdSchema, { maxItems: 250, uniqueItems: true }),
    settings: GoogleIntegrationSettingsSchema,
  },
  { additionalProperties: false, $id: 'GoogleIntegrationSettingsPut' },
);

const CountSchema = Type.Integer({ minimum: 0 });

export const GoogleSyncResultSchema = Type.Object(
  {
    imported: Type.Object(
      {
        /** Timed events -> 약속 rows created / changed / soft-deleted. */
        created: CountSchema,
        updated: CountSchema,
        removed: CountSchema,
        /** All-day day-event rows created, changed or removed. */
        dayEvents: CountSchema,
      },
      { additionalProperties: false },
    ),
    exported: Type.Object(
      {
        /** Events inserted into / patched in / deleted from the "OhMyDate" calendar. */
        created: CountSchema,
        updated: CountSchema,
        removed: CountSchema,
      },
      { additionalProperties: false },
    ),
    lastSyncAt: InstantSchema,
  },
  { additionalProperties: false, $id: 'GoogleSyncResult' },
);

export const GoogleDisconnectQuerySchema = Type.Object(
  {
    /** Delete the "OhMyDate" calendar at Google too (default true, best effort). */
    removeExported: Type.Optional(Type.Union([Type.Literal('true'), Type.Literal('false')])),
  },
  { additionalProperties: false, $id: 'GoogleDisconnectQuery' },
);

/** Inclusive `from`, inclusive `to`, at most 92 days apart (owner's dates). */
export const CALENDAR_DAY_EVENT_MAX_RANGE_DAYS = 92;

export const CalendarDayEventListQuerySchema = Type.Object(
  {
    from: Type.String({ format: 'date' }),
    to: Type.String({ format: 'date' }),
  },
  { additionalProperties: false, $id: 'CalendarDayEventListQuery' },
);

export const CALENDAR_DAY_EVENT_SOURCES = ['google'] as const;

export const CalendarDayEventSchema = Type.Object(
  {
    id: IdSchema,
    title: Type.String({ minLength: 1, maxLength: 200 }),
    startDate: Type.String({ format: 'date' }),
    /** Exclusive, like Google's all-day `end.date`. */
    endDate: Type.String({ format: 'date' }),
    source: Type.Literal('google'),
    /** Source calendar name as last listed; null when it is no longer listed. */
    calendarName: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  },
  { additionalProperties: false, $id: 'CalendarDayEvent' },
);

export const CalendarDayEventPageSchema = Type.Object(
  {
    items: Type.Array(CalendarDayEventSchema, { maxItems: 2_000 }),
  },
  { additionalProperties: false, $id: 'CalendarDayEventPage' },
);

export type GoogleIntegrationSettings = Static<typeof GoogleIntegrationSettingsSchema>;
export type GoogleCalendarEntry = Static<typeof GoogleCalendarEntrySchema>;
export type GoogleIntegration = Static<typeof GoogleIntegrationSchema>;
export type GoogleConnectResponse = Static<typeof GoogleConnectResponseSchema>;
export type GoogleIntegrationSettingsPut = Static<typeof GoogleIntegrationSettingsPutSchema>;
export type GoogleSyncResult = Static<typeof GoogleSyncResultSchema>;
export type GoogleDisconnectQuery = Static<typeof GoogleDisconnectQuerySchema>;
export type CalendarDayEventListQuery = Static<typeof CalendarDayEventListQuerySchema>;
export type CalendarDayEvent = Static<typeof CalendarDayEventSchema>;
export type CalendarDayEventPage = Static<typeof CalendarDayEventPageSchema>;
