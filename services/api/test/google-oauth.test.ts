import { createHash } from 'node:crypto';
import { GoogleIntegrationSchema } from '@ohmydate/contracts';
import { decryptAtRest } from '../src/application/at-rest-crypto.js';
import {
  GOOGLE_SCOPES,
  GOOGLE_SCOPE_APP_CREATED,
  GOOGLE_SCOPE_CALENDARLIST_READONLY,
  GOOGLE_SCOPE_EVENTS_READONLY,
} from '../src/application/google-calendar-ports.js';
import type { GoogleOAuthSecrets } from '../src/google-config.js';
import {
  FakeGoogle,
  ManualScheduler,
  TEST_REDIRECT_URI,
  TEST_WEB_ORIGIN,
  testGoogleSecrets,
  timedEvent,
} from './support/google-fakes.js';
import { compile } from './support/schemas.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const BASE = '/api/v1/integrations/google';

describe.skipIf(!hasDatabase)('Google OAuth connect / callback / disconnect (CAL-03)', () => {
  let ctx: TestContext;
  let google: FakeGoogle;
  let secrets: GoogleOAuthSecrets;
  let manual: ManualScheduler;
  let ownerA: string;
  let sessionA: TestSession;
  let sessionB: TestSession;

  beforeEach(async () => {
    google = new FakeGoogle();
    secrets = testGoogleSecrets();
    manual = new ManualScheduler();
    ctx = await createTestContext({
      google: { secrets, oauth: google, calendar: google, nudgeScheduler: manual.scheduler },
    });
    ownerA = await ctx.seedUser({ email: 'google-a@example.com', password: 'correct-horse', timeZone: 'Asia/Seoul' });
    await ctx.seedUser({ email: 'google-b@example.com', password: 'correct-horse' });
    sessionA = await login(ctx, 'google-a@example.com', 'correct-horse');
    sessionB = await login(ctx, 'google-b@example.com', 'correct-horse');
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function connect(session: TestSession): Promise<URL> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `${BASE}:connect`,
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(200);
    return new URL((response.json() as { authorizationUrl: string }).authorizationUrl);
  }

  async function callback(
    session: TestSession | null,
    params: Record<string, string>,
  ): Promise<{ status: number; location: string | undefined }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `${BASE}/callback?${new URLSearchParams(params).toString()}`,
      ...(session === null ? {} : { headers: { cookie: session.cookie } }),
    });
    return { status: response.statusCode, location: response.headers['location'] as string | undefined };
  }

  async function connected(session: TestSession): Promise<void> {
    const url = await connect(session);
    const result = await callback(session, { code: 'auth-code-1', state: url.searchParams.get('state') ?? '' });
    expect(result.location).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=connected`);
  }

  async function status(session: TestSession): Promise<{ body: Record<string, unknown>; etag: string }> {
    const response = await ctx.app.inject({ method: 'GET', url: BASE, headers: authHeaders(session) });
    expect(response.statusCode).toBe(200);
    expect(compile(GoogleIntegrationSchema)(response.json())).toBe(true);
    return { body: response.json() as Record<string, unknown>, etag: response.headers['etag'] as string };
  }

  async function sync(session: TestSession): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: `${BASE}:sync`,
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    });
    return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
  }

  test('connect returns a PKCE S256 offline consent URL with the three least-privilege scopes', async () => {
    const url = await connect(sessionA);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(secrets.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(TEST_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([...GOOGLE_SCOPES].sort());
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 32 random bytes, base64url.
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.has('client_secret')).toBe(false);
    const second = await connect(sessionA);
    expect(second.searchParams.get('state')).not.toBe(url.searchParams.get('state'));
  });

  test('callback exchanges the code with the PKCE verifier and stores only an encrypted refresh token', async () => {
    const url = await connect(sessionA);
    const result = await callback(sessionA, { code: 'auth-code-1', state: url.searchParams.get('state') ?? '' });
    expect(result.status).toBe(302);
    expect(result.location).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=connected`);

    const exchange = google.calls.find((call) => call.op === 'exchangeCode');
    const verifier = exchange?.args['codeVerifier'] as string;
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(exchange?.args['redirectUri']).toBe(TEST_REDIRECT_URI);
    expect(exchange?.args['code']).toBe('auth-code-1');

    const row = await ctx.db
      .selectFrom('google_calendar_connection')
      .selectAll()
      .where('owner_id', '=', ownerA as never)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('connected');
    expect(row.token_key_id).toBe(secrets.tokenKey.keyId);
    const ciphertext = row.refresh_token_ciphertext as Buffer;
    expect(Buffer.isBuffer(ciphertext)).toBe(true);
    expect(ciphertext.includes(Buffer.from(google.refreshToken))).toBe(false);
    expect(
      decryptAtRest(ciphertext, secrets.tokenKey.key, `google-refresh-token:${ownerA}:${secrets.tokenKey.keyId}`),
    ).toBe(google.refreshToken);
    // Bound to the owner: another owner's AAD cannot decrypt it.
    expect(() =>
      decryptAtRest(ciphertext, secrets.tokenKey.key, `google-refresh-token:other:${secrets.tokenKey.keyId}`),
    ).toThrow(/authentication/);

    // The plaintext token, the access token and the auth code are nowhere in the database.
    const dump = JSON.stringify(
      await Promise.all([
        ctx.db.selectFrom('google_calendar_connection').selectAll().execute(),
        ctx.db.selectFrom('idempotency_record').selectAll().execute(),
        ctx.db.selectFrom('audit_event').selectAll().execute(),
      ]),
    );
    expect(dump).not.toContain(google.refreshToken);
    expect(dump).not.toContain('ya29.');
    expect(dump).not.toContain('auth-code-1');

    const { body } = await status(sessionA);
    expect(body).toMatchObject({ status: 'connected', importAvailable: true, exportAvailable: true });
  });

  test('the state is single use', async () => {
    const url = await connect(sessionA);
    const state = url.searchParams.get('state') ?? '';
    expect((await callback(sessionA, { code: 'c1', state })).location).toContain('google=connected');
    const replay = await callback(sessionA, { code: 'c2', state });
    expect(replay.location).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=error`);
    expect(google.callCount('exchangeCode')).toBe(1);
  });

  test('an expired state (10 minutes) is refused without calling Google', async () => {
    const url = await connect(sessionA);
    ctx.clock.advance(10 * 60_000 + 1_000);
    const result = await callback(sessionA, { code: 'c1', state: url.searchParams.get('state') ?? '' });
    expect(result.location).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=error`);
    expect(google.callCount('exchangeCode')).toBe(0);
    expect(await ctx.db.selectFrom('google_calendar_connection').selectAll().execute()).toEqual([]);
  });

  test("another owner's session or no session cannot complete the flow, and the state is burnt", async () => {
    const url = await connect(sessionA);
    const state = url.searchParams.get('state') ?? '';
    expect((await callback(sessionB, { code: 'c1', state })).location).toContain('google=error');
    expect((await callback(sessionA, { code: 'c1', state })).location).toContain('google=error');

    const other = await connect(sessionA);
    expect(
      (await callback(null, { code: 'c1', state: other.searchParams.get('state') ?? '' })).location,
    ).toContain('google=error');
    expect(google.callCount('exchangeCode')).toBe(0);
    expect(await ctx.db.selectFrom('google_calendar_connection').selectAll().execute()).toEqual([]);
  });

  test('access_denied ends in google=denied and stores nothing; other errors and gaps end in google=error', async () => {
    const url = await connect(sessionA);
    expect(
      (await callback(sessionA, { error: 'access_denied', state: url.searchParams.get('state') ?? '' })).location,
    ).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=denied`);
    const again = await connect(sessionA);
    expect(
      (await callback(sessionA, { error: 'server_error', state: again.searchParams.get('state') ?? '' })).location,
    ).toContain('google=error');
    expect((await callback(sessionA, { code: 'c1' })).location).toContain('google=error');
    const missingCode = await connect(sessionA);
    expect(
      (await callback(sessionA, { state: missingCode.searchParams.get('state') ?? '' })).location,
    ).toContain('google=error');
    expect(google.callCount('exchangeCode')).toBe(0);
    expect(await ctx.db.selectFrom('google_calendar_connection').selectAll().execute()).toEqual([]);
  });

  test('the redirect target is fixed whatever the request carries', async () => {
    const url = await connect(sessionA);
    const response = await ctx.app.inject({
      method: 'GET',
      url: `${BASE}/callback?state=${url.searchParams.get('state') ?? ''}&code=c1&redirect_uri=https%3A%2F%2Fevil.example%2F&next=//evil.example`,
      headers: { cookie: sessionA.cookie, host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=connected`);
  });

  test('a failed exchange or a missing refresh token stores nothing', async () => {
    google.exchangeFails = true;
    const first = await connect(sessionA);
    expect(
      (await callback(sessionA, { code: 'c1', state: first.searchParams.get('state') ?? '' })).location,
    ).toContain('google=error');
    google.exchangeFails = false;
    google.omitRefreshToken = true;
    const second = await connect(sessionA);
    expect(
      (await callback(sessionA, { code: 'c2', state: second.searchParams.get('state') ?? '' })).location,
    ).toContain('google=error');
    expect(await ctx.db.selectFrom('google_calendar_connection').selectAll().execute()).toEqual([]);
  });

  test('granular consent: without the read scopes import is off, without app.created export is off', async () => {
    google.grantedScopes = [GOOGLE_SCOPE_APP_CREATED];
    await connected(sessionA);
    expect((await status(sessionA)).body).toMatchObject({ importAvailable: false, exportAvailable: true });
    const synced = await sync(sessionA);
    expect(synced.statusCode).toBe(200);
    expect(google.callCount('listCalendars')).toBe(0);
    expect(google.callCount('listEvents')).toBe(0);

    google.grantedScopes = [GOOGLE_SCOPE_CALENDARLIST_READONLY, GOOGLE_SCOPE_EVENTS_READONLY];
    await connected(sessionA);
    expect((await status(sessionA)).body).toMatchObject({ importAvailable: true, exportAvailable: false });
    const before = google.callCount('insertCalendar');
    expect((await sync(sessionA)).statusCode).toBe(200);
    expect(google.callCount('insertCalendar')).toBe(before);
    expect(google.callCount('insertEvent')).toBe(0);
  });

  test('invalid_grant on refresh moves to needs_reauth, stops sync and deletes nothing', async () => {
    google.events.set('primary@example.test', [
      timedEvent('evt1', '2026-01-02T10:00:00+09:00', '2026-01-02T11:00:00+09:00'),
    ]);
    await connected(sessionA);
    expect((await sync(sessionA)).statusCode).toBe(200);
    expect(
      await ctx.db.selectFrom('commitment_event').select('id').where('source', '=', 'google').where('deleted_at', 'is', null).execute(),
    ).toHaveLength(1);

    google.refreshFails = 'invalid_grant';
    ctx.clock.advance(60 * 60_000);
    const failed = await sync(sessionA);
    expect(failed.statusCode).toBe(409);
    expect(failed.body).toMatchObject({ code: 'illegal_transition' });
    const { body } = await status(sessionA);
    expect(body).toMatchObject({ status: 'needs_reauth', lastError: 'auth_revoked', importAvailable: false });
    expect(
      await ctx.db.selectFrom('commitment_event').select('id').where('source', '=', 'google').where('deleted_at', 'is', null).execute(),
    ).toHaveLength(1);
    const again = await sync(sessionA);
    expect(again.statusCode).toBe(409);
  });

  test('disconnect revokes, deletes the export calendar, forgets the token and soft-deletes imports', async () => {
    google.events.set('primary@example.test', [
      timedEvent('evt1', '2026-01-02T10:00:00+09:00', '2026-01-02T11:00:00+09:00'),
      { id: 'day1', status: 'confirmed', summary: '휴일', start: { date: '2026-01-03' }, end: { date: '2026-01-04' } },
    ]);
    await connected(sessionA);
    expect((await sync(sessionA)).statusCode).toBe(200);
    const exportCalendar = [...google.ownCalendars.keys()][0];
    expect(exportCalendar).toBeDefined();

    const stale = await ctx.app.inject({
      method: 'DELETE',
      url: BASE,
      headers: authHeaders(sessionA, { 'if-match': 'W/"999"', 'idempotency-key': newIdempotencyKey() }),
    });
    expect(stale.statusCode).toBe(412);
    expect(google.callCount('revoke')).toBe(0);

    const { etag } = await status(sessionA);
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: BASE,
      headers: authHeaders(sessionA, { 'if-match': etag, 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(204);
    expect(google.deletedCalendars).toEqual([exportCalendar]);
    expect(google.revoked).toEqual([google.refreshToken]);

    const row = await ctx.db
      .selectFrom('google_calendar_connection')
      .selectAll()
      .where('owner_id', '=', ownerA as never)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: 'disconnected', refresh_token_ciphertext: null, token_key_id: null, export_calendar_id: null });
    expect(
      await ctx.db.selectFrom('commitment_event').select('id').where('source', '=', 'google').where('deleted_at', 'is', null).execute(),
    ).toEqual([]);
    expect(
      await ctx.db.selectFrom('calendar_day_event').select('id').where('deleted_at', 'is', null).execute(),
    ).toEqual([]);
    expect(await ctx.db.selectFrom('google_export_mapping').selectAll().execute()).toEqual([]);
    expect(await ctx.db.selectFrom('google_calendar').selectAll().execute()).toEqual([]);
    expect((await status(sessionA)).body).toMatchObject({ status: 'disconnected', calendars: [] });

    const twice = await ctx.app.inject({
      method: 'DELETE',
      url: BASE,
      headers: authHeaders(sessionA, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
    });
    expect(twice.statusCode).toBe(409);
  });

  test('disconnect with removeExported=false keeps the OhMyDate calendar at Google', async () => {
    await connected(sessionA);
    expect((await sync(sessionA)).statusCode).toBe(200);
    const { etag } = await status(sessionA);
    const response = await ctx.app.inject({
      method: 'DELETE',
      url: `${BASE}?removeExported=false`,
      headers: authHeaders(sessionA, { 'if-match': etag, 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(204);
    expect(google.callCount('deleteCalendar')).toBe(0);
    expect(google.ownCalendars.size).toBe(1);
    expect(google.revoked).toHaveLength(1);
  });

  test('settings: full replacement, unknown ids are 422, stale If-Match is 412, disconnected is 409', async () => {
    const settings = { exportBlocks: false, exportCommitments: true, dailySummary: false, reminderMinutes: null };
    const disconnected = await ctx.app.inject({
      method: 'PUT',
      url: `${BASE}/settings`,
      headers: authHeaders(sessionA, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
      payload: { selectedCalendarIds: [], settings },
    });
    expect(disconnected.statusCode).toBe(409);

    google.calendars.push({ id: 'team@group.calendar.google.com', summary: '팀', accessRole: 'reader' });
    await connected(sessionA);
    expect((await sync(sessionA)).statusCode).toBe(200);
    const { body, etag } = await status(sessionA);
    const calendars = body['calendars'] as { id: string; name: string; selected: boolean }[];
    expect(calendars.map((calendar) => [calendar.name, calendar.selected])).toEqual([
      ['me@example.test', true],
      ['팀', false],
    ]);
    const team = calendars.find((calendar) => calendar.name === '팀');

    const unknown = await ctx.app.inject({
      method: 'PUT',
      url: `${BASE}/settings`,
      headers: authHeaders(sessionA, { 'if-match': etag, 'idempotency-key': newIdempotencyKey() }),
      payload: { selectedCalendarIds: [ownerA], settings },
    });
    expect(unknown.statusCode).toBe(422);

    const updated = await ctx.app.inject({
      method: 'PUT',
      url: `${BASE}/settings`,
      headers: authHeaders(sessionA, { 'if-match': etag, 'idempotency-key': newIdempotencyKey() }),
      payload: { selectedCalendarIds: [team?.id], settings },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ settings });
    expect(
      (updated.json() as { calendars: { name: string; selected: boolean }[] }).calendars.map((calendar) => [
        calendar.name,
        calendar.selected,
      ]),
    ).toEqual([
      ['me@example.test', false],
      ['팀', true],
    ]);
    expect(updated.headers['etag']).not.toBe(etag);

    const stale = await ctx.app.inject({
      method: 'PUT',
      url: `${BASE}/settings`,
      headers: authHeaders(sessionA, { 'if-match': etag, 'idempotency-key': newIdempotencyKey() }),
      payload: { selectedCalendarIds: [], settings },
    });
    expect(stale.statusCode).toBe(412);
  });

  test("an owner never sees or changes another owner's connection", async () => {
    await connected(sessionA);
    expect((await sync(sessionA)).statusCode).toBe(200);
    const { body } = await status(sessionB);
    expect(body).toMatchObject({ status: 'disconnected', calendars: [], version: 1 });
    const bSync = await sync(sessionB);
    expect(bSync.statusCode).toBe(409);
    const bDelete = await ctx.app.inject({
      method: 'DELETE',
      url: BASE,
      headers: authHeaders(sessionB, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
    });
    expect(bDelete.statusCode).toBe(409);
    expect((await status(sessionA)).body).toMatchObject({ status: 'connected' });
  });

  test('the background sync after connect is scheduled, not run inside the callback', async () => {
    await connected(sessionA);
    expect(google.callCount('listCalendars')).toBe(0);
    expect(manual.pending).toBe(1);
  });
});
