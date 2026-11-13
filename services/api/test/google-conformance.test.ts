import { integrationRoutes, GoogleIntegrationSchema, type RouteDefinition } from '@ohmydate/contracts';
import type { InjectOptions } from 'fastify';
import { API_PREFIX } from '../src/app.js';
import { toFastifyPath } from '../src/http/routes.js';
import { compile } from './support/schemas.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';

function declared(route: RouteDefinition, status: number): boolean {
  return Object.keys(route.responses).map(Number).includes(status);
}

function requiredHeaders(route: RouteDefinition): readonly string[] {
  const headers = route.headers as { readonly required?: readonly string[] } | undefined;
  return headers?.required ?? [];
}

function urlFor(route: RouteDefinition): string {
  const base = `${API_PREFIX}${toFastifyPath(route.path).replace('::', ':')}`;
  return route.operationId === 'listCalendarDayEvents' ? `${base}?from=2026-11-01&to=2026-11-30` : base;
}

function payloadFor(route: RouteDefinition): unknown {
  if (route.operationId === 'updateGoogleIntegrationSettings') {
    return {
      selectedCalendarIds: [],
      settings: { exportBlocks: true, exportCommitments: true, dailySummary: true, reminderMinutes: 10 },
    };
  }
  return undefined;
}

describe.skipIf(!hasDatabase)('Google integration route conformance (not configured)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'google-conf@example.com', password: 'correct-horse' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('every integration route is registered at its action-safe path', () => {
    for (const route of integrationRoutes) {
      expect({
        route: route.operationId,
        registered: ctx.app.hasRoute({
          method: route.method.toUpperCase() as 'GET',
          url: `${API_PREFIX}${toFastifyPath(route.path)}`,
        }),
      }).toEqual({ route: route.operationId, registered: true });
    }
  });

  test('unauthenticated requests are declared 401 problems', async () => {
    for (const route of integrationRoutes) {
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: urlFor(route),
      };
      if (route.method !== 'get' && route.method !== 'delete') options.payload = {};
      const response = await ctx.app.inject(options);
      expect({ route: route.operationId, status: response.statusCode }).toEqual({
        route: route.operationId,
        status: 401,
      });
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  test('mutations without the CSRF header are declared 403 problems', async () => {
    const session = await login(ctx, 'google-conf@example.com', 'correct-horse');
    for (const route of integrationRoutes.filter((entry) => entry.method !== 'get')) {
      const headers: Record<string, string> = { cookie: session.cookie };
      if (requiredHeaders(route).includes('If-Match')) headers['if-match'] = 'W/"1"';
      if (requiredHeaders(route).includes('Idempotency-Key')) {
        headers['idempotency-key'] = newIdempotencyKey();
      }
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: urlFor(route),
        headers,
      };
      const payload = payloadFor(route);
      if (payload !== undefined) options.payload = payload as never;
      const response = await ctx.app.inject(options);
      expect({ route: route.operationId, status: response.statusCode }).toEqual({
        route: route.operationId,
        status: 403,
      });
    }
  });

  test('authenticated requests return only declared statuses; actions are 409 when not configured', async () => {
    const session = await login(ctx, 'google-conf@example.com', 'correct-horse');
    for (const route of integrationRoutes) {
      const headers = authHeaders(session);
      if (requiredHeaders(route).includes('If-Match')) headers['if-match'] = 'W/"1"';
      if (requiredHeaders(route).includes('Idempotency-Key')) {
        headers['idempotency-key'] = newIdempotencyKey();
      }
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: urlFor(route),
        headers,
      };
      const payload = payloadFor(route);
      if (payload !== undefined) options.payload = payload as never;
      const response = await ctx.app.inject(options);
      expect({
        route: route.operationId,
        status: response.statusCode,
        declared: declared(route, response.statusCode),
      }).toEqual({ route: route.operationId, status: response.statusCode, declared: true });
      if (route.method === 'get') {
        expect(response.statusCode).toBe(200);
      } else {
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'illegal_transition' });
      }
    }
  });

  test('GET reports not_configured with a version ETag', async () => {
    const session = await login(ctx, 'google-conf@example.com', 'correct-horse');
    const response = await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/integrations/google`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    expect(compile(GoogleIntegrationSchema)(response.json())).toBe(true);
    expect(response.json()).toMatchObject({
      status: 'not_configured',
      importAvailable: false,
      exportAvailable: false,
    });
    expect(response.headers['etag']).toBe('W/"1"');
    const again = await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/integrations/google`,
      headers: authHeaders(session, { 'if-none-match': 'W/"1"' }),
    });
    expect(again.statusCode).toBe(304);
  });

  test('the callback is a fixed 302 to the settings path, never to a URL from the request', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `${API_PREFIX}/integrations/google/callback?code=abc&state=xyz&redirect_uri=https://evil.example/`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/settings/calendar?google=error');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toBe('');
  });

  test('a day-event range above 92 days or reversed is 422', async () => {
    const session = await login(ctx, 'google-conf@example.com', 'correct-horse');
    for (const query of ['from=2026-01-01&to=2026-06-01', 'from=2026-11-30&to=2026-11-01']) {
      const response = await ctx.app.inject({
        method: 'GET',
        url: `${API_PREFIX}/calendar-day-events?${query}`,
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'validation_failed' });
    }
  });
});
