import { routes } from '../src/index.js';

const keyOf = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

test('route table covers auth and account endpoints from 08 §2.1', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'POST /auth/login',
    'POST /auth/logout',
    'GET /me',
    'PATCH /me/settings',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('route table covers task and project endpoints from 08 §2.2', () => {
  const keys = new Set(routes.map((route) => keyOf(route.method, route.path)));
  for (const expected of [
    'GET /projects',
    'POST /projects',
    'GET /tasks',
    'POST /tasks',
    'GET /tasks/{id}',
    'PATCH /tasks/{id}',
    'POST /tasks/{id}:complete',
    'DELETE /tasks/{id}',
    'POST /tasks/{id}/dependencies',
  ]) {
    expect({ expected, present: keys.has(expected) }).toEqual({ expected, present: true });
  }
});

test('problem responses cover the required error statuses', () => {
  const statuses = new Set<number>();
  for (const route of routes) {
    for (const status of Object.keys(route.responses)) statuses.add(Number(status));
  }
  for (const status of [400, 401, 404, 409, 412, 422, 428, 503]) {
    expect({ status, present: statuses.has(status) }).toEqual({ status, present: true });
  }
});

test('mutating routes require If-Match or Idempotency-Key headers', () => {
  for (const route of routes) {
    if (route.method === 'get' || route.path === '/auth/login' || route.path === '/auth/logout') {
      continue;
    }
    expect({ route: `${route.method} ${route.path}`, hasHeaders: route.headers !== undefined }).toEqual(
      { route: `${route.method} ${route.path}`, hasHeaders: true },
    );
  }
});

test('every route declares an operation id and at least one response', () => {
  const operationIds = new Set<string>();
  for (const route of routes) {
    expect(route.operationId.length).toBeGreaterThan(0);
    expect(Object.keys(route.responses).length).toBeGreaterThan(0);
    expect(operationIds.has(route.operationId)).toBe(false);
    operationIds.add(route.operationId);
  }
});
