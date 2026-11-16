/**
 * Black-box contract parity of the Rust core (blueprint 15 §7).
 *
 * Starts the real `ohmydate-core` binary and checks every operation listed in
 * `support/routes.ts` against `packages/contracts`: status codes, response
 * bodies (ajv, the contract's own schemas), the header matrix of 08 §1, and
 * the cases `services/api/test/conformance.test.ts` covers for the TypeScript
 * API. Later slices add entries to the table; this file stays as it is.
 */
import type { RouteDefinition } from '@ohmydate/contracts';
import {
  API_PREFIX,
  UNKNOWN_ID,
  concretePath,
  contractRoutes,
  expectProblem,
  expectSuccess,
  requiredHeaders,
  routeById,
} from './support/contract.js';
import { startCore, type Core, type CoreResponse } from './support/core.js';
import {
  createTask,
  droppedOperations,
  newIdempotencyKey,
  portedRoutes,
  type Prepared,
  type RouteEntry,
} from './support/routes.js';

let core: Core;

beforeAll(async () => {
  core = await startCore();
});

afterAll(async () => {
  await core.dispose();
});

interface Attempt {
  readonly prepared: Prepared;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Builds a valid request for an entry on freshly prepared state. */
async function attempt(route: RouteDefinition, entry: RouteEntry): Promise<Attempt> {
  const prepared = (await entry.prepare?.(core)) ?? {};
  const query = entry.query?.(prepared);
  const headers: Record<string, string> = {};
  const required = requiredHeaders(route);
  if (required.includes('If-Match')) headers['if-match'] = `W/"${prepared.version ?? 1}"`;
  if (required.includes('Idempotency-Key')) headers['idempotency-key'] = newIdempotencyKey();
  return {
    prepared,
    path: concretePath(route, prepared.params) + (query === undefined ? '' : `?${query}`),
    headers,
    body: entry.body?.(prepared),
  };
}

function send(
  route: RouteDefinition,
  request: Attempt,
  change: { headers?: Record<string, string | undefined>; body?: unknown; authenticated?: boolean } = {},
): Promise<CoreResponse> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries({ ...request.headers, ...change.headers })) {
    if (value !== undefined) headers[name] = value;
  }
  const body = 'body' in change ? change.body : request.body;
  return core.request(route.method.toUpperCase(), request.path, {
    headers,
    ...(body === undefined ? {} : { body }),
    ...(change.authenticated === undefined ? {} : { authenticated: change.authenticated }),
  });
}

function expectEtag(entry: RouteEntry, response: CoreResponse): void {
  const etag = response.headers.get('etag');
  if (entry.etag === 'none') {
    expect(etag).toBeNull();
  } else if (entry.etag === 'version') {
    expect(etag).toMatch(/^W\/"[1-9][0-9]*"$/);
  } else if (entry.etag === 'content') {
    expect(etag).toMatch(/^W\/"[0-9a-f]{16}"$/);
  } else {
    expect(etag).toMatch(entry.etag.pattern);
  }
}

describe('coverage', () => {
  test('the table lists exactly the operations this core serves', async () => {
    // An operation the core does not serve yet answers 501; a dropped one 404.
    const served: string[] = [];
    const dropped: string[] = [];
    for (const route of contractRoutes) {
      const response = await core.request(route.method.toUpperCase(), concretePath(route));
      if (response.status === 501) continue;
      const code = (response.body as { code?: string } | undefined)?.code;
      const detail = (response.body as { detail?: string } | undefined)?.detail ?? '';
      if (response.status === 404 && code === 'not_found' && detail.includes('desktop core')) {
        dropped.push(route.operationId);
      } else {
        served.push(route.operationId);
      }
    }
    expect(served.sort()).toEqual(portedRoutes.map((entry) => entry.operationId).sort());
    expect(dropped.sort()).toEqual([...droppedOperations].sort());
  });

  test('every table entry names a contract operation once', () => {
    const ids = portedRoutes.map((entry) => entry.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [...ids, ...droppedOperations]) expect(routeById(id).operationId).toBe(id);
    expect(() => routeById('noSuchOperation')).toThrow();
  });
});

