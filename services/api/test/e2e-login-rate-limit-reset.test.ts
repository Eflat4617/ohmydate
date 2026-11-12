import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { InMemoryLoginRateLimiter } from '../src/adapters/in-memory-login-rate-limiter.js';
import { buildApp } from '../src/app.js';
import { configFromEnv, createConfig } from '../src/config.js';
import type { Database } from '../src/db/types.js';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { createTestContext, databaseUrl, hasDatabase } from './support/test-context.js';

const RESET_URL = '/api/v1/__e2e__/reset-login-rate-limit';

describe('FU-79 E2E_RESET_LOGIN_RATE_LIMIT config', () => {
  test('only the exact value "1" enables the fake-only knob', () => {
    expect(configFromEnv({}).e2eResetLoginRateLimit).toBe(false);
    expect(configFromEnv({ E2E_RESET_LOGIN_RATE_LIMIT: 'true' }).e2eResetLoginRateLimit).toBe(
      false,
    );
    expect(configFromEnv({ E2E_RESET_LOGIN_RATE_LIMIT: '0' }).e2eResetLoginRateLimit).toBe(false);
    expect(configFromEnv({ E2E_RESET_LOGIN_RATE_LIMIT: '' }).e2eResetLoginRateLimit).toBe(false);
    expect(configFromEnv({ E2E_RESET_LOGIN_RATE_LIMIT: '1' }).e2eResetLoginRateLimit).toBe(true);
  });

  test('negative: production rejects the knob, including a non-normalised spelling', () => {
    expect(() =>
      configFromEnv({ NODE_ENV: 'production', E2E_RESET_LOGIN_RATE_LIMIT: '1' }),
    ).toThrow(/E2E_RESET_LOGIN_RATE_LIMIT.*production/);
    expect(() =>
      configFromEnv({ NODE_ENV: ' Production ', E2E_RESET_LOGIN_RATE_LIMIT: '1' }),
    ).toThrow(/E2E_RESET_LOGIN_RATE_LIMIT.*production/);
    // Without the knob production stays bootable.
    expect(configFromEnv({ NODE_ENV: 'production' }).e2eResetLoginRateLimit).toBe(false);
  });

  test('negative: a real LLM provider rejects the knob', () => {
    expect(() =>
      configFromEnv({
        LLM_PROVIDER: 'deepseek',
        LLM_API_KEY_FILE: '/nonexistent/fu79-not-read.txt',
        LLM_SESSION_HEADER: 'off',
        E2E_RESET_LOGIN_RATE_LIMIT: '1',
      }),
    ).toThrow(/E2E_RESET_LOGIN_RATE_LIMIT.*LLM_PROVIDER=fake/);
  });
});

describe.skipIf(!hasDatabase)('FU-79 buildApp rejects the knob', () => {
  async function expectBootRejects(config: ReturnType<typeof createConfig>): Promise<void> {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(79, clock);
    const pool = new pg.Pool({ connectionString: databaseUrl ?? '' });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    try {
      await expect(
        buildApp({
          config,
          repos: createInMemoryRepositories({ clock, ids }),
          clock,
          ids,
          db,
          logger: false,
        }),
      ).rejects.toThrow(/E2E_RESET_LOGIN_RATE_LIMIT/);
    } finally {
      await db.destroy();
    }
  }

  test('production + knob is refused at boot', async () => {
    await expectBootRejects(
      createConfig({
        databaseUrl: databaseUrl ?? null,
        logLevel: 'silent',
        llmProvider: 'fake',
        nodeEnv: 'production',
        e2eResetLoginRateLimit: true,
      }),
    );
  });

  test('deepseek + knob is refused at boot', async () => {
    await expectBootRejects(
      createConfig({
        databaseUrl: databaseUrl ?? null,
        logLevel: 'silent',
        llmProvider: 'deepseek',
        e2eResetLoginRateLimit: true,
      }),
    );
  });
});

describe.skipIf(!hasDatabase)('FU-79 reset route', () => {
  test('knob off: route is a problem+json not_found', async () => {
    const ctx = await createTestContext();
    try {
      const response = await ctx.app.inject({ method: 'POST', url: RESET_URL });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'not_found' });
    } finally {
      await ctx.close();
    }
  });

  test('knob on: POST clears the 429 window without creating a session; GET stays 404', async () => {
    const ctx = await createTestContext({
      config: {
        e2eResetLoginRateLimit: true,
        loginRateLimit: { limit: 2, windowMs: 60_000 },
      },
    });
    try {
      await ctx.seedUser({ email: 'fu79-reset@example.com', password: 'correct-horse' });
      const attempt = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: 'fu79-reset@example.com', password: 'wrong-password' },
        });

      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(429);

      const reset = await ctx.app.inject({ method: 'POST', url: RESET_URL });
      expect(reset.statusCode).toBe(204);
      expect(reset.headers['set-cookie']).toBeUndefined();

      // The window is gone: the next attempt is authenticated (401), not 429.
      expect((await attempt()).statusCode).toBe(401);

      // The route created no session (no cookie, /me unauthenticated).
      const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me' });
      expect(me.statusCode).toBe(401);

      // Only POST exists.
      expect((await ctx.app.inject({ method: 'GET', url: RESET_URL })).statusCode).toBe(404);

      // And a valid login really works after the reset.
      const valid = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: 'fu79-reset@example.com', password: 'correct-horse' },
      });
      expect(valid.statusCode).toBe(204);
    } finally {
      await ctx.close();
    }
  });

  test('negative: reset() clears only the limiter window it owns', () => {
    const clock = new FakeClock();
    const limiter = new InMemoryLoginRateLimiter({ clock, limit: 2, windowMs: 60_000 });
    expect(limiter.consume('127.0.0.1:a@example.com')).toBe(true);
    expect(limiter.consume('127.0.0.1:a@example.com')).toBe(true);
    expect(limiter.consume('127.0.0.1:a@example.com')).toBe(false);
    limiter.reset();
    expect(limiter.consume('127.0.0.1:a@example.com')).toBe(true);
  });
});
