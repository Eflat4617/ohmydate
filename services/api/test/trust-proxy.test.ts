import { createTestContext, hasDatabase, type TestContext } from './support/test-context.js';

function loginAttempt(
  ctx: TestContext,
  email: string,
  password: string,
  forwardedFor: string,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': forwardedFor },
    payload: { email, password },
  });
}

describe.skipIf(!hasDatabase)('trustProxy wiring', () => {
  test('when disabled, a rotating X-Forwarded-For does not bypass the login limiter', async () => {
    const ctx = await createTestContext({
      config: { trustProxy: false, loginRateLimit: { limit: 2, windowMs: 60_000 } },
    });
    try {
      await ctx.seedUser({ email: 'xff-off@example.com', password: 'correct-horse' });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await loginAttempt(
          ctx,
          'xff-off@example.com',
          'wrong',
          `10.0.0.${attempt + 1}`,
        );
        expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 401 });
      }
      const blocked = await loginAttempt(
        ctx,
        'xff-off@example.com',
        'correct-horse',
        '10.0.0.99',
      );
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    } finally {
      await ctx.close();
    }
  });

  test('with a trusted proxy address, the limiter keys on X-Forwarded-For', async () => {
    const ctx = await createTestContext({
      config: { trustProxy: '127.0.0.1', loginRateLimit: { limit: 2, windowMs: 60_000 } },
    });
    try {
      await ctx.seedUser({ email: 'xff-on@example.com', password: 'correct-horse' });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await loginAttempt(ctx, 'xff-on@example.com', 'wrong', '10.0.0.5');
        expect({ attempt, status: response.statusCode }).toEqual({ attempt, status: 401 });
      }
      const blocked = await loginAttempt(ctx, 'xff-on@example.com', 'correct-horse', '10.0.0.5');
      expect(blocked.statusCode).toBe(429);

      const otherClient = await loginAttempt(
        ctx,
        'xff-on@example.com',
        'correct-horse',
        '10.0.0.6',
      );
      expect(otherClient.statusCode).toBe(204);
    } finally {
      await ctx.close();
    }
  });
});