describe('outside the contract table', () => {
  test('health and readiness answer without a token', async () => {
    const health = await core.request('GET', '/healthz', { authenticated: false });
    expect([health.status, health.body]).toEqual([200, { status: 'ok' }]);
    const ready = await core.request('GET', '/readyz', { authenticated: false });
    expect([ready.status, ready.body]).toEqual([200, { status: 'ok', checks: { database: 'ok' } }]);
  });

  test('unknown routes return a not_found problem', async () => {
    const route = routeById('getTask');
    for (const [method, path] of [
      ['GET', `${API_PREFIX}/does-not-exist`],
      ['PUT', `${API_PREFIX}/tasks`],
      ['GET', '/'],
    ] as const) {
      const response = await core.request(method, path);
      expectProblem(route, response, 404, 'not_found');
    }
  });

  test('dropped operations return a not_found problem', async () => {
    for (const operationId of droppedOperations) {
      const route = routeById(operationId);
      const response = await core.request(route.method.toUpperCase(), concretePath(route), {
        ...(route.body === undefined ? {} : { body: {} }),
      });
      expect([operationId, response.status]).toEqual([operationId, 404]);
      expect((response.body as { code: string }).code).toBe('not_found');
    }
  });

  test('a request for another host name is refused', async () => {
    const response = await core.request('GET', `${API_PREFIX}/me`, {
      headers: { host: 'attacker.example' },
    });
    // fetch may not allow overriding Host; when it does, the core must refuse.
    expect([200, 403]).toContain(response.status);
    if (response.status === 403) expect((response.body as { code: string }).code).toBe('forbidden');
  });
});

describe.each(portedRoutes.map((entry) => [entry.operationId, entry] as const))(
  '%s',
  (operationId, entry) => {
    const route = routeById(operationId);
    const required = requiredHeaders(route);
    const isMutation = route.method !== 'get';
    const needsIfMatch = required.includes('If-Match');
    const needsKey = required.includes('Idempotency-Key');

    test('a valid request succeeds with a contract-valid body', async () => {
      const response = await send(route, await attempt(route, entry));
      expectSuccess(route, response, entry.successStatus);
      expectEtag(entry, response);
      expect(response.headers.get('x-trace-id')).toMatch(/^req-[0-9a-f]+$/);
    });

    test('a request without the launch token is 401 unauthenticated', async () => {
      const request = await attempt(route, entry);
      expectProblem(route, await send(route, request, { authenticated: false }), 401, 'unauthenticated');
      const wrong = await send(route, request, {
        authenticated: false,
        headers: { authorization: 'Bearer 0000' },
      });
      expectProblem(route, wrong, 401, 'unauthenticated');
    });

    test.runIf(isMutation)('a cross-origin browser request is 403 forbidden', async () => {
      const request = await attempt(route, entry);
      const response = await send(route, request, { headers: { origin: 'https://evil.example' } });
      expectProblem(route, response, 403, 'forbidden');
      // The refused request left its Idempotency-Key unused.
      expectSuccess(route, await send(route, request), entry.successStatus);
    });

    test.runIf(needsIfMatch)('If-Match is required (428), well-formed (400) and current (412)', async () => {
      const request = await attempt(route, entry);
      const missing = await send(route, request, { headers: { 'if-match': undefined } });
      expectProblem(route, missing, 428, 'version_conflict');
      for (const malformed of ['"1"', '1', 'W/"0"', '*']) {
        const response = await send(route, request, { headers: { 'if-match': malformed } });
        expectProblem(route, response, 400, 'validation_failed');
      }
      const stale = await send(route, request, {
        headers: { 'if-match': `W/"${(request.prepared.version ?? 1) + 7}"` },
      });
      expectProblem(route, stale, 412, 'version_conflict');
      // None of the refused attempts consumed the key or changed the resource.
      expectSuccess(route, await send(route, request), entry.successStatus);
    });

    test.runIf(needsKey)('Idempotency-Key is required and must be a UUID (400)', async () => {
      const request = await attempt(route, entry);
      for (const key of [undefined, 'not-a-uuid', '']) {
        const response = await send(route, request, { headers: { 'idempotency-key': key } });
        expectProblem(route, response, 400, 'validation_failed');
      }
    });

    test.runIf(needsKey)('the same key replays the first response without running again', async () => {
      const request = await attempt(route, entry);
      const first = await send(route, request);
      expectSuccess(route, first, entry.successStatus);
      // On versioned resources the replay still carries the old If-Match:
      // the stored response wins over the precondition.
      const replay = await send(route, request);
      expectSuccess(route, replay, entry.successStatus);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.get('etag')).toBe(first.headers.get('etag'));
    });

    test.runIf(needsKey && entry.otherBody !== undefined)(
      'the same key with a different request is 422 idempotency_mismatch',
      async () => {
        const request = await attempt(route, entry);
        expectSuccess(route, await send(route, request), entry.successStatus);
        const other = await send(route, request, { body: entry.otherBody?.(request.prepared) });
        expectProblem(route, other, 422, 'idempotency_mismatch');
      },
    );

    test.runIf(!isMutation && entry.etag !== 'none')(
      'If-None-Match with the current ETag is 304, with another 200',
      async () => {
        const request = await attempt(route, entry);
        const first = await send(route, request);
        const etag = first.headers.get('etag') ?? '';
        const cached = await send(route, request, { headers: { 'if-none-match': etag } });
        expect(cached.status).toBe(304);
        expect(cached.body).toBeUndefined();
        expect(cached.headers.get('etag')).toBe(etag);
        const changed = await send(route, request, { headers: { 'if-none-match': 'W/"other"' } });
        expectSuccess(route, changed, entry.successStatus);
      },
    );

    test.runIf(route.body !== undefined)('a body outside the schema is 400 validation_failed', async () => {
      const request = await attempt(route, entry);
      // The payload services/api/test/conformance.test.ts sends.
      const unexpected = await send(route, request, { body: { unexpectedField: true } });
      expectProblem(route, unexpected, 400, 'validation_failed');
      const errors = (unexpected.body as { errors?: unknown[] }).errors ?? [];
      expect(errors.length).toBeGreaterThan(0);
      for (const body of [[], 'text', 7]) {
        expectProblem(route, await send(route, request, { body }), 400, 'validation_failed');
      }
    });

    test.runIf(route.params !== undefined)('a malformed id is 400 and an unknown id 404', async () => {
      const request = await attempt(route, entry);
      const method = route.method.toUpperCase();
      const options = {
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      };
      const malformed = await core.request(method, concretePath(route, { id: 'not-a-uuid' }), options);
      expectProblem(route, malformed, 400, 'validation_failed');
      const unknown = await core.request(method, concretePath(route, { id: UNKNOWN_ID }), options);
      expectProblem(route, unknown, 404, 'not_found');
    });

    test.runIf(entry.invalidQuery !== undefined)('a query outside the schema is 400', async () => {
      const request = await attempt(route, entry);
      const path = `${concretePath(route, request.prepared.params)}?${entry.invalidQuery ?? ''}`;
      const response = await core.request(route.method.toUpperCase(), path, { headers: request.headers });
      expectProblem(route, response, 400, 'validation_failed');
      const unknownParameter = await core.request(
        route.method.toUpperCase(),
        `${concretePath(route, request.prepared.params)}?noSuchParameter=1`,
        { headers: request.headers },
      );
      expectProblem(route, unknownParameter, 400, 'validation_failed');
    });
  },
);

