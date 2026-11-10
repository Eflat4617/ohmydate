import { HttpResponse, http, type JsonBodyType } from 'msw';
import type { ProblemCode } from '../api/errors';
import type { Project, Task, TaskCreate, TaskPatch, TaskStatus, User } from '../api/client';
import { createUuidV7, type MockDb, type StoredResponse } from './db';

const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done'];

function problem(
  status: number,
  code: ProblemCode,
  detail: string,
  title = 'Request failed',
  headers: Record<string, string> = {},
): Response {
  return HttpResponse.json(
    { type: 'about:blank', title, status, code, detail },
    { status, headers: { 'Content-Type': 'application/problem+json', ...headers } },
  );
}

function problemBody(
  status: number,
  code: ProblemCode,
  detail: string,
  title = 'Request failed',
): { type: string; title: string; status: number; code: ProblemCode; detail: string } {
  return { type: 'about:blank', title, status, code, detail };
}

function unauthenticated(): Response {
  return problem(401, 'unauthenticated', 'Authentication is required');
}

function etag(version: number): string {
  return `W/"${version}"`;
}

function json(body: JsonBodyType, status = 200, headers: Record<string, string> = {}): Response {
  return HttpResponse.json(body, { status, headers });
}

function parseIfMatch(request: Request): { version: number } | Response {
  const header = request.headers.get('If-Match');
  if (header === null) {
    return problem(428, 'version_conflict', 'If-Match header is required');
  }
  const match = /^W\/"(\d+)"$/.exec(header);
  if (match === null) {
    return problem(400, 'validation_failed', 'If-Match must look like W/"<version>"');
  }
  return { version: Number(match[1]) };
}

