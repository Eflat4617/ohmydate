import type {
  CalendarDayEventPage,
  GoogleCallbackResult,
  GoogleConnectResponse,
  GoogleIntegration,
  GoogleIntegrationSettings,
  GoogleIntegrationSettingsPut,
  GoogleSyncResult,
} from '@ohmydate/contracts';
import { CALENDAR_DAY_EVENT_MAX_RANGE_DAYS, GOOGLE_SETTINGS_WEB_PATH } from '@ohmydate/contracts';
import { ValidationFailedError, type Id } from '@ohmydate/domain';
import { DailyProblemError } from './daily-errors.js';

/**
 * CAL-03 use-case surface the HTTP layer binds to (08 §2.11). Every method is
 * owner-scoped; the callback receives the owner of the presented session (or
 * null) and resolves to the fixed redirect result, never throwing.
 */
export interface GoogleIntegrationService {
  status(ownerId: Id): Promise<GoogleIntegration>;
  connect(ownerId: Id): Promise<GoogleConnectResponse>;
  handleCallback(input: GoogleCallbackInput): Promise<GoogleCallbackResult>;
  updateSettings(
    ownerId: Id,
    input: GoogleIntegrationSettingsPut,
    expectedVersion: number,
  ): Promise<GoogleIntegration>;
  syncNow(ownerId: Id): Promise<GoogleSyncResult>;
  disconnect(ownerId: Id, expectedVersion: number, removeExported: boolean): Promise<void>;
  listDayEvents(ownerId: Id, from: string, to: string): Promise<CalendarDayEventPage>;
  /** Absolute (configured web origin) or root-relative fixed redirect target. */
  redirectLocation(result: GoogleCallbackResult): string;
  /** Debounced best-effort export after a mutation; never throws. */
  nudgeExport(ownerId: Id): void;
}

export interface GoogleCallbackInput {
  /** Owner of the session cookie presented with the redirect, or null. */
  readonly sessionOwnerId: Id | null;
  readonly code: string | undefined;
  readonly state: string | undefined;
  readonly error: string | undefined;
}

export const DEFAULT_GOOGLE_SETTINGS: GoogleIntegrationSettings = {
  exportBlocks: true,
  exportCommitments: true,
  dailySummary: true,
  reminderMinutes: 10,
};

/** 409 `illegal_transition`, stored for the Idempotency-Key like other domain 409s. */
export function googleStateConflict(detail: string): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'illegal_transition',
    title: 'State conflict',
    detail,
  });
}

export function fixedRedirectLocation(
  webOrigin: string | null,
  result: GoogleCallbackResult,
): string {
  return `${webOrigin ?? ''}${GOOGLE_SETTINGS_WEB_PATH}?google=${result}`;
}

const DAY_MS = 86_400_000;

/** Inclusive `from`..`to` (YYYY-MM-DD), from <= to, at most 92 days apart. */
export function validateDayEventRange(from: string, to: string): void {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new ValidationFailedError([{ path: '/from', message: 'invalid date' }]);
  }
  if (toMs < fromMs) {
    throw new ValidationFailedError([{ path: '/to', message: 'to must not be before from' }]);
  }
  if ((toMs - fromMs) / DAY_MS > CALENDAR_DAY_EVENT_MAX_RANGE_DAYS) {
    throw new ValidationFailedError([
      { path: '/to', message: `range exceeds ${CALENDAR_DAY_EVENT_MAX_RANGE_DAYS} days` },
    ]);
  }
}

const NOT_CONFIGURED_DETAIL =
  'Google Calendar sync is not configured on this server (GOOGLE_OAUTH_CLIENT_FILE / GOOGLE_TOKEN_KEY_FILE)';

/**
 * The server has no OAuth client or token key: a normal state. Status reads
 * work, every action is a 409 and the callback always ends in `error`.
 */
export class NotConfiguredGoogleIntegration implements GoogleIntegrationService {
  readonly #listDayEvents: (ownerId: Id, from: string, to: string) => Promise<CalendarDayEventPage>;

  constructor(
    listDayEvents: (ownerId: Id, from: string, to: string) => Promise<CalendarDayEventPage> = async () => ({
      items: [],
    }),
  ) {
    this.#listDayEvents = listDayEvents;
  }

  async status(): Promise<GoogleIntegration> {
    return {
      status: 'not_configured',
      importAvailable: false,
      exportAvailable: false,
      calendars: [],
      exportCalendarName: null,
      settings: DEFAULT_GOOGLE_SETTINGS,
      lastSyncAt: null,
      lastError: null,
      version: 1,
    };
  }

  async connect(): Promise<GoogleConnectResponse> {
    throw googleStateConflict(NOT_CONFIGURED_DETAIL);
  }

  async handleCallback(): Promise<GoogleCallbackResult> {
    return 'error';
  }

  async updateSettings(): Promise<GoogleIntegration> {
    throw googleStateConflict(NOT_CONFIGURED_DETAIL);
  }

  async syncNow(): Promise<GoogleSyncResult> {
    throw googleStateConflict(NOT_CONFIGURED_DETAIL);
  }

  async disconnect(): Promise<void> {
    throw googleStateConflict(NOT_CONFIGURED_DETAIL);
  }

  async listDayEvents(ownerId: Id, from: string, to: string): Promise<CalendarDayEventPage> {
    validateDayEventRange(from, to);
    return this.#listDayEvents(ownerId, from, to);
  }

  redirectLocation(result: GoogleCallbackResult): string {
    return fixedRedirectLocation(null, result);
  }

  nudgeExport(): void {
    // Nothing to export without a configured integration.
  }
}
