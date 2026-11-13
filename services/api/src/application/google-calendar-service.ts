import { createHash, randomBytes } from 'node:crypto';
import type {
  CalendarDayEventPage,
  GoogleCallbackResult,
  GoogleConnectResponse,
  GoogleIntegration,
  GoogleIntegrationSettingsPut,
  GoogleSyncErrorCode,
  GoogleSyncResult,
} from '@ohmydate/contracts';
import { GOOGLE_CALENDAR_ACCESS_ROLES } from '@ohmydate/contracts';
import {
  ProviderUnavailableError,
  VersionConflictError,
  type Clock,
  type Id,
  type Instant,
  type TaskRepository,
} from '@ohmydate/domain';
import { decryptAtRest, encryptAtRest, type AtRestKey } from './at-rest-crypto.js';
import { desiredEvents, type DesiredEvent } from './google-export.js';
import {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_SCOPE_APP_CREATED,
  GOOGLE_SCOPE_CALENDARLIST_READONLY,
  GOOGLE_SCOPE_EVENTS_READONLY,
  GoogleApiError,
  syncErrorCodeOf,
  type ExportMappingRecord,
  type GoogleCalendarListEntry,
  type GoogleCalendarPort,
  type GoogleCalendarStore,
  type GoogleConnectionRecord,
  type GoogleEventResource,
  type GoogleEventWrite,
  type GoogleOAuthPort,
  type ImportedCommitmentValues,
  type ImportedDayEventValues,
  type ListedCalendar,
} from './google-calendar-ports.js';
import {
  EXPORT_CALENDAR_NAME,
  classifyEvent,
  cutTitle,
  defaultSelected,
  diffCommitments,
  diffDayEvents,
  importWindow,
  removalWindow,
} from './google-import.js';
import {
  DEFAULT_GOOGLE_SETTINGS,
  fixedRedirectLocation,
  googleStateConflict,
  validateDayEventRange,
  type GoogleCallbackInput,
  type GoogleIntegrationService,
} from './google-integration.js';

const DAY_MS = 86_400_000;
/** OAuth state lifetime (CAL-03 A). */
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING_STATES = 64;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
export const DEFAULT_GOOGLE_RUN_BOUND_MS = 120_000;
export const DEFAULT_GOOGLE_NUDGE_DELAY_MS = 3_000;
const DEFAULT_MAX_EVENT_PAGES = 10;
const MAX_CALENDAR_PAGES = 4;
const DEFAULT_MAX_EXPORT_WRITES = 300;
const MAX_TITLE_LOOKUPS = 200;
const DISCONNECT_GOOGLE_BOUND_MS = 15_000;

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly webOrigin: string;
  readonly tokenKey: AtRestKey;
}

export interface GoogleServiceLogger {
  warn(message: string, details?: Readonly<Record<string, unknown>>): void;
}

export type Scheduler = (callback: () => void, delayMs: number) => { cancel(): void };

const defaultScheduler: Scheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs);
  handle.unref?.();
  return { cancel: () => clearTimeout(handle) };
};

export interface GoogleCalendarServiceOptions {
  readonly oauthConfig: GoogleOAuthConfig;
  readonly oauth: GoogleOAuthPort;
  readonly calendar: GoogleCalendarPort;
  readonly store: GoogleCalendarStore;
  /** Provider task titles for exported blocks (planner title cache as fallback). */
  readonly tasks: Pick<TaskRepository, 'get'>;
  readonly clock: Clock;
  readonly importDays: number;
  readonly exportDays: number;
  readonly runBoundMs?: number;
  readonly nudgeDelayMs?: number;
  readonly maxEventPages?: number;
  readonly maxExportWrites?: number;
  /** Application shutdown: aborts every Google call in flight. */
  readonly shutdownSignal?: AbortSignal;
  readonly scheduler?: Scheduler;
  /** Ids and closed codes only; never tokens, codes, titles or Google messages. */
  readonly logger?: GoogleServiceLogger;
}

interface PendingState {
  readonly ownerId: Id;
  readonly verifier: string;
  readonly expiresAtMs: number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

interface SyncCounts {
  imported: { created: number; updated: number; removed: number; dayEvents: number };
  exported: { created: number; updated: number; removed: number };
}

type RunMode = 'full' | 'export';

type RunOutcome =
  | { readonly kind: 'done'; readonly counts: SyncCounts; readonly lastSyncAt: Instant; readonly blocked: GoogleSyncErrorCode | null }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'auth_revoked' }
  | { readonly kind: 'cancelled' };

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function hasScopes(scopes: readonly string[], required: readonly string[]): boolean {
  return required.every((scope) => scopes.includes(scope));
}

