import {
  PageProjectSchema,
  ProblemSchema,
  ProjectSchema,
  TaskSchema,
  UserSchema,
  PageTaskSchema,
  routes,
  schemaRegistry,
  type RouteDefinition,
} from '@ohmydate/contracts';
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
  type TestSession,
} from './support/test-context.js';
import { compile } from './support/schemas.js';

const ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const OTHER_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';

function concretePath(path: string): string {
  return `${API_PREFIX}${path}`.replace(/\{id\}/g, ID);
}

function declaredStatuses(route: RouteDefinition): readonly number[] {
  return Object.keys(route.responses).map(Number);
}

function assertProblem(
  route: RouteDefinition,
  response: { statusCode: number; headers: Record<string, unknown>; body: string },
): void {
  expect({
    route: route.operationId,
    status: response.statusCode,
    declared: declaredStatuses(route).includes(response.statusCode),
  }).toEqual({ route: route.operationId, status: response.statusCode, declared: true });
  expect(response.headers['content-type']).toContain('application/problem+json');
  const body = JSON.parse(response.body) as unknown;
  expect(compile(ProblemSchema)(body)).toBe(true);
  expect(typeof (body as { traceId?: unknown }).traceId).toBe('string');
}

function assertSuccess(route: RouteDefinition, response: { statusCode: number; body: string }): void {
  expect(declaredStatuses(route)).toContain(response.statusCode);
  const schema = route.responses[response.statusCode]?.schema;
  if (schema !== undefined) {
    expect(compile(schema)(JSON.parse(response.body) as unknown)).toBe(true);
  }
}

describe.skipIf(!hasDatabase)('contract conformance', () => {
  let ctx: TestContext;
  let session: TestSession;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'conformance@example.com', password: 'correct-horse' });
    session = await login(ctx, 'conformance@example.com', 'correct-horse');
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('every route in the contracts table is registered at its action-safe path', () => {
    for (const route of routes) {
      expect({
        route: route.operationId,
        registered: ctx.app.hasRoute({
          method: route.method.toUpperCase() as 'GET',
          url: `${API_PREFIX}${toFastifyPath(route.path)}`,
        }),
      }).toEqual({ route: route.operationId, registered: true });
    }
  });

  test('unknown routes return a not_found problem', async () => {
    const response = await ctx.app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ status: 404, code: 'not_found' });
    expect(typeof (response.json() as { traceId?: unknown }).traceId).toBe('string');
  });

  test('unauthenticated requests return declared problem responses', async () => {
    for (const route of routes) {
      const response = await ctx.app.inject({
        method: route.method.toUpperCase() as 'GET',
        url: concretePath(route.path),
        ...(route.method === 'get' || route.method === 'delete' ? {} : { payload: {} }),
      });
      assertProblem(route, response);
      expect(response.statusCode).toBe(route.operationId === 'login' ? 400 : 401);
    }
  });

  test('authenticated + CSRF-valid requests only return declared statuses', async () => {
    // Login is public and has no session/CSRF phase; exercise its failure path.
    const loginRoute = routeById('login');
    const loginFailure = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'conformance@example.com', password: 'wrong' },
    });
    assertProblem(loginRoute, loginFailure);

    for (const route of routes.filter((entry) => entry.operationId !== 'login')) {
      const routeSession =
        route.operationId === 'logout'
          ? await login(ctx, 'conformance@example.com', 'correct-horse')
          : session;
      const headers = authHeaders(routeSession);
      const required = requiredHeaders(route);
      if (required.includes('If-Match')) headers['if-match'] = 'W/"1"';
      if (required.includes('Idempotency-Key')) headers['idempotency-key'] = newIdempotencyKey();

      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: requestUrl(route),
        headers,
      };
      const payload = requestPayload(route);
      if (payload !== undefined) options.payload = payload;
      const response = await ctx.app.inject(options);

      if (response.statusCode >= 400) {
        assertProblem(route, response);
      } else {
        assertSuccess(route, response);
      }
    }
  });

  test('mutations reject missing CSRF with a declared 403 problem', async () => {
    for (const route of routes.filter((entry) => entry.method !== 'get' && entry.operationId !== 'login')) {
      const headers: Record<string, string> = { cookie: session.cookie };
      if (requiredHeaders(route).includes('If-Match')) headers['if-match'] = 'W/"1"';
      if (requiredHeaders(route).includes('Idempotency-Key')) {
        headers['idempotency-key'] = newIdempotencyKey();
      }
      const options: InjectOptions = {
        method: route.method.toUpperCase() as NonNullable<InjectOptions['method']>,
        url: requestUrl(route),
        headers,
      };
      const payload = requestPayload(route);
      if (payload !== undefined) options.payload = payload;
      const response = await ctx.app.inject(options);
      expect({ route: route.operationId, status: response.statusCode }).toEqual({
        route: route.operationId,
        status: 403,
      });
      assertProblem(route, response);
    }
  });

  test('createTask returns declared 404 for an unknown project', async () => {
    const route = routeById('createTask');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Unknown project', projectId: OTHER_ID },
    });
    expect(response.statusCode).toBe(404);
    assertProblem(route, response);
  });

  test('successful responses validate against their contract schemas', async () => {
    const createProject = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Conformance project' },
    });
    expect(createProject.statusCode).toBe(201);
    expect(compile(ProjectSchema)(createProject.json())).toBe(true);

    const projectId = (createProject.json() as { id: string }).id;
    const createTask = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Conformance task', projectId },
    });
    expect(createTask.statusCode).toBe(201);
    expect(compile(TaskSchema)(createTask.json())).toBe(true);

    const listTasks = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/tasks?limit=10',
      headers: authHeaders(session),
    });
    expect(listTasks.statusCode).toBe(200);
    expect(compile(PageTaskSchema)(listTasks.json())).toBe(true);

    const listProjects = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: authHeaders(session),
    });
    expect(listProjects.statusCode).toBe(200);
    expect(compile(PageProjectSchema)(listProjects.json())).toBe(true);

    const me = await ctx.app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeaders(session) });
    expect(me.statusCode).toBe(200);
    expect(compile(UserSchema)(me.json())).toBe(true);
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

function routeById(operationId: string): RouteDefinition {
  const route = routes.find((entry) => entry.operationId === operationId);
  if (route === undefined) throw new Error(`missing route ${operationId}`);
  return route;
}

function requiredHeaders(route: RouteDefinition): readonly string[] {
  const headers = route.headers as { readonly required?: readonly string[] } | undefined;
  return headers?.required ?? [];
}

function requestUrl(route: RouteDefinition): string {
  const base = concretePath(route.path);
  return route.operationId === 'listTasks' ? `${base}?limit=0` : base;
}

function requestPayload(route: RouteDefinition): Record<string, unknown> | undefined {
  switch (route.operationId) {
    case 'createProject':
    case 'createTask':
    case 'updateMySettings':
    case 'updateTask':
      return { unexpectedField: true };
    case 'createTaskDependency':
      return { dependsOnTaskId: OTHER_ID };
    case 'login':
      return { email: 'nobody@example.com', password: 'wrong' };
    default:
      return undefined;
  }
}
