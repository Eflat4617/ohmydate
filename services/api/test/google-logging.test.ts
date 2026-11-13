import { Writable } from 'node:stream';
import pino from 'pino';
import { defaultLoggerOptions } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { FakeGoogle, ManualScheduler, testGoogleSecrets, timedEvent } from './support/google-fakes.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
} from './support/test-context.js';

/**
 * CAL-03: drive connect, callback (good and bad), sync with a failing calendar,
 * re-consent and disconnect through the app with the production logger
 * options, and check that no token, auth code, state, verifier, client
 * secret, Authorization header, event title or calendar id reaches a log line.
 */
describe.skipIf(!hasDatabase)('Google integration logging', () => {
  test('tokens, codes, auth headers, titles and calendar ids never appear in logs', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      defaultLoggerOptions(createConfig({ logLevel: 'trace' })) as unknown as pino.LoggerOptions,
      stream,
    );
    const google = new FakeGoogle();
    const secrets = testGoogleSecrets();
    const captured = { state: '' };
    const ctx = await createTestContext({
      loggerInstance: logger,
      google: { secrets, oauth: google, calendar: google, nudgeScheduler: new ManualScheduler().scheduler },
    });
    try {
      await ctx.seedUser({ email: 'logs@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'logs@example.com', 'correct-horse');
      google.calendars.push({ id: 'secret-team@group.calendar.google.com', summary: '비밀 팀', accessRole: 'owner' });
      google.events.set('primary@example.test', [
        timedEvent('e1', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', { summary: '비밀 진료 일정' }),
      ]);
      google.failingCalendars.set('secret-team@group.calendar.google.com', 'rate_limited');

      const connect = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/integrations/google:connect',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      });
      captured.state = new URL((connect.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state') ?? '';
      // A rejected callback (unknown state) is logged with a reason code only.
      await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google/callback?code=4/forged-code&state=forged-state' });
      await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/integrations/google/callback?code=4/real-auth-code&state=${captured.state}`,
        headers: { cookie: session.cookie },
      });
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/integrations/google:sync',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey(), authorization: 'Bearer ya29.client-header' }),
      });
      google.refreshFails = 'invalid_grant';
      ctx.clock.advance(2 * 60 * 60_000);
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/integrations/google:sync',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      });
      const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(session) });
      await ctx.app.inject({
        method: 'DELETE',
        url: '/api/v1/integrations/google',
        headers: authHeaders(session, { 'if-match': status.headers['etag'] as string, 'idempotency-key': newIdempotencyKey() }),
      });
    } finally {
      await ctx.close();
    }
    const text = chunks.join('');
    expect(text).toContain('google oauth callback rejected');
    expect(text).toContain('state_unknown');
    expect(text).toContain('google calendar import failed');
    expect(text).toContain('google grant needs re-consent');
    expect(captured.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const secret of [
      google.refreshToken,
      'ya29.',
      'real-auth-code',
      'forged-code',
      'forged-state',
      captured.state,
      secrets.clientSecret,
      '비밀 진료 일정',
      '비밀 팀',
      'secret-team@group.calendar.google.com',
      'primary@example.test',
    ]) {
      expect({ secret, leaked: secret.length > 0 && text.includes(secret) }).toEqual({ secret, leaked: false });
    }
    const verifier = google.calls.find((call) => call.op === 'exchangeCode')?.args['codeVerifier'];
    expect(typeof verifier).toBe('string');
    expect(text.includes(verifier as string)).toBe(false);
  });
});
