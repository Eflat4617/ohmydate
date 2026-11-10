import {
  createTestContext,
  hasDatabase,
  type TestContext,
} from './support/test-context.js';

describe.skipIf(!hasDatabase)('health endpoints', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('/healthz reports liveness at the root, outside /api/v1', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  test('/readyz checks PostgreSQL at the root', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      checks: { database: 'ok', vikunja: 'skipped' },
    });
  });

  test('contract routes are not served at the root', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/tasks' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  test('/readyz reports 503 when Vikunja is configured but unreachable', async () => {
    const broken = await createTestContext({
      config: { provider: 'vikunja', vikunjaUrl: 'http://127.0.0.1:9' },
    });
    try {
      const response = await broken.app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'unavailable',
        checks: { database: 'ok', vikunja: 'failed' },
      });
    } finally {
      await broken.close();
    }
  });
});
