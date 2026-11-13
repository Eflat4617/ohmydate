import { randomBytes } from 'node:crypto';
import { atRestKey } from '../../src/application/at-rest-crypto.js';
import {
  GOOGLE_SCOPES,
  GoogleApiError,
  type CallOptions,
  type GoogleCalendarListEntry,
  type GoogleCalendarPort,
  type GoogleEventResource,
  type GoogleEventWrite,
  type GoogleOAuthPort,
  type GooglePage,
  type GoogleTokenResponse,
} from '../../src/application/google-calendar-ports.js';
import type { GoogleOAuthSecrets } from '../../src/google-config.js';
import type { Scheduler } from '../../src/application/google-calendar-service.js';

/**
 * CAL-03 test double for Google's OAuth and Calendar endpoints. No test ever
 * talks to Google; tokens here are synthetic strings.
 */
export const TEST_REDIRECT_URI = 'http://127.0.0.1:5180/api/v1/integrations/google/callback';
export const TEST_WEB_ORIGIN = 'http://127.0.0.1:5180';

export function testGoogleSecrets(): GoogleOAuthSecrets {
  return {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret-value',
    tokenKey: atRestKey(randomBytes(32)),
    redirectUri: TEST_REDIRECT_URI,
    webOrigin: TEST_WEB_ORIGIN,
  };
}

export interface StoredExportEvent {
  body: GoogleEventWrite;
  status: 'confirmed' | 'cancelled';
}

export interface FakeCall {
  readonly op: string;
  readonly args: Record<string, unknown>;
}

export class FakeGoogle implements GoogleOAuthPort, GoogleCalendarPort {
  readonly calls: FakeCall[] = [];
  /** Granted scopes returned by the code exchange. */
  grantedScopes: readonly string[] | null = [...GOOGLE_SCOPES];
  refreshFails: 'invalid_grant' | 'unavailable' | 'rate_limited' | null = null;
  /** The next N calendars.insert calls fail with 503 (nothing is created). */
  insertCalendarFailures = 0;
  exchangeFails = false;
  omitRefreshToken = false;
  readonly refreshToken = `1//refresh-${randomBytes(12).toString('hex')}`;
  accessTokenCounter = 0;
  readonly revoked: string[] = [];
  calendars: GoogleCalendarListEntry[] = [
    { id: 'primary@example.test', summary: 'me@example.test', accessRole: 'owner', primary: true, timeZone: 'Asia/Seoul' },
  ];
  readonly events = new Map<string, GoogleEventResource[]>();
  /** Events per page for events.list (paging tests). */
  eventPageSize = 250;
  /** calendarId -> failure kind for events.list. */
  readonly failingCalendars = new Map<string, 'rate_limited' | 'unavailable' | 'rejected'>();
  /** App-created calendars and their events (the "OhMyDate" export target). */
  readonly ownCalendars = new Map<string, Map<string, StoredExportEvent>>();
  readonly deletedCalendars: string[] = [];
  /** Event ids whose next patch answers 404 / 410. */
  readonly patchGone = new Map<string, 'not_found' | 'gone'>();
  rejectRecurrence = false;
  #calendarCounter = 0;