export function importAvailableFor(scopes: readonly string[]): boolean {
  return hasScopes(scopes, [GOOGLE_SCOPE_CALENDARLIST_READONLY, GOOGLE_SCOPE_EVENTS_READONLY]);
}

export function exportAvailableFor(scopes: readonly string[]): boolean {
  return hasScopes(scopes, [GOOGLE_SCOPE_APP_CREATED]);
}

function tokenAad(ownerId: Id, keyId: string): string {
  return `google-refresh-token:${ownerId}:${keyId}`;
}

function zeroCounts(): SyncCounts {
  return {
    imported: { created: 0, updated: 0, removed: 0, dayEvents: 0 },
    exported: { created: 0, updated: 0, removed: 0 },
  };
}

const ACCESS_ROLES: ReadonlySet<string> = new Set(GOOGLE_CALENDAR_ACCESS_ROLES);

/**
 * CAL-03 Google Calendar integration (ADR-024, 08 §2.11).
 *
 * - OAuth: authorization code + PKCE S256, single-use 10-minute state bound to
 *   the owner (in memory; a restart only means "connect again"). The callback
 *   needs a valid session of that same owner.
 * - Tokens: the refresh token is stored only as an AES-256-GCM envelope (AAD =
 *   owner + key id); access tokens live in this process's memory only.
 * - Sync: one owner at a time per process (in-process queue), import then
 *   export, every Google call bounded by a per-run deadline and the shutdown
 *   signal; failures are recorded as closed codes and never stop other owners.
 */
