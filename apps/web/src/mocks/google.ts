import { HttpResponse, http } from 'msw';
import type { CalendarDayEvent, Commitment, GoogleIntegration, GoogleIntegrationSettingsPut } from '../api/client';
import { MONTH_COMMITMENT_DENTIST_ID, type MockDb } from './db';
import {
  etag,
  json,
  parseBody,
  parseIdempotency,
  parseIfMatch,
  problem,
  remember,
  rememberDomainResult,
} from './handlers';

/**
 * CAL-04: the Google Calendar routes of the CAL-03 contract (08 §2.11), as a
 * small in-memory state machine. Nothing here talks to Google:
 *
 *   not_configured ──(server set up)──▶ disconnected ──connect──▶ connected
 *        connected ──grant revoked──▶ needs_reauth ──connect──▶ connected
 *        connected | needs_reauth ──DELETE──▶ disconnected
 *
 * `:connect` answers with this app's own `/settings/calendar?google=connected`
 * (the stand-in for Google's consent screen); the page that loads there is
 * seeded `connected` by src/mocks/browser.ts. The screenshot sweep picks a
 * starting status through `window.__OHMYDATE_MOCK__.google`.
 */

export type MockGoogleScenario = 'not_configured' | 'disconnected' | 'connected' | 'needs_reauth' | 'partial';

export const GOOGLE_CALENDAR_PRIMARY_ID = '01900000-0000-7000-8000-0000000005a1';
export const GOOGLE_CALENDAR_HOLIDAYS_ID = '01900000-0000-7000-8000-0000000005a2';
export const GOOGLE_CALENDAR_FAMILY_ID = '01900000-0000-7000-8000-0000000005a3';
export const GOOGLE_CALENDAR_CLUB_ID = '01900000-0000-7000-8000-0000000005a4';
export const GOOGLE_COMMITMENT_CLUB_ID = '01900000-0000-7000-8000-0000000005c1';
export const GOOGLE_COMMITMENT_CHECKUP_ID = '01900000-0000-7000-8000-0000000005c2';
/** The 15:00 dentist visit of the seeded month, imported from the phone. */
export const GOOGLE_COMMITMENT_DENTIST_ID = MONTH_COMMITMENT_DENTIST_ID;

const SEEDED_AT = '2026-11-02T00:00:00.000Z';

