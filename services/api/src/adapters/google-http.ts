import { setTimeout as delay } from 'node:timers/promises';
import {
  GoogleApiError,
  type CallOptions,
  type GoogleApiErrorKind,
  type GoogleCalendarListEntry,
  type GoogleCalendarPort,
  type GoogleEventResource,
  type GoogleEventWrite,
  type GoogleOAuthPort,
  type GooglePage,
  type GoogleTokenResponse,
} from '../application/google-calendar-ports.js';

/**
 * CAL-03 outbound HTTP to Google (ADR-024, 09 §5): only
 * `oauth2.googleapis.com` (token, revoke) and `www.googleapis.com`
 * (Calendar API v3). The consent page on `accounts.google.com` is opened by
 * the browser, never fetched here. Base URLs are constructor options so tests
 * point the adapter at a local fake server; they are not env-configurable.
 *
 * Every call has a per-attempt timeout and bounded retries with exponential
 * backoff + jitter on 429, 5xx, 403 `rateLimitExceeded`/`userRateLimitExceeded`
 * and network failures (Retry-After honoured up to the cap), except
 * `calendars.insert`, which is attempted once (not idempotent). Error messages
 * carry the operation, kind, status and Google's `reason` token only.
 */
export const GOOGLE_OAUTH_BASE_URL = 'https://oauth2.googleapis.com';
export const GOOGLE_CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';

export interface GoogleHttpOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly oauthBaseUrl?: string;
  readonly calendarBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** Only events fields the import maps (no description, location or attendee identities). */
const EVENT_FIELDS =
  'nextPageToken,items(id,etag,status,summary,start,end,transparency,eventType,attendees(self,responseStatus))';
const CALENDAR_LIST_FIELDS =
  'nextPageToken,items(id,summary,summaryOverride,accessRole,primary,timeZone)';

interface RequestSpec {
  readonly operation: string;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  /** False for non-idempotent creates whose duplicate would not be detected. */
  readonly retryOnNetwork?: boolean;
  /**
   * True for a create that must never be repeated: no retry at all, not even
   * on 429/5xx (a 5xx or a lost answer can follow a create that happened).
   */
  readonly singleAttempt?: boolean;
}

interface RawResponse {
  readonly status: number;
  readonly json: unknown;
}

function reasonOf(json: unknown): string | undefined {
  if (json === null || typeof json !== 'object') return undefined;
  const error = (json as Record<string, unknown>)['error'];
  // OAuth endpoint: {"error":"invalid_grant","error_description":"…"}.
  if (typeof error === 'string') return /^[A-Za-z_]{1,64}$/u.test(error) ? error : undefined;
  if (error === null || typeof error !== 'object') return undefined;
  const errors = (error as Record<string, unknown>)['errors'];
  if (Array.isArray(errors)) {
    const first = errors[0] as Record<string, unknown> | undefined;
    const reason = first?.['reason'];
    if (typeof reason === 'string' && /^[A-Za-z_]{1,64}$/u.test(reason)) return reason;
  }
  const status = (error as Record<string, unknown>)['status'];
  return typeof status === 'string' && /^[A-Z_]{1,64}$/u.test(status) ? status : undefined;
}

function classify(status: number, reason: string | undefined, isOAuth: boolean): GoogleApiErrorKind {
  if (isOAuth && (reason === 'invalid_grant' || reason === 'invalid_token')) return 'auth_revoked';
  if (status === 401) return 'unauthorized';
  if (status === 429 || (status === 403 && reason !== undefined && RATE_LIMIT_REASONS.has(reason))) {
    return 'rate_limited';
  }
  if (status >= 500) return 'unavailable';
  if (status === 404) return 'not_found';
  if (status === 410) return 'gone';
  if (status === 409 && reason === 'duplicate') return 'duplicate';
  return 'rejected';
}

function retryable(kind: GoogleApiErrorKind): boolean {
  return kind === 'rate_limited' || kind === 'unavailable';
}

function retryAfterMs(header: string | null, capMs: number): number | null {
  if (header === null) return null;
  const seconds = Number.parseInt(header, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1_000, capMs);
}

