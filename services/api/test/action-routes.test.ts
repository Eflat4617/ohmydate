import Fastify from 'fastify';
import { toFastifyPath } from '../src/http/routes.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  type TestContext,
} from './support/test-context.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

describe.skipIf(!hasDatabase)('action route translation', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'actions@example.com', password: 'correct-horse' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('POST /tasks/{id} without an action suffix is not a task action', async () => {
    const session = await login(ctx, 'actions@example.com', 'correct-horse');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${ID}`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });

  test('unknown task actions are not swallowed by the complete route', async () => {
    const session = await login(ctx, 'actions@example.com', 'correct-horse');
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${ID}:reopen`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(404);
  });

  test('two actions can be registered on one resource without route collisions', async () => {
    const app = Fastify({ logger: false });
    app.post(toFastifyPath('/dummy/{id}:pause'), async (request) => ({
      action: 'pause',
      params: request.params,
    }));
    app.post(toFastifyPath('/dummy/{id}:resume'), async (request) => ({
      action: 'resume',
      params: request.params,
    }));

    expect(app.hasRoute({ method: 'POST', url: '/dummy/:id([^:]+)::pause' })).toBe(true);
    expect(app.hasRoute({ method: 'POST', url: '/dummy/:id([^:]+)::resume' })).toBe(true);

    const pause = await app.inject({ method: 'POST', url: '/dummy/abc:pause' });
    const resume = await app.inject({ method: 'POST', url: '/dummy/abc:resume' });
    const bare = await app.inject({ method: 'POST', url: '/dummy/abc' });

    expect(pause.json()).toEqual({ action: 'pause', params: { id: 'abc' } });
    expect(resume.json()).toEqual({ action: 'resume', params: { id: 'abc' } });
    expect(bare.statusCode).toBe(404);
    await app.close();
  });
});
