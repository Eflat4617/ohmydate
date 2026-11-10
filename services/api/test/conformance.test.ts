import {
  ProblemSchema,
  ProjectSchema,
  UserSchema,
  PageProjectSchema,
  PageTaskSchema,
  TaskSchema,
  routes,
  schemaRegistry,
} from '@ohmydate/contracts';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
} from './support/test-context.js';
import { compile } from './support/schemas.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

function concretePath(path: string): string {
  return path.replace(/\{id\}/g, ID);
}

describe.skipIf(!hasDatabase)('contract conformance', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'conformance@example.com', password: 'correct-horse' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('every route in the contracts table is registered', async () => {
    for (const route of routes) {
      const response = await ctx.app.inject({
        method: route.method.toUpperCase() as 'GET',
        url: concretePath(route.path),
        ...(route.method === 'get' || route.method === 'delete' ? {} : { payload: {} }),
      });
      expect({
        route: route.operationId,
        registered: response.statusCode !== 404,
        declared: Object.keys(route.responses).map(Number).includes(response.statusCode),
      }).toEqual({ route: route.operationId, registered: true, declared: true });
    }
  });

  test('problem responses use application/problem+json and validate', async () => {
    const validateProblem = compile(ProblemSchema);
    const response = await ctx.app.inject({ method: 'GET', url: '/me' });
    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json();
    expect(validateProblem(body)).toBe(true);
    expect(body).toMatchObject({ status: 401, code: 'forbidden' });
    expect(typeof (body as { traceId?: unknown }).traceId).toBe('string');
  });

  test('unknown routes return a not_found problem', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, code: 'not_found' });
  });

  test('successful responses validate against their contract schemas', async () => {
    const session = await login(ctx, 'conformance@example.com', 'correct-horse');

    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: authHeaders(session) });
    expect(me.statusCode).toBe(200);
    expect(compile(UserSchema)(me.json())).toBe(true);

    const createProject = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Conformance project' },
    });
    expect(createProject.statusCode).toBe(201);
    expect(compile(ProjectSchema)(createProject.json())).toBe(true);

    const projectId = (createProject.json() as { id: string }).id;
    const createTask = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Conformance task', projectId },
    });
    expect(createTask.statusCode).toBe(201);
    expect(compile(TaskSchema)(createTask.json())).toBe(true);

    const listTasks = await ctx.app.inject({
      method: 'GET',
      url: '/tasks?limit=10',
      headers: authHeaders(session),
    });
    expect(listTasks.statusCode).toBe(200);
    expect(compile(PageTaskSchema)(listTasks.json())).toBe(true);

    const listProjects = await ctx.app.inject({
      method: 'GET',
      url: '/projects',
      headers: authHeaders(session),
    });
    expect(listProjects.statusCode).toBe(200);
    expect(compile(PageProjectSchema)(listProjects.json())).toBe(true);
  });

  test('registered schema registry covers every contracted DTO', () => {
    expect(schemaRegistry).toMatchObject({
      Problem: ProblemSchema,
      Project: ProjectSchema,
      Task: TaskSchema,
      User: UserSchema,
    });
  });
});