interface IdempotencyToken {
  key: string;
  hash: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
    .join(',')}}`;
}

/**
 * 08 §1: the request hash is method + path + normalized body. If-Match is
 * deliberately excluded so a precondition retry can reuse the same key.
 */
function requestHash(request: Request, raw: string): string {
  const url = new URL(request.url);
  const parsed = parseBody<unknown>(raw);
  const body = parsed === undefined ? raw : canonicalize(parsed);
  return `${request.method.toUpperCase()} ${url.pathname} ${body}`;
}

function parseIdempotency(db: MockDb, request: Request, raw: string): IdempotencyToken | Response {
  const key = request.headers.get('Idempotency-Key');
  if (key === null || key.length === 0) {
    return problem(400, 'validation_failed', 'Idempotency-Key header is required');
  }
  if (db.pendingIdempotency.has(key)) {
    return problem(
      409,
      'idempotency_in_progress',
      'Another request with this Idempotency-Key is still in progress',
      'Request in progress',
      { 'Retry-After': '1' },
    );
  }
  const hash = requestHash(request, raw);
  const stored = db.idempotency.get(key);
  if (stored !== undefined) {
    if (stored.hash !== hash) {
      return problem(422, 'idempotency_mismatch', 'Idempotency-Key was reused with a different body');
    }
    return replay(stored);
  }
  return { key, hash };
}

function rememberDomainResult(
  db: MockDb,
  token: IdempotencyToken,
  status: number,
  code: ProblemCode,
  detail: string,
  title = 'Request failed',
): Response {
  const body = problemBody(status, code, detail, title);
  remember(db, token, status, body, { 'Content-Type': 'application/problem+json' });
  return HttpResponse.json(body, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

function replay(stored: StoredResponse): Response {
  if (stored.status === 204 || stored.body === null) {
    return new HttpResponse(null, { status: stored.status, headers: stored.headers });
  }
  return HttpResponse.json(stored.body as JsonBodyType, {
    status: stored.status,
    headers: stored.headers,
  });
}

function remember(
  db: MockDb,
  token: IdempotencyToken,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  db.idempotency.set(token.key, { hash: token.hash, status, body, headers });
}

function findTask(db: MockDb, taskId: string): Task | undefined {
  const task = db.tasks.get(taskId);
  if (task === undefined || task.deletedAt !== undefined) return undefined;
  return task;
}

function visibleTasks(db: MockDb): Task[] {
  return [...db.tasks.values()].filter((task) => task.deletedAt === undefined);
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function collectionEtag(
  kind: 'tasks' | 'projects',
  revision: number,
  query: Record<string, string | null>,
): string {
  const canonical = Object.keys(query)
    .sort()
    .map((key) => `${key}=${query[key] ?? ''}`)
    .join('&');
  return `W/"${kind}-${revision}-${hashString(canonical)}"`;
}

function parseBody<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function validTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200;
}

function applyTaskPatch(task: Task, patch: TaskPatch): Task {
  const updated: Task = { ...task };
  if (patch.projectId !== undefined) updated.projectId = patch.projectId;
  if (patch.title !== undefined) updated.title = patch.title;
  if (patch.status !== undefined) updated.status = patch.status;
  if (patch.splittable !== undefined) updated.splittable = patch.splittable;
  if (patch.priority !== undefined) updated.priority = patch.priority;
  if (patch.dependsOn !== undefined) updated.dependsOn = [...patch.dependsOn];
  if (patch.description !== undefined) {
    if (patch.description === null) delete updated.description;
    else updated.description = patch.description;
  }
  if (patch.dueAt !== undefined) {
    if (patch.dueAt === null) delete updated.dueAt;
    else updated.dueAt = patch.dueAt;
  }
  if (patch.session !== undefined) {
    if (patch.session === null) delete updated.session;
    else updated.session = patch.session;
  }
  updated.version = task.version + 1;
  updated.updatedAt = new Date().toISOString();
  return updated;
}

function pathExists(db: MockDb, fromId: string, targetId: string): boolean {
  const stack = [fromId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === targetId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    const task = findTask(db, current);
    if (task === undefined) continue;
    for (const dependency of task.dependsOn) stack.push(dependency);
  }
  return false;
}

function validateDependencies(
  db: MockDb,
  taskId: string,
  dependsOn: readonly string[],
): ProblemCode | null {
  for (const dependency of dependsOn) {
    if (dependency === taskId) return 'dependency_cycle';
    if (findTask(db, dependency) === undefined) return 'validation_failed';
    if (pathExists(db, dependency, taskId)) return 'dependency_cycle';
  }
  return null;
}

export function createHandlers(db: MockDb) {
  return [
    http.post('*/api/v1/auth/login', async ({ request }) => {
      const body = parseBody<{ email?: unknown; password?: unknown }>(await request.text());
      if (
        body === undefined ||
        typeof body.email !== 'string' ||
        body.email.length === 0 ||
        typeof body.password !== 'string' ||
        body.password.length === 0
      ) {
        return problem(400, 'validation_failed', 'email and password are required');
      }
      return new HttpResponse(null, {
        status: 204,
        headers: { 'Set-Cookie': 'session=mock-session; Path=/; HttpOnly; SameSite=Lax' },
      });
    }),

    http.post('*/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),

    http.get('*/api/v1/me', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const current = etag(db.user.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(db.user, 200, { ETag: current });
    }),

    http.get('*/api/v1/projects', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const items = [...db.projects.values()].slice(0, Number.isFinite(limit) ? limit : 50);
      const current = collectionEtag('projects', db.projectRevision, {
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
      });
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items, nextCursor: null }, 200, { ETag: current });
    }),

    http.post('*/api/v1/projects', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<{ title?: unknown }>(raw);
      if (body === undefined || !validTitle(body.title)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'title must be 1-200 characters');
      }
      const now = new Date().toISOString();
      const project: Project = {
        id: createUuidV7(),
        ownerId: db.user.id,
        title: body.title.trim(),
        kind: 'normal',
        archived: false,
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      db.projects.set(project.id, project);
      db.projectRevision += 1;
      remember(db, token, 201, project, { ETag: etag(project.version) });
      return json(project, 201, { ETag: etag(project.version) });
    }),

    http.get('*/api/v1/tasks', ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const url = new URL(request.url);
      const projectId = url.searchParams.get('projectId');
      const status = url.searchParams.get('status');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      if (status !== null && !TASK_STATUSES.includes(status as TaskStatus)) {
        return problem(422, 'validation_failed', 'unknown task status');
      }
      let items = visibleTasks(db);
      if (projectId !== null) items = items.filter((task) => task.projectId === projectId);
      if (status !== null) items = items.filter((task) => task.status === status);
      items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const page = items.slice(0, Number.isFinite(limit) ? limit : 50);
      const current = collectionEtag('tasks', db.taskRevision, {
        cursor: url.searchParams.get('cursor'),
        limit: url.searchParams.get('limit'),
        projectId,
        status,
      });
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json({ items: page, nextCursor: null }, 200, { ETag: current });
    }),

    http.post('*/api/v1/tasks', async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<TaskCreate>(raw);
      if (body === undefined || !validTitle(body.title)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'title must be 1-200 characters');
      }
      if (body.projectId !== undefined && !db.projects.has(body.projectId)) {
        return problem(404, 'not_found', 'projectId does not exist');
      }
      const now = new Date().toISOString();
      const taskId = createUuidV7();
      if (body.dependsOn !== undefined) {
        const failure = validateDependencies(db, taskId, body.dependsOn);
        if (failure !== null) {
          return rememberDomainResult(db, token, 422, failure, 'Invalid dependency');
        }
      }
      const task: Task = {
        id: taskId,
        ownerId: db.user.id,
        projectId: body.projectId ?? db.inboxProjectId,
        title: body.title.trim(),
        status: body.status ?? 'todo',
        splittable: body.splittable ?? true,
        priority: body.priority ?? 2,
        dependsOn: body.dependsOn === undefined ? [] : [...body.dependsOn],
        version: 1,
        createdAt: now,
        updatedAt: now,
        external: [],
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.dueAt === undefined ? {} : { dueAt: body.dueAt }),
        ...(body.session === undefined ? {} : { session: body.session }),
      };
      db.tasks.set(task.id, task);
      db.taskRevision += 1;
      remember(db, token, 201, task, { ETag: etag(task.version) });
      return json(task, 201, { ETag: etag(task.version) });
    }),

    http.get('*/api/v1/tasks/:id', ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const task = findTask(db, String(params.id));
      if (task === undefined) return problem(404, 'not_found', 'Task not found');
      const current = etag(task.version);
      if (request.headers.get('If-None-Match') === current) {
        return new HttpResponse(null, { status: 304, headers: { ETag: current } });
      }
      return json(task, 200, { ETag: current });
    }),

    http.patch('*/api/v1/tasks/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const task = findTask(db, String(params.id));
      if (task === undefined) return problem(404, 'not_found', 'Task not found');
      if (task.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${task.version}; the request used ${ifMatch.version}`,
        );
      }
      const patch = parseBody<TaskPatch>(raw);
      if (patch === undefined) return problem(400, 'validation_failed', 'Malformed JSON body');
      if (patch.title !== undefined && !validTitle(patch.title)) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'title must be 1-200 characters');
      }
      if (patch.dependsOn !== undefined) {
        const failure = validateDependencies(db, task.id, patch.dependsOn);
        if (failure !== null) {
          return rememberDomainResult(db, token, 422, failure, 'Invalid dependency');
        }
      }
      const updated = applyTaskPatch(task, patch);
      db.tasks.set(updated.id, updated);
      db.taskRevision += 1;
      remember(db, token, 200, updated, { ETag: etag(updated.version) });
      return json(updated, 200, { ETag: etag(updated.version) });
    }),

    http.post(/\/api\/v1\/tasks\/([^/]+):complete$/, async ({ request }) => {
      if (!db.authenticated) return unauthenticated();
      const match = /\/api\/v1\/tasks\/([^/]+):complete$/.exec(new URL(request.url).pathname);
      const taskId = match?.[1] === undefined ? '' : decodeURIComponent(match[1]);
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const task = findTask(db, taskId);
      if (task === undefined) return problem(404, 'not_found', 'Task not found');
      if (task.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${task.version}; the request used ${ifMatch.version}`,
        );
      }
      if (task.status === 'done') {
        return rememberDomainResult(db, token, 409, 'validation_failed', 'Task is already completed');
      }
      const updated: Task = {
        ...task,
        status: 'done',
        version: task.version + 1,
        updatedAt: new Date().toISOString(),
      };
      db.tasks.set(updated.id, updated);
      db.taskRevision += 1;
      remember(db, token, 200, updated, { ETag: etag(updated.version) });
      return json(updated, 200, { ETag: etag(updated.version) });
    }),

    http.delete('*/api/v1/tasks/:id', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const task = findTask(db, String(params.id));
      if (task === undefined) return problem(404, 'not_found', 'Task not found');
      if (task.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${task.version}; the request used ${ifMatch.version}`,
        );
      }
      const deleted: Task = {
        ...task,
        deletedAt: new Date().toISOString(),
        version: task.version + 1,
        updatedAt: new Date().toISOString(),
      };
      db.tasks.set(deleted.id, deleted);
      db.taskRevision += 1;
      remember(db, token, 204, null);
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('*/api/v1/tasks/:id/dependencies', async ({ request, params }) => {
      if (!db.authenticated) return unauthenticated();
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const ifMatch = parseIfMatch(request);
      if (ifMatch instanceof Response) return ifMatch;
      const task = findTask(db, String(params.id));
      if (task === undefined) return problem(404, 'not_found', 'Task not found');
      if (task.version !== ifMatch.version) {
        return problem(
          412,
          'version_conflict',
          `Server version is ${task.version}; the request used ${ifMatch.version}`,
        );
      }
      const body = parseBody<{ dependsOnTaskId?: string }>(raw);
      if (body === undefined || typeof body.dependsOnTaskId !== 'string') {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'dependsOnTaskId is required');
      }
      if (findTask(db, body.dependsOnTaskId) === undefined) {
        return rememberDomainResult(db, token, 422, 'validation_failed', 'dependsOnTaskId does not exist');
      }
      if (task.dependsOn.includes(body.dependsOnTaskId)) {
        return rememberDomainResult(db, token, 422, 'dependency_cycle', 'Dependency already exists');
      }
      if (body.dependsOnTaskId === task.id || pathExists(db, body.dependsOnTaskId, task.id)) {
        return rememberDomainResult(db, token, 422, 'dependency_cycle', 'Dependency would create a cycle');
      }
      const updated: Task = {
        ...task,
        dependsOn: [...task.dependsOn, body.dependsOnTaskId],
        version: task.version + 1,
        updatedAt: new Date().toISOString(),
      };
      db.tasks.set(updated.id, updated);
      db.taskRevision += 1;
      const dependency = { taskId: updated.id, dependsOnTaskId: body.dependsOnTaskId };
      remember(db, token, 201, dependency);
      return json(dependency, 201);
    }),
  ];
}

export type MockUser = User;