  #record(op: string, args: Record<string, unknown> = {}): void {
    this.calls.push({ op, args });
  }

  callCount(op: string): number {
    return this.calls.filter((call) => call.op === op).length;
  }

  #checkAbort(options?: CallOptions, op = 'call'): void {
    if (options?.signal?.aborted === true) throw new GoogleApiError(op, 'aborted', 0);
  }

  // ---- OAuth -------------------------------------------------------------

  async exchangeCode(
    input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
    options?: CallOptions,
  ): Promise<GoogleTokenResponse> {
    this.#checkAbort(options, 'token exchange');
    this.#record('exchangeCode', { ...input });
    if (this.exchangeFails) throw new GoogleApiError('token exchange', 'auth_revoked', 400, 'invalid_grant');
    this.accessTokenCounter += 1;
    return {
      accessToken: `ya29.access-${String(this.accessTokenCounter)}`,
      expiresInSec: 3_599,
      refreshToken: this.omitRefreshToken ? null : this.refreshToken,
      scopes: this.grantedScopes,
    };
  }

  async refresh(refreshToken: string, options?: CallOptions): Promise<GoogleTokenResponse> {
    this.#checkAbort(options, 'token refresh');
    this.#record('refresh', { matches: refreshToken === this.refreshToken });
    if (this.refreshFails === 'invalid_grant') {
      throw new GoogleApiError('token refresh', 'auth_revoked', 400, 'invalid_grant');
    }
    if (this.refreshFails === 'unavailable') throw new GoogleApiError('token refresh', 'unavailable', 503);
    if (this.refreshFails === 'rate_limited') throw new GoogleApiError('token refresh', 'rate_limited', 429);
    if (refreshToken !== this.refreshToken) {
      throw new GoogleApiError('token refresh', 'auth_revoked', 400, 'invalid_grant');
    }
    this.accessTokenCounter += 1;
    return {
      accessToken: `ya29.access-${String(this.accessTokenCounter)}`,
      expiresInSec: 3_599,
      refreshToken: null,
      scopes: null,
    };
  }

  async revoke(token: string): Promise<void> {
    this.#record('revoke');
    this.revoked.push(token);
  }

  // ---- Calendar ----------------------------------------------------------

  async listCalendars(
    _accessToken: string,
    pageToken: string | undefined,
    options?: CallOptions,
  ): Promise<GooglePage<GoogleCalendarListEntry>> {
    this.#checkAbort(options, 'calendarList.list');
    this.#record('listCalendars', { pageToken });
    const own = [...this.ownCalendars.keys()].map((id) => ({
      id,
      summary: 'OhMyDate',
      accessRole: 'owner',
      primary: false,
    }));
    return { items: [...this.calendars, ...own] };
  }

  async listEvents(
    _accessToken: string,
    calendarId: string,
    query: { readonly timeMin: string; readonly timeMax: string; readonly pageToken?: string | undefined },
    options?: CallOptions,
  ): Promise<GooglePage<GoogleEventResource>> {
    this.#checkAbort(options, 'events.list');
    this.#record('listEvents', { calendarId, ...query });
    const failure = this.failingCalendars.get(calendarId);
    if (failure !== undefined) {
      throw new GoogleApiError('events.list', failure, failure === 'rate_limited' ? 429 : failure === 'unavailable' ? 503 : 400);
    }
    const all = this.events.get(calendarId) ?? [];
    const offset = query.pageToken === undefined ? 0 : Number.parseInt(query.pageToken, 10);
    const items = all.slice(offset, offset + this.eventPageSize);
    const next = offset + this.eventPageSize < all.length ? String(offset + this.eventPageSize) : undefined;
    return { items, ...(next === undefined ? {} : { nextPageToken: next }) };
  }

  async insertCalendar(
    _accessToken: string,
    body: { readonly summary: string; readonly timeZone: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    this.#checkAbort(options, 'calendars.insert');
    if (this.insertCalendarFailures > 0) {
      this.insertCalendarFailures -= 1;
      this.#record('insertCalendar', { ...body, failed: true });
      throw new GoogleApiError('calendars.insert', 'unavailable', 503);
    }
    this.#calendarCounter += 1;
    const id = `ohmydate-${String(this.#calendarCounter)}@group.calendar.google.com`;
    this.#record('insertCalendar', { ...body, id });
    this.ownCalendars.set(id, new Map());
    return { id };
  }

  async deleteCalendar(_accessToken: string, calendarId: string): Promise<void> {
    this.#record('deleteCalendar', { calendarId });
    if (!this.ownCalendars.delete(calendarId)) throw new GoogleApiError('calendars.delete', 'not_found', 404);
    this.deletedCalendars.push(calendarId);
  }

  async insertEvent(
    _accessToken: string,
    calendarId: string,
    body: GoogleEventWrite & { readonly id?: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    this.#checkAbort(options, 'events.insert');
    const events = this.ownCalendars.get(calendarId);
    this.#record('insertEvent', { calendarId, id: body.id, summary: body.summary });
    if (events === undefined) throw new GoogleApiError('events.insert', 'not_found', 404);
    if (this.rejectRecurrence && body.recurrence !== undefined) {
      throw new GoogleApiError('events.insert', 'rejected', 400, 'invalid');
    }
    const id = body.id ?? `srv${randomBytes(8).toString('hex')}`;
    if (events.has(id)) throw new GoogleApiError('events.insert', 'duplicate', 409, 'duplicate');
    const rest: GoogleEventWrite & { id?: string } = { ...body };
    delete rest.id;
    events.set(id, { body: rest, status: 'confirmed' });
    return { id };
  }

  async patchEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    body: GoogleEventWrite,
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    this.#checkAbort(options, 'events.patch');
    this.#record('patchEvent', { calendarId, eventId, summary: body.summary });
    const gone = this.patchGone.get(eventId);
    if (gone !== undefined) {
      this.patchGone.delete(eventId);
      this.ownCalendars.get(calendarId)?.delete(eventId);
      throw new GoogleApiError('events.patch', gone, gone === 'gone' ? 410 : 404);
    }
    const events = this.ownCalendars.get(calendarId);
    const existing = events?.get(eventId);
    if (events === undefined || existing === undefined) throw new GoogleApiError('events.patch', 'not_found', 404);
    events.set(eventId, { body, status: body.status ?? existing.status });
    return { id: eventId };
  }

  async deleteEvent(
    _accessToken: string,
    calendarId: string,
    eventId: string,
    options?: CallOptions,
  ): Promise<void> {
    this.#checkAbort(options, 'events.delete');
    this.#record('deleteEvent', { calendarId, eventId });
    const events = this.ownCalendars.get(calendarId);
    const existing = events?.get(eventId);
    if (existing === undefined || existing.status === 'cancelled') {
      throw new GoogleApiError('events.delete', 'gone', 410, 'deleted');
    }
    // Google keeps a deleted event's id as a cancelled tombstone.
    existing.status = 'cancelled';
  }

  /** Live events of the single app-created calendar. */
  exported(): Map<string, StoredExportEvent> {
    const result = new Map<string, StoredExportEvent>();
    for (const events of this.ownCalendars.values()) {
      for (const [id, event] of events) if (event.status === 'confirmed') result.set(id, event);
    }
    return result;
  }
}

