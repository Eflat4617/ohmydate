import { dailyRoutes, type RouteDefinition } from '@ohmydate/contracts';
import type { InjectOptions } from 'fastify';
import { API_PREFIX } from '../src/app.js';
import { toFastifyPath } from '../src/http/routes.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';

const ID = '01a1cec5-5000-7008-a1c5-abb08e90622b';

function declared(route: RouteDefinition, status: number): boolean {
  return Object.keys(route.responses).map(Number).includes(status);
}

function requiredHeaders(route: RouteDefinition): readonly string[] {
  const headers = route.headers as { readonly required?: readonly string[] } | undefined;
  return headers?.required ?? [];
}

function urlFor(route: RouteDefinition): string {
  return `${API_PREFIX}${toFastifyPath(route.path).replace(/:id\(\[\^:\]\+\)/g, ID)}`;
}

describe.skipIf(!hasDatabase)('daily route conformance', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'daily-conf@example.com', password: 'correct-horse' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('every daily route returns only declared statuses for malformed or missing resources', async () => {
    const session = await login(ctx, 'daily-conf@example.com', 'correct-horse');
    for (const route of dailyRoutes) {
      const headers = authHeaders(session);
      if (requiredHeaders(route).includes('If-Match')) {
        headers['if-match'] =
          route.operationId === 'approveTodayProposal' ? 'W/"availability:1"' : 'W/"1"';
      }
      if (requiredHeaders(route).includes('Idempotency-Key')) {
        headers['idempotency-key'] = newIdempotencyKey();
      }
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: urlFor(route),
        headers,
      };
      if (route.body !== undefined) options.payload = {};
      const response = await ctx.app.inject(options);
      expect({
        route: route.operationId,
        status: response.statusCode,
        declared: declared(route, response.statusCode),
      }).toEqual({ route: route.operationId, status: response.statusCode, declared: true });
      if (response.statusCode >= 400) {
        expect(response.headers['content-type']).toContain('application/problem+json');
      }
    }
  });
});
