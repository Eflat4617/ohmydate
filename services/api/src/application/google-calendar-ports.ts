import type {
  CalendarDayEvent,
  GoogleCalendarAccessRole,
  GoogleIntegrationSettings,
  GoogleSyncErrorCode,
} from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';

/** Least-privilege scopes (ADR-024). */
export const GOOGLE_SCOPE_APP_CREATED = 'https://www.googleapis.com/auth/calendar.app.created';
export const GOOGLE_SCOPE_CALENDARLIST_READONLY =
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
export const GOOGLE_SCOPE_EVENTS_READONLY = 'https://www.googleapis.com/auth/calendar.events.readonly';
export const GOOGLE_SCOPES = [
  GOOGLE_SCOPE_APP_CREATED,
  GOOGLE_SCOPE_CALENDARLIST_READONLY,
  GOOGLE_SCOPE_EVENTS_READONLY,
] as const;

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/**
 * Classified Google failure. `message` never carries a token, a response body,
 * a Google error message or an event title — only the operation, kind, HTTP
 * status and Google's closed `reason` token.
 */
export type GoogleApiErrorKind =
  | 'auth_revoked'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'not_found'
  | 'gone'
  | 'duplicate'
  | 'rejected'
  | 'aborted';

export class GoogleApiError extends Error {
  readonly kind: GoogleApiErrorKind;
  readonly status: number;
  readonly reason: string | undefined;

  constructor(operation: string, kind: GoogleApiErrorKind, status: number, reason?: string) {
    super(`google ${operation} failed: ${kind} (${String(status)}${reason === undefined ? '' : ` ${reason}`})`);
    this.name = 'GoogleApiError';
    this.kind = kind;
    this.status = status;
    this.reason = reason;
  }
}

export function syncErrorCodeOf(error: unknown): GoogleSyncErrorCode {
  if (error instanceof GoogleApiError) {
    switch (error.kind) {
      case 'auth_revoked':
        return 'auth_revoked';
      case 'rate_limited':
        return 'rate_limited';
      case 'unavailable':
      case 'aborted':
        return 'google_unavailable';
      default:
        return 'google_rejected';
    }
  }
  return 'internal_error';
}

export interface CallOptions {
  readonly signal?: AbortSignal;
}

export interface GoogleTokenResponse {
  readonly accessToken: string;
  readonly expiresInSec: number;
  /** Present on the code exchange with access_type=offline. */
  readonly refreshToken: string | null;
  /** Granted scopes (granular consent); null when Google omitted the field. */
  readonly scopes: readonly string[] | null;
}

export interface GoogleOAuthPort {
  exchangeCode(
    input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
    options?: CallOptions,
  ): Promise<GoogleTokenResponse>;
  refresh(refreshToken: string, options?: CallOptions): Promise<GoogleTokenResponse>;
  revoke(token: string, options?: CallOptions): Promise<void>;
}

export interface GoogleCalendarListEntry {
  readonly id: string;
  readonly summary?: string | undefined;
  readonly summaryOverride?: string | undefined;
  readonly accessRole?: string | undefined;
  readonly primary?: boolean | undefined;
  readonly timeZone?: string | undefined;
}

export interface GoogleEventTime {
  readonly date?: string | undefined;
  readonly dateTime?: string | undefined;
  readonly timeZone?: string | undefined;
}

/** The subset of an Event resource that is read (fields= mask). */
export interface GoogleEventResource {
  readonly id: string;
  readonly etag?: string | undefined;
  readonly status?: string | undefined;
  readonly summary?: string | undefined;
  readonly start?: GoogleEventTime | undefined;
  readonly end?: GoogleEventTime | undefined;
  readonly transparency?: string | undefined;
  readonly eventType?: string | undefined;
  readonly attendees?:
    | readonly { readonly self?: boolean | undefined; readonly responseStatus?: string | undefined }[]
    | undefined;
}

export interface GooglePage<T> {
  readonly items: readonly T[];
  readonly nextPageToken?: string | undefined;
}