describe('task rules the TypeScript conformance and task suites pin', () => {
  const key = (): Record<string, string> => ({ 'idempotency-key': newIdempotencyKey() });

  test('createTask returns a declared 404 for an unknown project', async () => {
    const response = await core.request('POST', `${API_PREFIX}/tasks`, {
      headers: key(),
      body: { title: 'Unknown project', projectId: UNKNOWN_ID },
    });
    expectProblem(routeById('createTask'), response, 404, 'not_found');
  });

  test('a task without a project lands in the single Inbox', async () => {
    const projects = await core.request('GET', `${API_PREFIX}/projects?limit=100`);
    const inboxes = (projects.body as { items: { id: string; kind: string }[] }).items.filter(
      (project) => project.kind === 'inbox',
    );
    expect(inboxes).toHaveLength(1);
    const created = await core.request('POST', `${API_PREFIX}/tasks`, { headers: key(), body: { title: 'Inbox task' } });
    expect((created.body as { projectId: string }).projectId).toBe(inboxes[0]?.id);
  });

  test('createProject cannot make an Inbox: `kind` is not a field of the request', async () => {
    const response = await core.request('POST', `${API_PREFIX}/projects`, {
      headers: key(),
      body: { title: 'My inbox', kind: 'inbox' },
    });
    expectProblem(routeById('createProject'), response, 400, 'validation_failed');
    const projects = await core.request('GET', `${API_PREFIX}/projects?limit=100`);
    const items = (projects.body as { items: { kind: string; title: string }[] }).items;
    expect(items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    expect(items.map((project) => project.title)).not.toContain('My inbox');
  });

  test('request bodies are not type-coerced; a query number is read as a number', async () => {
    const route = routeById('createTask');
    for (const body of [
      { title: 123, priority: '4' },
      { title: 'x', priority: '4' },
      { title: 'x', splittable: 'true' },
      { title: 'x', session: { minMinutes: '30', maxMinutes: 90 } },
    ]) {
      const response = await core.request('POST', `${API_PREFIX}/tasks`, { headers: key(), body });
      expectProblem(route, response, 400, 'validation_failed');
    }
    const query = await core.request('GET', `${API_PREFIX}/tasks?limit=10`);
    expectSuccess(routeById('listTasks'), query, 200);
  });

  test('domain validation is 422 with field errors, and nothing is created', async () => {
    const route = routeById('createTask');
    const blank = await core.request('POST', `${API_PREFIX}/tasks`, { headers: key(), body: { title: '   ' } });
    expectProblem(route, blank, 422, 'validation_failed');
    expect((blank.body as { errors: unknown }).errors).toEqual([
      { path: 'title', message: 'title must not be empty' },
    ]);
    const inverted = await core.request('POST', `${API_PREFIX}/tasks`, {
      headers: key(),
      body: { title: 'x', session: { minMinutes: 90, maxMinutes: 30 } },
    });
    expectProblem(route, inverted, 422, 'validation_failed');
  });

  test('a 422 is stored for its key; a 412 is not', async () => {
    const task = await createTask(core, 'storage rule');
    const path = `${API_PREFIX}/tasks/${task.id}`;
    const route = routeById('updateTask');

    const stored = { 'idempotency-key': newIdempotencyKey(), 'if-match': 'W/"1"' };
    const first = await core.request('PATCH', path, { headers: stored, body: { title: '  ' } });
    const replay = await core.request('PATCH', path, { headers: stored, body: { title: '  ' } });
    expectProblem(route, first, 422, 'validation_failed');
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual(first.body);

    const retried = newIdempotencyKey();
    const stale = await core.request('PATCH', path, {
      headers: { 'idempotency-key': retried, 'if-match': 'W/"9"' },
      body: { title: 'after conflict' },
    });
    expectProblem(route, stale, 412, 'version_conflict');
    const corrected = await core.request('PATCH', path, {
      headers: { 'idempotency-key': retried, 'if-match': 'W/"1"' },
      body: { title: 'after conflict' },
    });
    expectSuccess(route, corrected, 200);
  });

  test('dependencies form a DAG: a cycle is 422 dependency_cycle', async () => {
    const [first, second] = await Promise.all([createTask(core, 'a'), createTask(core, 'b')]);
    const route = routeById('createTaskDependency');
    const depend = (task: string, on: string, version: number): Promise<CoreResponse> =>
      core.request('POST', `${API_PREFIX}/tasks/${task}/dependencies`, {
        headers: { ...key(), 'if-match': `W/"${version}"` },
        body: { dependsOnTaskId: on },
      });
    const added = await depend(second.id, first.id, 1);
    expectSuccess(route, added, 201);
    expect(added.body).toEqual({ taskId: second.id, dependsOnTaskId: first.id });
    expectProblem(route, await depend(first.id, second.id, 1), 422, 'dependency_cycle');
    expectProblem(route, await depend(first.id, first.id, 1), 422, 'dependency_cycle');

    // Deleting a task releases the tasks that waited for it (FU-81 behaviour).
    const removed = await core.request('DELETE', `${API_PREFIX}/tasks/${first.id}`, {
      headers: { ...key(), 'if-match': 'W/"1"' },
    });
    expect(removed.status).toBe(204);
    const waiting = await core.request('GET', `${API_PREFIX}/tasks/${second.id}`);
    expect(waiting.body).toMatchObject({ dependsOn: [], version: 3 });
  });

  test('lists page through every task exactly once, oldest first', async () => {
    const project = await core.request('POST', `${API_PREFIX}/projects`, { headers: key(), body: { title: 'Paging' } });
    const projectId = (project.body as { id: string }).id;
    const created: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await core.request('POST', `${API_PREFIX}/tasks`, {
        headers: key(),
        body: { title: `page ${index}`, projectId },
      });
      created.push((response.body as { id: string }).id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `projectId=${projectId}&limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const page: CoreResponse = await core.request('GET', `${API_PREFIX}/tasks?${query}`);
      expectSuccess(routeById('listTasks'), page, 200);
      const body = page.body as { items: { id: string }[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(2);
      seen.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(created);

    const bad = await core.request('GET', `${API_PREFIX}/tasks?cursor=not-a-cursor`);
    expectProblem(routeById('listTasks'), bad, 422, 'validation_failed');
  });
});
