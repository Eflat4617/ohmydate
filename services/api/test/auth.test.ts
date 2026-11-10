import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';

describe.skipIf(!hasDatabase)('authentication and sessions', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'alice@example.com', password: 'correct-horse' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('login sets HttpOnly session and readable CSRF cookies', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');
    const sidCookie = session.setCookies.find((cookie) => cookie.startsWith('sid='));
    const csrfCookie = session.setCookies.find((cookie) => cookie.startsWith('csrf='));

    expect(sidCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();
    expect(sidCookie).toContain('HttpOnly');
    expect(sidCookie).toContain('SameSite=Lax');
    expect(sidCookie).toContain('Path=/');
    expect(csrfCookie).not.toContain('HttpOnly');
    expect(sidCookie).not.toContain('Secure');
  });

  test('cookie Secure is configurable for production', async () => {
    const secure = await createTestContext({ config: { cookieSecure: true } });
    try {
      await secure.seedUser({ email: 'secure@example.com', password: 'correct-horse' });
      const session = await login(secure, 'secure@example.com', 'correct-horse');
      expect(session.setCookies.every((cookie) => cookie.includes('Secure'))).toBe(true);
    } finally {
      await secure.close();
    }
  });

  test('login rejects a wrong password and an unknown email', async () => {
    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'alice@example.com', password: 'wrong' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.headers['content-type']).toContain('application/problem+json');
    expect(wrong.json()).toMatchObject({ code: 'unauthenticated' });

    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.com', password: 'whatever' },
    });
    expect(unknown.statusCode).toBe(401);
  });

  test('login rate limit is 5 per minute per IP+email', async () => {
    const limited = await createTestContext({
      config: { loginRateLimit: { limit: 5, windowMs: 60_000 } },
    });
    try {
      await limited.seedUser({ email: 'limited@example.com', password: 'correct-horse' });
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const response = await limited.app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'limited@example.com', password: 'wrong' },
        });
        expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 401 });
      }
      const blocked = await limited.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'limited@example.com', password: 'correct-horse' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    } finally {
      await limited.close();
    }
  });

  test('mutations require a matching CSRF token', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');
    const payload = { title: 'CSRF task' };

    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: {
        cookie: session.cookie,
        'idempotency-key': newIdempotencyKey(),
      },
      payload,
    });
    expect(missing.statusCode).toBe(403);

    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: {
        cookie: session.cookie,
        'x-csrf-token': 'not-the-token',
        'idempotency-key': newIdempotencyKey(),
      },
      payload,
    });
    expect(mismatch.statusCode).toBe(403);
  });

  test('logout invalidates the server-side session', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');
    const logout = await ctx.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: authHeaders(session),
    });
    expect(logout.statusCode).toBe(204);

    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: { cookie: session.cookie } });
    expect(me.statusCode).toBe(401);
  });

  test('GET /me returns ETag and supports If-None-Match', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: authHeaders(session) });
    expect(me.statusCode).toBe(200);
    expect(me.headers['etag']).toBe('W/"1"');

    const notModified = await ctx.app.inject({
      method: 'GET',
      url: '/me',
      headers: authHeaders(session, { 'if-none-match': 'W/"1"' }),
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['etag']).toBe('W/"1"');
    expect(notModified.body).toBe('');
  });

  test('PATCH /me/settings enforces If-Match and Idempotency-Key', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');

    const missingIfMatch = await ctx.app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { timeZone: 'Asia/Seoul' },
    });
    expect(missingIfMatch.statusCode).toBe(428);

    const missingKey = await ctx.app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: authHeaders(session, { 'if-match': 'W/"1"' }),
      payload: { timeZone: 'Asia/Seoul' },
    });
    expect(missingKey.statusCode).toBe(400);

    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: authHeaders(session, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { timeZone: 'Asia/Seoul', locale: 'ko' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ timeZone: 'Asia/Seoul', locale: 'ko', version: 2 });
    expect(updated.headers['etag']).toBe('W/"2"');

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: authHeaders(session, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { timeZone: 'UTC' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'version_conflict' });
  });

  test('settings reject unknown IANA time zones through contract validation', async () => {
    const session = await login(ctx, 'alice@example.com', 'correct-horse');
    const invalid = await ctx.app.inject({
      method: 'PATCH',
      url: '/me/settings',
      headers: authHeaders(session, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { timeZone: 'Mars/Olympus' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