export class GoogleHttpClient implements GoogleOAuthPort, GoogleCalendarPort {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #oauthBaseUrl: string;
  readonly #calendarBaseUrl: string;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #baseBackoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  constructor(options: GoogleHttpOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#oauthBaseUrl = (options.oauthBaseUrl ?? GOOGLE_OAUTH_BASE_URL).replace(/\/+$/u, '');
    this.#calendarBaseUrl = (options.calendarBaseUrl ?? GOOGLE_CALENDAR_BASE_URL).replace(/\/+$/u, '');
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#baseBackoffMs = options.baseBackoffMs ?? 500;
    this.#maxBackoffMs = options.maxBackoffMs ?? 8_000;
    this.#sleep =
      options.sleep ??
      (async (ms, signal) => {
        await delay(ms, undefined, signal === undefined ? {} : { signal });
      });
    this.#random = options.random ?? Math.random;
  }

  // ---- OAuth -------------------------------------------------------------

  async exchangeCode(
    input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
    options?: CallOptions,
  ): Promise<GoogleTokenResponse> {
    const json = await this.#form(
      'token exchange',
      `${this.#oauthBaseUrl}/token`,
      {
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
      },
      options,
    );
    return this.#tokenResponse('token exchange', json);
  }

  async refresh(refreshToken: string, options?: CallOptions): Promise<GoogleTokenResponse> {
    const json = await this.#form(
      'token refresh',
      `${this.#oauthBaseUrl}/token`,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
      },
      options,
    );
    return this.#tokenResponse('token refresh', json);
  }

  /** RFC 7009: the token travels in the form body, never in the URL. */
  async revoke(token: string, options?: CallOptions): Promise<void> {
    await this.#form('token revoke', `${this.#oauthBaseUrl}/revoke`, { token }, options);
  }

  // ---- Calendar API ------------------------------------------------------

  async listCalendars(
    accessToken: string,
    pageToken: string | undefined,
    options?: CallOptions,
  ): Promise<GooglePage<GoogleCalendarListEntry>> {
    const params = new URLSearchParams({ maxResults: '250', fields: CALENDAR_LIST_FIELDS });
    if (pageToken !== undefined) params.set('pageToken', pageToken);
    const json = await this.#api(
      accessToken,
      {
        operation: 'calendarList.list',
        method: 'GET',
        url: `${this.#calendarBaseUrl}/users/me/calendarList?${params.toString()}`,
      },
      options,
    );
    return pageOf<GoogleCalendarListEntry>(json, 'calendarList.list');
  }

  async listEvents(
    accessToken: string,
    calendarId: string,
    query: { readonly timeMin: string; readonly timeMax: string; readonly pageToken?: string | undefined },
    options?: CallOptions,
  ): Promise<GooglePage<GoogleEventResource>> {
    const params = new URLSearchParams({
      singleEvents: 'true',
      timeMin: query.timeMin,
      timeMax: query.timeMax,
      maxResults: '250',
      fields: EVENT_FIELDS,
    });
    if (query.pageToken !== undefined) params.set('pageToken', query.pageToken);
    const json = await this.#api(
      accessToken,
      {
        operation: 'events.list',
        method: 'GET',
        url: `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      },
      options,
    );
    return pageOf<GoogleEventResource>(json, 'events.list');
  }

  async insertCalendar(
    accessToken: string,
    body: { readonly summary: string; readonly timeZone: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    const json = await this.#api(
      accessToken,
      {
        operation: 'calendars.insert',
        method: 'POST',
        url: `${this.#calendarBaseUrl}/calendars`,
        body: JSON.stringify(body),
        // Not idempotent: a retry after a lost response or a 5xx that came
        // after the create would make a second "OhMyDate" calendar. One
        // attempt; the next sync run tries again.
        singleAttempt: true,
      },
      options,
    );
    return { id: idOf(json, 'calendars.insert') };
  }

  async deleteCalendar(accessToken: string, calendarId: string, options?: CallOptions): Promise<void> {
    await this.#api(
      accessToken,
      {
        operation: 'calendars.delete',
        method: 'DELETE',
        url: `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}`,
      },
      options,
    );
  }

  async insertEvent(
    accessToken: string,
    calendarId: string,
    body: GoogleEventWrite & { readonly id?: string },
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    const json = await this.#api(
      accessToken,
      {
        operation: 'events.insert',
        method: 'POST',
        url: `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events?fields=id`,
        body: JSON.stringify(body),
        // Deterministic ids turn a duplicate insert into a 409; without one a
        // retry could duplicate the event.
        retryOnNetwork: body.id !== undefined,
      },
      options,
    );
    return { id: idOf(json, 'events.insert') };
  }

  async patchEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    body: GoogleEventWrite,
    options?: CallOptions,
  ): Promise<{ readonly id: string }> {
    const json = await this.#api(
      accessToken,
      {
        operation: 'events.patch',
        method: 'PATCH',
        url: `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?fields=id`,
        body: JSON.stringify(body),
      },
      options,
    );
    return { id: idOf(json, 'events.patch') };
  }

  async deleteEvent(
    accessToken: string,
    calendarId: string,
    eventId: string,
    options?: CallOptions,
  ): Promise<void> {
    await this.#api(
      accessToken,
      {
        operation: 'events.delete',
        method: 'DELETE',
        url: `${this.#calendarBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      },
      options,
    );
  }

  // ---- transport ---------------------------------------------------------

  #tokenResponse(operation: string, json: unknown): GoogleTokenResponse {
    const record = (json ?? {}) as Record<string, unknown>;
    const accessToken = record['access_token'];
    const expiresIn = record['expires_in'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new GoogleApiError(operation, 'rejected', 200, 'malformed_token_response');
    }
    const refreshToken = record['refresh_token'];
    const scope = record['scope'];
    return {
      accessToken,
      expiresInSec:
        typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3_600,
      refreshToken: typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : null,
      scopes:
        typeof scope === 'string'
          ? scope.split(/\s+/u).filter((entry) => entry.length > 0)
          : null,
    };
  }

  #form(
    operation: string,
    url: string,
    fields: Record<string, string>,
    options?: CallOptions,
  ): Promise<unknown> {
    return this.#send(
      {
        operation,
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      },
      true,
      options,
    );
  }

  #api(accessToken: string, spec: RequestSpec, options?: CallOptions): Promise<unknown> {
    return this.#send(
      {
        ...spec,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(spec.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      },
      false,
      options,
    );
  }

  async #send(spec: RequestSpec, isOAuth: boolean, options?: CallOptions): Promise<unknown> {
    const signal = options?.signal;
    const aborted = (): GoogleApiError => new GoogleApiError(spec.operation, 'aborted', 0);
    let failure = new GoogleApiError(spec.operation, 'unavailable', 0);
    const maxAttempts = spec.singleAttempt === true ? 1 : this.#maxAttempts;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (isAborted(signal)) throw aborted();
      let waitMs: number | null = null;
      let response: (RawResponse & { readonly retryAfterMs: number | null }) | undefined;
      try {
        response = await this.#attempt(spec, signal);
      } catch {
        // Network failure or per-attempt timeout (no body, no token in the error).
        if (isAborted(signal)) throw aborted();
        failure = new GoogleApiError(spec.operation, 'unavailable', 0, 'network');
        if (spec.retryOnNetwork === false || spec.singleAttempt === true) throw failure;
      }
      if (response !== undefined) {
        if (response.status >= 200 && response.status < 300) return response.json;
        const reason = reasonOf(response.json);
        failure = new GoogleApiError(
          spec.operation,
          classify(response.status, reason, isOAuth),
          response.status,
          reason,
        );
        if (!retryable(failure.kind)) throw failure;
        waitMs = response.retryAfterMs;
      }
      if (attempt === maxAttempts) break;
      const backoff = Math.min(
        this.#maxBackoffMs,
        this.#baseBackoffMs * 2 ** (attempt - 1) * (1 + this.#random()),
      );
      try {
        await this.#sleep(waitMs ?? backoff, signal);
      } catch {
        throw aborted();
      }
    }
    throw failure;
  }

  async #attempt(
    spec: RequestSpec,
    signal: AbortSignal | undefined,
  ): Promise<RawResponse & { readonly retryAfterMs: number | null }> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await this.#fetch(spec.url, {
      method: spec.method,
      headers: { accept: 'application/json', ...spec.headers },
      ...(spec.body === undefined ? {} : { body: spec.body }),
      signal: combined,
      redirect: 'error',
    });
    const text = await response.text();
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      json,
      retryAfterMs: retryAfterMs(response.headers.get('retry-after'), this.#maxBackoffMs),
    };
  }
}

/** A function so TypeScript does not narrow `aborted` across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function pageOf<T>(json: unknown, operation: string): GooglePage<T> {
  if (json === null || typeof json !== 'object') {
    throw new GoogleApiError(operation, 'rejected', 200, 'malformed_response');
  }
  const record = json as Record<string, unknown>;
  // An absent list is an empty page (Google omits empty fields); anything
  // else that is not an array is a malformed answer, never "no items".
  const raw = record['items'];
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new GoogleApiError(operation, 'rejected', 200, 'malformed_response');
  }
  const items = raw === undefined ? [] : (raw as T[]);
  const next = record['nextPageToken'];
  return { items, ...(typeof next === 'string' && next.length > 0 ? { nextPageToken: next } : {}) };
}

function idOf(json: unknown, operation: string): string {
  const id = (json as Record<string, unknown> | null)?.['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new GoogleApiError(operation, 'rejected', 200, 'malformed_response');
  }
  return id;
}