/** Body of an exported event (OhMyDate -> "OhMyDate" calendar). */
export interface GoogleEventWrite {
  readonly summary: string;
  readonly description?: string;
  readonly start: { readonly dateTime: string; readonly timeZone: string };
  readonly end: { readonly dateTime: string; readonly timeZone: string };
  readonly recurrence?: readonly string[];
  readonly reminders: {
    readonly useDefault: false;
    readonly overrides: readonly { readonly method: 'popup'; readonly minutes: number }[];
  };
  /** Blocks and 약속 are busy; the daily summary is not. */
  readonly transparency: 'opaque' | 'transparent';
  readonly status?: 'confirmed';
}

export interface GoogleCalendarPort {
  listCalendars(
    accessToken: string,
    pageToken: string | undefined,
    options?: CallOptions,
  ): Promise<GooglePage<GoogleCalendarListEntry>>;
  listEvents(
    accessToken: string,
    calendarId: string,
    query: { readonly timeMin: string; readonly timeMax: string; readonly pageToken?: string | undefined },
    options?: CallOptions,
  ): Promise<GooglePage<GoogleEventResource>>;
  insertCalendar(
    accessToken: string,
    body: { readonly summary: string; readonly timeZone: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }>;
  deleteCalendar(accessToken: string, calendarId: string, options?: CallOptions): Promise<void>;
  insertEvent(
    accessToken: string,
    calendarId: string,
    body: GoogleEventWrite & { readonly id?: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }>;
  patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    body: GoogleEventWrite,
    options?: CallOptions,
  ): Promise<{ readonly id: string }>;
  deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    options?: CallOptions,
  ): Promise<void>;
}

export type GoogleConnectionStatus = 'connected' | 'needs_reauth' | 'disconnected';

export interface GoogleConnectionRecord {
  readonly id: Id;
  readonly ownerId: Id;
  readonly status: GoogleConnectionStatus;
  readonly refreshTokenCiphertext: Buffer | null;
  readonly tokenKeyId: string | null;
  readonly grantedScopes: readonly string[];
  readonly exportCalendarId: string | null;
  readonly settings: GoogleIntegrationSettings;
  readonly lastSyncAt: Instant | null;
  readonly lastError: GoogleSyncErrorCode | null;
  readonly version: number;
}

export interface GoogleCalendarRecord {
  readonly id: Id;
  readonly googleCalendarId: string;
  readonly name: string;
  readonly accessRole: GoogleCalendarAccessRole;
  readonly primary: boolean;
  readonly selected: boolean;
  readonly timeZone: string | null;
}

export interface ListedCalendar {
  readonly googleCalendarId: string;
  readonly name: string;
  readonly accessRole: GoogleCalendarAccessRole;
  readonly primary: boolean;
  readonly timeZone: string | null;
  /** Used only when the calendar is new to this owner. */
  readonly defaultSelected: boolean;
}

/** An imported timed event as stored in commitment_event (source google). */
export interface ImportedCommitmentRow {
  readonly id: Id;
  readonly externalCalendarId: string;
  readonly externalEventId: string;
  readonly title: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly timeZone: string;
  readonly version: number;
}

export interface ImportedCommitmentValues {
  readonly externalEventId: string;
  readonly etag: string | null;
  readonly title: string;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly timeZone: string;
}

export interface ImportedDayEventRow {
  readonly id: Id;
  readonly externalCalendarId: string;
  readonly externalEventId: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly version: number;
}