/** A Seoul wall-clock time (UTC+9, no DST) as an instant. */
function seoulInstant(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function googleCommitment(db: MockDb, id: string, title: string, date: string, start: string, end: string): Commitment {
  return {
    id,
    ownerId: db.user.id,
    title,
    startAt: seoulInstant(date, start),
    endAt: seoulInstant(date, end),
    timeZone: 'Asia/Seoul',
    source: 'google',
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
}

function dayEvent(id: string, title: string, startDate: string, endDate: string, calendarName: string): CalendarDayEvent {
  return { id, title, startDate, endDate, source: 'google', calendarName };
}

/** What a connection imported: three timed 약속 and a few all-day labels (a family trip over three days, a holiday). */
function seedImports(db: MockDb): void {
  const dentist = db.commitments.get(GOOGLE_COMMITMENT_DENTIST_ID);
  db.commitments.set(
    GOOGLE_COMMITMENT_DENTIST_ID,
    dentist === undefined
      ? googleCommitment(db, GOOGLE_COMMITMENT_DENTIST_ID, '치과 예약', '2026-11-14', '15:00', '15:40')
      : { ...dentist, source: 'google' },
  );
  for (const item of [
    googleCommitment(db, GOOGLE_COMMITMENT_CLUB_ID, '동아리 회의', '2026-11-18', '17:00', '18:00'),
    googleCommitment(db, GOOGLE_COMMITMENT_CHECKUP_ID, '건강검진', '2026-11-26', '09:00', '10:00'),
  ]) {
    db.commitments.set(item.id, item);
  }
  db.availabilityVersion += 1;
  db.google.dayEvents = [
    dayEvent('01900000-0000-7000-8000-0000000005e1', '엄마 생신', '2026-11-22', '2026-11-23', '가족'),
    dayEvent('01900000-0000-7000-8000-0000000005e2', '가족 여행', '2026-11-27', '2026-11-30', '가족'),
    dayEvent('01900000-0000-7000-8000-0000000005e3', '크리스마스', '2026-12-25', '2026-12-26', '대한민국의 휴일'),
  ];
}

function listedCalendars(): GoogleIntegration['calendars'] {
  return [
    { id: GOOGLE_CALENDAR_PRIMARY_ID, name: '내 캘린더', primary: true, accessRole: 'owner', selected: true },
    { id: GOOGLE_CALENDAR_HOLIDAYS_ID, name: '대한민국의 휴일', primary: false, accessRole: 'reader', selected: true },
    { id: GOOGLE_CALENDAR_FAMILY_ID, name: '가족', primary: false, accessRole: 'writer', selected: true },
    { id: GOOGLE_CALENDAR_CLUB_ID, name: '동아리 공유', primary: false, accessRole: 'reader', selected: false },
  ];
}

/** Move the mock connection to `scenario` (and seed what such a connection imported). */
export function seedGoogle(db: MockDb, scenario: MockGoogleScenario): void {
  const base = db.google.integration;
  if (scenario === 'not_configured') {
    db.google.integration = { ...base, status: 'not_configured', importAvailable: false, exportAvailable: false, calendars: [] };
    return;
  }
  if (scenario === 'disconnected') {
    db.google.integration = {
      ...base,
      status: 'disconnected',
      importAvailable: false,
      exportAvailable: false,
      calendars: [],
      exportCalendarName: null,
      lastSyncAt: null,
      lastError: null,
      version: base.version + 1,
    };
    return;
  }
  seedImports(db);
  if (scenario === 'needs_reauth') {
    db.google.integration = {
      ...base,
      status: 'needs_reauth',
      importAvailable: false,
      exportAvailable: false,
      calendars: listedCalendars(),
      exportCalendarName: 'OhMyDate',
      lastSyncAt: '2026-11-13T23:10:00.000Z',
      lastError: 'auth_revoked',
      version: base.version + 3,
    };
    return;
  }
  db.google.integration = {
    ...base,
    status: 'connected',
    importAvailable: true,
    exportAvailable: scenario !== 'partial',
    calendars: listedCalendars(),
    exportCalendarName: scenario === 'partial' ? null : 'OhMyDate',
    lastSyncAt: '2026-11-14T09:36:00.000Z',
    lastError: scenario === 'partial' ? 'rate_limited' : null,
    version: base.version + 2,
  };
}

const ACTION_STATES = {
  connect: ['disconnected', 'connected', 'needs_reauth'],
  settings: ['connected', 'needs_reauth'],
  sync: ['connected'],
  disconnect: ['connected', 'needs_reauth'],
} as const satisfies Record<string, readonly GoogleIntegration['status'][]>;

function allowed(db: MockDb, action: keyof typeof ACTION_STATES): boolean {
  return (ACTION_STATES[action] as readonly string[]).includes(db.google.integration.status);
}

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 92;

function dayNumber(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
}

function validSettingsBody(body: GoogleIntegrationSettingsPut | undefined, known: ReadonlySet<string>): string | null {
  if (body === undefined || typeof body !== 'object') return 'Invalid settings body';
  if (!Array.isArray(body.selectedCalendarIds)) return 'selectedCalendarIds must be an array';
  if (new Set(body.selectedCalendarIds).size !== body.selectedCalendarIds.length) return 'selectedCalendarIds must be unique';
  if (body.selectedCalendarIds.some((id) => typeof id !== 'string' || !known.has(id))) return 'unknown calendar id';
  const settings = body.settings as Partial<GoogleIntegrationSettingsPut['settings']> | undefined;
  if (
    settings === undefined ||
    typeof settings.exportBlocks !== 'boolean' ||
    typeof settings.exportCommitments !== 'boolean' ||
    typeof settings.dailySummary !== 'boolean' ||
    !(settings.reminderMinutes === null || (Number.isInteger(settings.reminderMinutes) && (settings.reminderMinutes ?? -1) >= 0))
  ) {
    return 'Invalid settings';
  }
  return null;
}

export function createGoogleHandlers(db: MockDb) {
  return [
    http.get('*/api/v1/integrations/google', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const current = etag(db.google.integration.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(db.google.integration, 200, { ETag: current });
    }),

    http.post(/\/api\/v1\/integrations\/google:connect$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      if (!allowed(db, 'connect')) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Google is not configured on this server');
      }
      const body = { authorizationUrl: new URL('/settings/calendar?google=connected', request.url).href };
      remember(db, token, 200, body);
      return json(body, 200);
    }),

    http.put('*/api/v1/integrations/google/settings', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (!allowed(db, 'settings')) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Not allowed in this state');
      }
      const current = db.google.integration;
      if (ifMatch.version !== current.version) {
        return problem(412, 'version_conflict', `Server version is ${current.version}; the request used ${ifMatch.version}`);
      }
      const body = parseBody<GoogleIntegrationSettingsPut>(raw);
      const failure = validSettingsBody(body, new Set(current.calendars.map((calendar) => calendar.id)));
      if (failure !== null || body === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', failure ?? 'Invalid settings body');
      }
      const selected = new Set(body.selectedCalendarIds);
      const updated: GoogleIntegration = {
        ...current,
        calendars: current.calendars.map((calendar) => ({ ...calendar, selected: selected.has(calendar.id) })),
        settings: { ...body.settings },
        version: current.version + 1,
      };
      db.google.integration = updated;
      const headers = { ETag: etag(updated.version) };
      remember(db, token, 200, updated, headers);
      return json(updated, 200, headers);
    }),

    http.post(/\/api\/v1\/integrations\/google:sync$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      if (!allowed(db, 'sync')) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Not allowed in this state');
      }
      if (db.google.syncFailure === 'provider_unavailable') {
        db.google.integration = { ...db.google.integration, lastError: 'google_unavailable' };
        return problem(503, 'provider_unavailable', 'Google did not answer');
      }
      if (db.google.syncFailure === 'auth_revoked') {
        db.google.integration = {
          ...db.google.integration,
          status: 'needs_reauth',
          importAvailable: false,
          exportAvailable: false,
          lastError: 'auth_revoked',
          version: db.google.integration.version + 1,
        };
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'The grant was revoked');
      }
      const lastSyncAt = new Date().toISOString();
      db.google.integration = { ...db.google.integration, lastSyncAt, lastError: null };
      const result = {
        imported: { created: 1, updated: 2, removed: 0, dayEvents: 1 },
        exported: { created: 3, updated: 1, removed: 0 },
        lastSyncAt,
      };
      remember(db, token, 200, result);
      return json(result, 200);
    }),

    http.delete('*/api/v1/integrations/google', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      if (!allowed(db, 'disconnect')) {
        return rememberDomainResult(db, token, 409, 'illegal_transition', 'Not allowed in this state');
      }
      const current = db.google.integration;
      if (ifMatch.version !== current.version) {
        return problem(412, 'version_conflict', `Server version is ${current.version}; the request used ${ifMatch.version}`);
      }
      const flag = new URL(request.url).searchParams.get('removeExported');
      if (flag !== null && flag !== 'true' && flag !== 'false') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'removeExported must be true or false');
      }
      db.google.lastRemoveExported = flag !== 'false';
      for (const [id, commitment] of db.commitments) {
        if (commitment.source === 'google') db.commitments.delete(id);
      }
      db.availabilityVersion += 1;
      db.google.dayEvents = [];
      db.google.integration = {
        ...current,
        status: 'disconnected',
        importAvailable: false,
        exportAvailable: false,
        calendars: [],
        exportCalendarName: null,
        lastSyncAt: null,
        lastError: null,
        version: current.version + 1,
      };
      remember(db, token, 204, null);
      return new HttpResponse(null, { status: 204 });
    }),

    http.get('*/api/v1/calendar-day-events', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!CIVIL_DATE.test(from) || !CIVIL_DATE.test(to) || to < from) {
        return problem(422, 'validation_failed', 'from and to must be dates, from <= to');
      }
      if (dayNumber(to) - dayNumber(from) > MAX_RANGE_DAYS) {
        return problem(422, 'validation_failed', 'range must be at most 92 days');
      }
      const items = db.google.dayEvents
        .filter((event) => event.startDate <= to && event.endDate > from)
        .sort((left, right) => left.startDate.localeCompare(right.startDate));
      return json({ items }, 200);
    }),
  ];
}