export class GoogleCalendarService implements GoogleIntegrationService {
  readonly #options: GoogleCalendarServiceOptions;
  readonly #store: GoogleCalendarStore;
  readonly #clock: Clock;
  readonly #scheduler: Scheduler;
  readonly #pending = new Map<string, PendingState>();
  readonly #tokens = new Map<Id, CachedToken>();
  readonly #queues = new Map<Id, Promise<unknown>>();
  readonly #running = new Map<Id, AbortController>();
  readonly #nudges = new Map<Id, { readonly mode: RunMode; readonly handle: { cancel(): void } }>();
  readonly #inFlight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(options: GoogleCalendarServiceOptions) {
    this.#options = options;
    this.#store = options.store;
    this.#clock = options.clock;
    this.#scheduler = options.scheduler ?? defaultScheduler;
  }

  // ---- status / settings -------------------------------------------------

  async status(ownerId: Id): Promise<GoogleIntegration> {
    const connection = await this.#store.getConnection(ownerId);
    if (connection === null) {
      return {
        status: 'disconnected',
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
    const calendars =
      connection.status === 'disconnected' ? [] : await this.#store.listCalendars(ownerId);
    const connected = connection.status === 'connected';
    return {
      status: connection.status,
      importAvailable: connected && importAvailableFor(connection.grantedScopes),
      exportAvailable: connected && exportAvailableFor(connection.grantedScopes),
      calendars: calendars
        .filter((calendar) => calendar.googleCalendarId !== connection.exportCalendarId)
        .map((calendar) => ({
          id: calendar.id,
          name: calendar.name,
          primary: calendar.primary,
          accessRole: calendar.accessRole,
          selected: calendar.selected,
        })),
      exportCalendarName: connection.exportCalendarId === null ? null : EXPORT_CALENDAR_NAME,
      settings: connection.settings,
      lastSyncAt: connection.lastSyncAt,
      lastError: connection.lastError,
      version: connection.version,
    };
  }

  async updateSettings(
    ownerId: Id,
    input: GoogleIntegrationSettingsPut,
    expectedVersion: number,
  ): Promise<GoogleIntegration> {
    const connection = await this.#store.getConnection(ownerId);
    if (connection === null || connection.status === 'disconnected') {
      throw googleStateConflict('Google Calendar is not connected');
    }
    await this.#store.updateSettings(
      ownerId,
      expectedVersion,
      { selectedCalendarIds: input.selectedCalendarIds as Id[], settings: input.settings },
      this.#clock.now(),
    );
    this.#schedule(ownerId, 'full');
    return this.status(ownerId);
  }

  async listDayEvents(ownerId: Id, from: string, to: string): Promise<CalendarDayEventPage> {
    validateDayEventRange(from, to);
    return { items: [...(await this.#store.listDayEvents(ownerId, from, to))] };
  }

  redirectLocation(result: GoogleCallbackResult): string {
    return fixedRedirectLocation(this.#options.oauthConfig.webOrigin, result);
  }

  // ---- OAuth -------------------------------------------------------------

  async connect(ownerId: Id): Promise<GoogleConnectResponse> {
    const nowMs = Date.parse(this.#clock.now());
    this.#prunePending(nowMs);
    const state = base64url(randomBytes(32));
    // RFC 7636: 43..128 unreserved characters; 32 random bytes -> 43 chars.
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier, 'ascii').digest());
    this.#pending.set(sha256(state), {
      ownerId,
      verifier,
      expiresAtMs: nowMs + GOOGLE_OAUTH_STATE_TTL_MS,
    });
    const params = new URLSearchParams({
      client_id: this.#options.oauthConfig.clientId,
      redirect_uri: this.#options.oauthConfig.redirectUri,
      response_type: 'code',
      scope: GOOGLE_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'false',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return { authorizationUrl: `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}` };
  }

  async handleCallback(input: GoogleCallbackInput): Promise<GoogleCallbackResult> {
    const result = await this.#callback(input);
    if (result.outcome !== 'connected') {
      this.#options.logger?.warn('google oauth callback rejected', { reason: result.reason });
    }
    return result.outcome;
  }

  async #callback(
    input: GoogleCallbackInput,
  ): Promise<{ readonly outcome: GoogleCallbackResult; readonly reason?: string }> {
    const nowMs = Date.parse(this.#clock.now());
    if (input.state === undefined) return { outcome: 'error', reason: 'state_missing' };
    const key = sha256(input.state);
    const pending = this.#pending.get(key);
    // Single use: the state is consumed by the first callback that presents it.
    this.#pending.delete(key);
    if (pending === undefined) return { outcome: 'error', reason: 'state_unknown' };
    if (pending.expiresAtMs <= nowMs) return { outcome: 'error', reason: 'state_expired' };
    if (input.sessionOwnerId === null || input.sessionOwnerId !== pending.ownerId) {
      return { outcome: 'error', reason: 'session_mismatch' };
    }
    if (input.error !== undefined) {
      return input.error === 'access_denied'
        ? { outcome: 'denied', reason: 'access_denied' }
        : { outcome: 'error', reason: 'google_error' };
    }
    if (input.code === undefined) return { outcome: 'error', reason: 'code_missing' };
    let tokens;
    try {
      tokens = await this.#options.oauth.exchangeCode(
        {
          code: input.code,
          codeVerifier: pending.verifier,
          redirectUri: this.#options.oauthConfig.redirectUri,
        },
        this.#shutdownOnly(),
      );
    } catch (error) {
      return {
        outcome: 'error',
        reason: error instanceof GoogleApiError ? `exchange_${error.kind}` : 'exchange_failed',
      };
    }
    if (tokens.refreshToken === null) return { outcome: 'error', reason: 'no_refresh_token' };
    const ownerId = pending.ownerId;
    const key32 = this.#options.oauthConfig.tokenKey;
    const scopes = (tokens.scopes ?? []).filter((scope) => (GOOGLE_SCOPES as readonly string[]).includes(scope));
    await this.#store.saveGrant(
      ownerId,
      {
        ciphertext: encryptAtRest(tokens.refreshToken, key32.key, tokenAad(ownerId, key32.keyId)),
        keyId: key32.keyId,
        scopes,
      },
      this.#clock.now(),
    );
    this.#tokens.set(ownerId, {
      token: tokens.accessToken,
      expiresAtMs: nowMs + tokens.expiresInSec * 1_000,
    });
    this.#schedule(ownerId, 'full', 0);
    return { outcome: 'connected' };
  }

  #prunePending(nowMs: number): void {
    for (const [key, entry] of this.#pending) {
      if (entry.expiresAtMs <= nowMs) this.#pending.delete(key);
    }
    while (this.#pending.size >= MAX_PENDING_STATES) {
      const oldest = this.#pending.keys().next().value;
      if (oldest === undefined) break;
      this.#pending.delete(oldest);
    }
  }

  // ---- disconnect --------------------------------------------------------

  async disconnect(ownerId: Id, expectedVersion: number, removeExported: boolean): Promise<void> {
    const before = await this.#store.getConnection(ownerId);
    if (before === null || before.status === 'disconnected') {
      throw googleStateConflict('Google Calendar is not connected');
    }
    if (before.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as never, before.version as never);
    }
    this.#cancelNudge(ownerId);
    this.#running.get(ownerId)?.abort();
    await this.#exclusive(ownerId, async () => {
      const connection = await this.#store.getConnection(ownerId);
      if (connection === null || connection.status === 'disconnected') {
        throw googleStateConflict('Google Calendar is not connected');
      }
      if (connection.version !== expectedVersion) {
        throw new VersionConflictError(expectedVersion as never, connection.version as never);
      }
      const signal = this.#withShutdown(AbortSignal.timeout(DISCONNECT_GOOGLE_BOUND_MS));
      let refreshToken: string | null;
      try {
        refreshToken = this.#decryptRefreshToken(ownerId, connection);
      } catch {
        refreshToken = null;
      }
      const steps: Record<string, string> = {};
      if (refreshToken !== null) {
        if (removeExported && connection.exportCalendarId !== null) {
          try {
            const access = await this.#options.oauth.refresh(refreshToken, { signal });
            await this.#options.calendar.deleteCalendar(access.accessToken, connection.exportCalendarId, {
              signal,
            });
            steps['exportCalendar'] = 'deleted';
          } catch (error) {
            const kind = error instanceof GoogleApiError ? error.kind : 'internal';
            steps['exportCalendar'] = kind === 'not_found' || kind === 'gone' ? 'already_gone' : `failed_${kind}`;
          }
        }
        try {
          await this.#options.oauth.revoke(refreshToken, { signal });
          steps['revoke'] = 'revoked';
        } catch (error) {
          steps['revoke'] = `failed_${error instanceof GoogleApiError ? error.kind : 'internal'}`;
        }
      } else {
        steps['revoke'] = 'skipped_no_token';
      }
      await this.#store.disconnect(ownerId, expectedVersion, this.#clock.now());
      this.#tokens.delete(ownerId);
      if (Object.values(steps).some((step) => step.startsWith('failed') || step.startsWith('skipped'))) {
        this.#options.logger?.warn('google disconnect best-effort step incomplete', { ownerId, ...steps });
      }
    });
  }

  // ---- sync --------------------------------------------------------------

  async syncNow(ownerId: Id): Promise<GoogleSyncResult> {
    const connection = await this.#store.getConnection(ownerId);
    if (connection === null || connection.status === 'disconnected') {
      throw googleStateConflict('Google Calendar is not connected');
    }
    if (connection.status === 'needs_reauth') {
      throw googleStateConflict('Google needs a new consent: connect again');
    }
    this.#cancelNudge(ownerId);
    const outcome = await this.#exclusive(ownerId, () => this.#run(ownerId, 'full'));
    switch (outcome.kind) {
      case 'auth_revoked':
        throw googleStateConflict('Google revoked the grant: connect again');
      case 'skipped':
      case 'cancelled':
        throw googleStateConflict('Google Calendar is not connected');
      case 'done':
        if (outcome.blocked !== null) throw new ProviderUnavailableError('google', outcome.blocked);
        return { ...outcome.counts, lastSyncAt: outcome.lastSyncAt };
    }
  }

  /** One leader-locked tick: every connected owner, one at a time. */
  async runScheduledSync(): Promise<number> {
    if (this.#closed) return 0;
    const owners = await this.#store.listConnectedOwnerIds();
    let synced = 0;
    for (const ownerId of owners) {
      if (this.#closed) break;
      try {
        const outcome = await this.#exclusive(ownerId, () => this.#run(ownerId, 'full'));
        if (outcome.kind === 'done') synced += 1;
      } catch (error) {
        this.#options.logger?.warn('google sync failed for owner', {
          ownerId,
          code: syncErrorCodeOf(error),
        });
      }
    }
    return synced;
  }

  nudgeExport(ownerId: Id): void {
    try {
      this.#schedule(ownerId, 'export');
    } catch {
      // A nudge is best effort and must never affect the request.
    }
  }

  /** Stop nudges, abort running syncs and wait for them (bounded by the caller). */
  async close(): Promise<void> {
    this.#closed = true;
    for (const ownerId of [...this.#nudges.keys()]) this.#cancelNudge(ownerId);
    for (const controller of this.#running.values()) controller.abort();
    await Promise.allSettled([...this.#inFlight]);
  }

  #schedule(ownerId: Id, mode: RunMode, delayMs = this.#options.nudgeDelayMs ?? DEFAULT_GOOGLE_NUDGE_DELAY_MS): void {
    if (this.#closed) return;
    const existing = this.#nudges.get(ownerId);
    // A pending full sync already covers an export nudge.
    const effective: RunMode = existing?.mode === 'full' ? 'full' : mode;
    existing?.handle.cancel();
    const handle = this.#scheduler(() => {
      this.#nudges.delete(ownerId);
      if (this.#closed) return;
      const run = this.#exclusive(ownerId, () => this.#run(ownerId, effective)).catch((error: unknown) => {
        this.#options.logger?.warn('google background sync failed', {
          ownerId,
          mode: effective,
          code: syncErrorCodeOf(error),
        });
      });
      this.#track(run);
    }, delayMs);
    this.#nudges.set(ownerId, { mode: effective, handle });
  }

  #cancelNudge(ownerId: Id): void {
    this.#nudges.get(ownerId)?.handle.cancel();
    this.#nudges.delete(ownerId);
  }

  #track(promise: Promise<unknown>): void {
    this.#inFlight.add(promise);
    void promise.finally(() => this.#inFlight.delete(promise));
  }

  /** Per-owner FIFO: syncs, nudges and disconnect never overlap for one owner. */
  async #exclusive<T>(ownerId: Id, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(ownerId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.catch(() => undefined);
    this.#queues.set(ownerId, settled);
    this.#track(settled);
    try {
      return await current;
    } finally {
      if (this.#queues.get(ownerId) === settled) this.#queues.delete(ownerId);
    }
  }

  #shutdownOnly(): { signal?: AbortSignal } {
    const shutdown = this.#options.shutdownSignal;
    return shutdown === undefined ? {} : { signal: shutdown };
  }

  #withShutdown(signal: AbortSignal): AbortSignal {
    const shutdown = this.#options.shutdownSignal;
    return shutdown === undefined ? signal : AbortSignal.any([signal, shutdown]);
  }

  async #run(ownerId: Id, mode: RunMode): Promise<RunOutcome> {
    if (this.#closed) return { kind: 'cancelled' };
    const connection = await this.#store.getConnection(ownerId);
    if (connection === null || connection.status !== 'connected') return { kind: 'skipped' };
    const controller = new AbortController();
    this.#running.set(ownerId, controller);
    const deadline = AbortSignal.timeout(this.#options.runBoundMs ?? DEFAULT_GOOGLE_RUN_BOUND_MS);
    const signal = this.#withShutdown(AbortSignal.any([controller.signal, deadline]));
    const counts = zeroCounts();
    const state: { lastError: GoogleSyncErrorCode | null; blocked: GoogleSyncErrorCode | null } = {
      lastError: null,
      blocked: null,
    };
    const note = (code: GoogleSyncErrorCode): void => {
      state.lastError ??= code;
    };
    const codeOf = (error: unknown): GoogleSyncErrorCode =>
      deadline.aborted ? 'run_deadline' : syncErrorCodeOf(error);
    const fail = (error: unknown): void => {
      const code = codeOf(error);
      note(code);
      if (code === 'rate_limited' || code === 'google_unavailable' || code === 'run_deadline') {
        state.blocked ??= code;
      }
    };
    try {
      let accessToken: string;
      try {
        accessToken = await this.#accessToken(ownerId, connection, signal);
      } catch (error) {
        if (error instanceof GoogleApiError && error.kind === 'auth_revoked') return { kind: 'auth_revoked' };
        throw error;
      }
      const profile = await this.#store.ownerProfile(ownerId);
      if (mode === 'full' && importAvailableFor(connection.grantedScopes)) {
        try {
          await this.#import(ownerId, connection, accessToken, profile, signal, counts, note);
        } catch (error) {
          if (controller.signal.aborted) return { kind: 'cancelled' };
          if (this.#isRevoked(ownerId, error)) return { kind: 'auth_revoked' };
          fail(error);
        }
      }
      if (exportAvailableFor(connection.grantedScopes)) {
        try {
          await this.#export(ownerId, accessToken, profile, signal, counts, note);
        } catch (error) {
          if (controller.signal.aborted) return { kind: 'cancelled' };
          if (this.#isRevoked(ownerId, error)) return { kind: 'auth_revoked' };
          fail(error);
        }
      }
      if (controller.signal.aborted) return { kind: 'cancelled' };
      const now = this.#clock.now();
      if (mode === 'full') {
        await this.#store.recordSync(ownerId, { lastSyncAt: now, lastError: state.lastError }, now);
      } else if (state.lastError !== null) {
        await this.#store.recordSync(ownerId, { lastError: state.lastError }, now);
      }
      return { kind: 'done', counts, lastSyncAt: now, blocked: state.blocked };
    } finally {
      if (this.#running.get(ownerId) === controller) this.#running.delete(ownerId);
    }
  }

  #isRevoked(ownerId: Id, error: unknown): boolean {
    if (error instanceof GoogleApiError && error.kind === 'unauthorized') {
      // The access token was rejected: forget it; the next run refreshes.
      this.#tokens.delete(ownerId);
    }
    return error instanceof GoogleApiError && error.kind === 'auth_revoked';
  }

  #decryptRefreshToken(ownerId: Id, connection: GoogleConnectionRecord): string {
    const key = this.#options.oauthConfig.tokenKey;
    if (connection.refreshTokenCiphertext === null || connection.tokenKeyId !== key.keyId) {
      throw new GoogleApiError('stored token', 'auth_revoked', 0, 'key_mismatch');
    }
    try {
      return decryptAtRest(connection.refreshTokenCiphertext, key.key, tokenAad(ownerId, key.keyId));
    } catch {
      throw new GoogleApiError('stored token', 'auth_revoked', 0, 'key_mismatch');
    }
  }

  /**
   * In-memory access token (never persisted). invalid_grant or an
   * undecryptable stored token -> needs_reauth (nothing is deleted).
   */
  async #accessToken(ownerId: Id, connection: GoogleConnectionRecord, signal: AbortSignal): Promise<string> {
    const nowMs = Date.parse(this.#clock.now());
    const cached = this.#tokens.get(ownerId);
    if (cached !== undefined && cached.expiresAtMs - nowMs > TOKEN_REFRESH_MARGIN_MS) return cached.token;
    try {
      const refreshToken = this.#decryptRefreshToken(ownerId, connection);
      const response = await this.#options.oauth.refresh(refreshToken, { signal });
      this.#tokens.set(ownerId, {
        token: response.accessToken,
        expiresAtMs: nowMs + response.expiresInSec * 1_000,
      });
      return response.accessToken;
    } catch (error) {
      if (error instanceof GoogleApiError && error.kind === 'auth_revoked') {
        this.#tokens.delete(ownerId);
        await this.#store.markNeedsReauth(ownerId, this.#clock.now());
        this.#options.logger?.warn('google grant needs re-consent', { ownerId, code: 'auth_revoked' });
      }
      throw error;
    }
  }

  // ---- import ------------------------------------------------------------

  async #import(
    ownerId: Id,
    connection: GoogleConnectionRecord,
    accessToken: string,
    profile: { readonly timeZone: string; readonly locale: string },
    signal: AbortSignal,
    counts: SyncCounts,
    note: (code: GoogleSyncErrorCode) => void,
  ): Promise<void> {
    const listed: GoogleCalendarListEntry[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const page = await this.#options.calendar.listCalendars(accessToken, pageToken, { signal });
      listed.push(...page.items);
      pageToken = page.nextPageToken;
      pages += 1;
    } while (pageToken !== undefined && pages < MAX_CALENDAR_PAGES);
    if (pageToken !== undefined) {
      // A partial calendar list could unlist (and un-import) real calendars.
      note('too_many_events');
      return;
    }
    const entries: ListedCalendar[] = [];
    for (const entry of listed) {
      if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 1_024) continue;
      if (entry.id === connection.exportCalendarId) continue;
      const accessRole = entry.accessRole ?? 'reader';
      if (!ACCESS_ROLES.has(accessRole)) continue;
      const name = cutTitle(entry.summaryOverride ?? entry.summary, '');
      const listedCalendar = {
        googleCalendarId: entry.id,
        name,
        accessRole: accessRole as ListedCalendar['accessRole'],
        primary: entry.primary === true,
        timeZone: typeof entry.timeZone === 'string' && entry.timeZone.length <= 100 ? entry.timeZone : null,
      };
      entries.push({ ...listedCalendar, defaultSelected: defaultSelected(listedCalendar) });
    }
    const now = this.#clock.now();
    const calendars = await this.#store.replaceCalendarList(ownerId, connection.id, entries, now);
    const window = importWindow(now, this.#options.importDays);
    const removal = removalWindow(window, profile.timeZone);
    const selected = calendars.filter((calendar) => calendar.selected);
    const maxPages = this.#options.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES;

    for (const calendar of selected) {
      try {
        const events: GoogleEventResource[] = [];
        let eventPage: string | undefined;
        let eventPages = 0;
        do {
          const page = await this.#options.calendar.listEvents(
            accessToken,
            calendar.googleCalendarId,
            { timeMin: window.timeMin, timeMax: window.timeMax, pageToken: eventPage },
            { signal },
          );
          events.push(...page.items);
          eventPage = page.nextPageToken;
          eventPages += 1;
        } while (eventPage !== undefined && eventPages < maxPages);
        const complete = eventPage === undefined;
        if (!complete) note('too_many_events');

        const timed: ImportedCommitmentValues[] = [];
        const days: ImportedDayEventValues[] = [];
        for (const event of events) {
          const classified = classifyEvent(event, {
            calendarTimeZone: calendar.timeZone,
            ownerTimeZone: profile.timeZone,
            locale: profile.locale,
          });
          if (classified.kind === 'timed') timed.push(classified.values);
          else if (classified.kind === 'day') days.push(classified.values);
        }
        const commitmentChanges = diffCommitments(
          await this.#store.listImportedCommitments(ownerId, calendar.googleCalendarId),
          timed,
          removal,
          complete,
        );
        const dayChanges = diffDayEvents(
          await this.#store.listImportedDayEvents(ownerId, calendar.googleCalendarId),
          days,
          removal,
          complete,
        );
        const at = this.#clock.now();
        await this.#store.applyCommitmentChanges(ownerId, calendar.googleCalendarId, commitmentChanges, at);
        await this.#store.applyDayEventChanges(ownerId, calendar.googleCalendarId, dayChanges, at);
        counts.imported.created += commitmentChanges.create.length;
        counts.imported.updated += commitmentChanges.update.length;
        counts.imported.removed += commitmentChanges.remove.length;
        counts.imported.dayEvents +=
          dayChanges.create.length + dayChanges.update.length + dayChanges.remove.length;
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof GoogleApiError && (error.kind === 'auth_revoked' || error.kind === 'unauthorized')) {
          throw error;
        }
        // One failing calendar is recorded and does not stop the others.
        note(syncErrorCodeOf(error));
        this.#options.logger?.warn('google calendar import failed', {
          ownerId,
          code: syncErrorCodeOf(error),
        });
      }
    }
    const removed = await this.#store.removeImportsOutside(
      ownerId,
      selected.map((calendar) => calendar.googleCalendarId),
      this.#clock.now(),
    );
    counts.imported.removed += removed.commitments;
    counts.imported.dayEvents += removed.dayEvents;
  }

  // ---- export ------------------------------------------------------------

  async #export(
    ownerId: Id,
    accessToken: string,
    profile: { readonly timeZone: string },
    signal: AbortSignal,
    counts: SyncCounts,
    note: (code: GoogleSyncErrorCode) => void,
  ): Promise<void> {
    const connection = await this.#store.getConnection(ownerId);
    if (connection === null || connection.status !== 'connected') return;
    const settings = connection.settings;
    const anything = settings.exportBlocks || settings.exportCommitments || settings.dailySummary;
    let calendarId = connection.exportCalendarId;
    if (calendarId === null) {
      if (!anything) return;
      const created = await this.#options.calendar.insertCalendar(
        accessToken,
        { summary: EXPORT_CALENDAR_NAME, timeZone: profile.timeZone },
        { signal },
      );
      calendarId = created.id;
      await this.#store.deleteAllMappings(ownerId);
      await this.#store.setExportCalendar(ownerId, calendarId, this.#clock.now());
    }
    const nowMs = Date.parse(this.#clock.now());
    const from = new Date(nowMs - DAY_MS).toISOString() as Instant;
    const to = new Date(nowMs + this.#options.exportDays * DAY_MS).toISOString() as Instant;
    const source = await this.#store.loadExportSource(ownerId, from, to);
    const desired = desiredEvents({
      source,
      taskTitles: await this.#taskTitles(ownerId, source.blocks.map((block) => block.taskId)),
      settings,
      calendarId,
    });
    const mappings = new Map(
      (await this.#store.listMappings(ownerId)).map((mapping) => [`${mapping.kind}:${mapping.localKey}`, mapping]),
    );
    const budget = { writes: this.#options.maxExportWrites ?? DEFAULT_MAX_EXPORT_WRITES };
    const desiredKeys = new Set<string>();
    for (const event of desired) {
      const key = `${event.kind}:${event.localKey}`;
      desiredKeys.add(key);
      const mapping = mappings.get(key);
      if (mapping !== undefined && mapping.googleCalendarId === calendarId && mapping.fingerprint === event.fingerprint) {
        continue;
      }
      if (budget.writes <= 0) break;
      budget.writes -= 1;
      try {
        const outcome = await this.#push(ownerId, accessToken, calendarId, event, mapping, signal);
        if (outcome === 'calendar_gone') {
          await this.#forgetExportCalendar(ownerId);
          return;
        }
        if (outcome === 'created') counts.exported.created += 1;
        else counts.exported.updated += 1;
      } catch (error) {
        if (signal.aborted || !(error instanceof GoogleApiError) || error.kind !== 'rejected') throw error;
        // One event Google refuses (e.g. an unsupported RRULE) does not stop the rest.
        note('google_rejected');
      }
    }
    const windowStartMs = nowMs - DAY_MS;
    for (const [key, mapping] of mappings) {
      if (desiredKeys.has(key)) continue;
      if (mapping.googleCalendarId !== calendarId) {
        await this.#store.deleteMapping(ownerId, mapping.kind, mapping.localKey);
        continue;
      }
      if (mapping.endsAt !== null && Date.parse(mapping.endsAt) < windowStartMs) {
        // Aged out of the window: keep the past event on the phone, forget the mapping.
        await this.#store.deleteMapping(ownerId, mapping.kind, mapping.localKey);
        continue;
      }
      if (budget.writes <= 0) break;
      budget.writes -= 1;
      try {
        await this.#options.calendar.deleteEvent(accessToken, calendarId, mapping.googleEventId, { signal });
      } catch (error) {
        if (!(error instanceof GoogleApiError) || (error.kind !== 'not_found' && error.kind !== 'gone')) {
          throw error;
        }
      }
      await this.#store.deleteMapping(ownerId, mapping.kind, mapping.localKey);
      counts.exported.removed += 1;
    }
  }

  /**
   * Idempotent push of one event: patch through the mapping; else insert with
   * the deterministic id; a duplicate id (e.g. a lost mapping or a previously
   * deleted event, which Google keeps as cancelled) is patched back to
   * confirmed; a mapped event that is gone (404/410) is re-created.
   */
  async #push(
    ownerId: Id,
    accessToken: string,
    calendarId: string,
    event: DesiredEvent,
    mapping: ExportMappingRecord | undefined,
    signal: AbortSignal,
  ): Promise<'created' | 'updated' | 'calendar_gone'> {
    const calendar = this.#options.calendar;
    const save = async (googleEventId: string): Promise<void> => {
      await this.#store.upsertMapping(
        ownerId,
        {
          kind: event.kind,
          localKey: event.localKey,
          googleCalendarId: calendarId,
          googleEventId,
          fingerprint: event.fingerprint,
          endsAt: event.endsAt,
        },
        this.#clock.now(),
      );
    };
    const patch = async (eventId: string): Promise<boolean> => {
      try {
        await calendar.patchEvent(accessToken, calendarId, eventId, event.body, { signal });
        await save(eventId);
        return true;
      } catch (error) {
        if (error instanceof GoogleApiError && (error.kind === 'not_found' || error.kind === 'gone')) {
          return false;
        }
        throw error;
      }
    };
    if (mapping !== undefined && mapping.googleCalendarId === calendarId) {
      if (await patch(mapping.googleEventId)) return 'updated';
      await this.#store.deleteMapping(ownerId, event.kind, event.localKey);
    }
    const body: GoogleEventWrite & { id?: string } = { ...event.body, id: event.eventId };
    try {
      const created = await calendar.insertEvent(accessToken, calendarId, body, { signal });
      await save(created.id);
      return 'created';
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      if (error.kind === 'not_found') return 'calendar_gone';
      if (error.kind !== 'duplicate') throw error;
    }
    if (await patch(event.eventId)) return 'updated';
    // The deterministic id is taken but not patchable: let Google assign one.
    const created = await calendar.insertEvent(accessToken, calendarId, event.body, { signal });
    await save(created.id);
    return 'created';
  }

  async #forgetExportCalendar(ownerId: Id): Promise<void> {
    // The user deleted the "OhMyDate" calendar in Google: start over next run.
    await this.#store.deleteAllMappings(ownerId);
    await this.#store.setExportCalendar(ownerId, null, this.#clock.now());
  }

  async #taskTitles(ownerId: Id, taskIds: readonly Id[]): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    for (const taskId of [...new Set(taskIds)].slice(0, MAX_TITLE_LOOKUPS)) {
      try {
        const task = await this.#options.tasks.get(ownerId, taskId);
        if (task !== null) titles.set(taskId, task.title);
      } catch {
        // Provider down: the planner title cache covers the rest of this run.
        break;
      }
    }
    return titles;
  }
}