/** Manual scheduler: nudges run only when a test calls `flush()`. */
export class ManualScheduler {
  readonly #tasks = new Map<number, () => void>();
  #next = 0;
  readonly scheduler: Scheduler = (callback) => {
    const id = this.#next;
    this.#next += 1;
    this.#tasks.set(id, callback);
    return { cancel: () => this.#tasks.delete(id) };
  };

  get pending(): number {
    return this.#tasks.size;
  }

  flush(): void {
    const tasks = [...this.#tasks.values()];
    this.#tasks.clear();
    for (const task of tasks) task();
  }
}

export function timedEvent(
  id: string,
  start: string,
  end: string,
  extra: Partial<GoogleEventResource> = {},
): GoogleEventResource {
  return {
    id,
    etag: `"${id}-1"`,
    status: 'confirmed',
    summary: `event ${id}`,
    start: { dateTime: start, timeZone: 'Asia/Seoul' },
    end: { dateTime: end, timeZone: 'Asia/Seoul' },
    ...extra,
  };
}

export function allDayEvent(
  id: string,
  startDate: string,
  endDate: string,
  extra: Partial<GoogleEventResource> = {},
): GoogleEventResource {
  return {
    id,
    etag: `"${id}-1"`,
    status: 'confirmed',
    summary: `day ${id}`,
    start: { date: startDate },
    end: { date: endDate },
    ...extra,
  };
}