export interface ImportedDayEventValues {
  readonly externalEventId: string;
  readonly etag: string | null;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface ImportChanges<Row, Values> {
  readonly create: readonly Values[];
  readonly update: readonly { readonly row: Row; readonly values: Values }[];
  readonly remove: readonly Row[];
}

export type ExportLocalKind = 'block' | 'commitment' | 'summary';

export interface ExportMappingRecord {
  readonly id: Id;
  readonly kind: ExportLocalKind;
  readonly localKey: string;
  readonly googleCalendarId: string;
  readonly googleEventId: string;
  readonly fingerprint: string;
  readonly endsAt: Instant | null;
}

/** What the export reads from OhMyDate (owner-scoped, windowed). */
export interface ExportSource {
  readonly timeZone: string;
  readonly dayStartLocal: string;
  readonly locale: string;
  readonly blocks: readonly {
    readonly id: Id;
    readonly taskId: Id;
    readonly startAt: Instant;
    readonly endAt: Instant;
    readonly status: string;
  }[];
  /** Live, non-google commitments overlapping the window or repeating. */
  readonly commitments: readonly {
    readonly id: Id;
    readonly title: string;
    readonly startAt: Instant;
    readonly endAt: Instant;
    readonly timeZone: string;
    readonly rrule: string | null;
  }[];
  /** Planner title cache for block tasks (fallback when the provider is down). */
  readonly cachedTaskTitles: ReadonlyMap<string, string>;
}

export interface GoogleCalendarStore {
  getConnection(ownerId: Id): Promise<GoogleConnectionRecord | null>;
  /** Insert or re-activate the owner's connection with a new grant (version +1). */
  saveGrant(
    ownerId: Id,
    grant: {
      readonly ciphertext: Buffer;
      readonly keyId: string;
      readonly scopes: readonly string[];
    },
    now: Instant,
  ): Promise<GoogleConnectionRecord>;
  /** invalid_grant: stop syncing, keep every row (version +1). */
  markNeedsReauth(ownerId: Id, now: Instant): Promise<void>;
  /** Status bookkeeping only: never changes the connection version. */
  recordSync(
    ownerId: Id,
    result: { readonly lastSyncAt?: Instant; readonly lastError: GoogleSyncErrorCode | null },
    now: Instant,
  ): Promise<void>;
  updateSettings(
    ownerId: Id,
    expectedVersion: number,
    input: { readonly selectedCalendarIds: readonly Id[]; readonly settings: GoogleIntegrationSettings },
    now: Instant,
  ): Promise<GoogleConnectionRecord>;
  setExportCalendar(ownerId: Id, calendarId: string | null, now: Instant): Promise<void>;
  /**
   * Disconnect in one transaction: token, scopes, export calendar id and the
   * calendar list are cleared, imported 약속 (availability_version +1 when
   * any) and day events are soft-deleted and export mappings dropped.
   * Settings stay. Version-checked (412 on mismatch).
   */
  disconnect(ownerId: Id, expectedVersion: number, now: Instant): Promise<void>;
  listCalendars(ownerId: Id): Promise<readonly GoogleCalendarRecord[]>;
  /** Upsert the listed calendars; unlisted ones are deleted. */
  replaceCalendarList(
    ownerId: Id,
    connectionId: Id,
    calendars: readonly ListedCalendar[],
    now: Instant,
  ): Promise<readonly GoogleCalendarRecord[]>;
  listConnectedOwnerIds(): Promise<readonly Id[]>;

  listImportedCommitments(ownerId: Id, calendarId: string): Promise<readonly ImportedCommitmentRow[]>;
  /** One transaction; availability_version +1 once when anything changed. */
  applyCommitmentChanges(
    ownerId: Id,
    calendarId: string,
    changes: ImportChanges<ImportedCommitmentRow, ImportedCommitmentValues>,
    now: Instant,
  ): Promise<void>;
  /** Imported 약속 of calendars that are no longer selected/listed are soft-deleted. */
  removeImportsOutside(ownerId: Id, keepCalendarIds: readonly string[], now: Instant): Promise<{
    readonly commitments: number;
    readonly dayEvents: number;
  }>;
  listImportedDayEvents(ownerId: Id, calendarId: string): Promise<readonly ImportedDayEventRow[]>;
  applyDayEventChanges(
    ownerId: Id,
    calendarId: string,
    changes: ImportChanges<ImportedDayEventRow, ImportedDayEventValues>,
    now: Instant,
  ): Promise<void>;
  listDayEvents(ownerId: Id, from: string, to: string): Promise<readonly CalendarDayEvent[]>;

  /** Owner zone/day start (availability) and locale (user). */
  ownerProfile(
    ownerId: Id,
  ): Promise<{ readonly timeZone: string; readonly locale: string; readonly dayStartLocal: string }>;
  loadExportSource(ownerId: Id, from: Instant, to: Instant): Promise<ExportSource>;
  listMappings(ownerId: Id): Promise<readonly ExportMappingRecord[]>;
  upsertMapping(
    ownerId: Id,
    mapping: Omit<ExportMappingRecord, 'id'>,
    now: Instant,
  ): Promise<void>;
  deleteMapping(ownerId: Id, kind: ExportLocalKind, localKey: string): Promise<void>;
  deleteAllMappings(ownerId: Id): Promise<void>;
}
