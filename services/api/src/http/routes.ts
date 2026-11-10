import {
  routes,
  type LoginRequest,
  type Project as ProjectDto,
  type ProjectCreate,
  type Task as TaskDto,
  type TaskCreate,
  type TaskDependency,
  type TaskDependencyCreate,
  type TaskIdParams,
  type TaskListQuery,
  type TaskPatch,
  type User as UserDto,
  type UserSettingsPatch,
  type RouteDefinition,
} from '@ohmydate/contracts';
import { timingSafeEqual } from 'node:crypto';
import {
  DomainError,
  type Id,
  type Page,
  type Project,
  type Task,
  type TaskCreate as DomainTaskCreate,
  type TaskPatch as DomainTaskPatch,
  type TaskQuery,
  type TaskStatus,
  type Version,
} from '@ohmydate/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Clock } from '@ohmydate/domain';
import type {
  AppRepositories,
  IdempotencyStore,
  OutboxEventInput,
  SessionStore,
  UserRecord,
  UserRepository,
} from '../application/ports.js';
import { AuthService } from '../application/auth-service.js';
import { ProjectService } from '../application/project-service.js';
import { TaskService } from '../application/task-service.js';
import {
  etagForBody,
  etagForVersion,
  ifNoneMatch,
  requireIdempotencyKey,
  requireIfMatch,
  requestHash,
  headerValue,
} from './headers.js';
import { ProblemError, domainErrorToProblem, problemBodyFor } from './problem.js';

const SID_COOKIE = 'sid';
const CSRF_COOKIE = 'csrf';

export interface RouteRuntime {
  readonly config: AppConfig;
  readonly clock: Clock;
  readonly users: UserRepository;
  readonly sessions: SessionStore;
  readonly idempotency: IdempotencyStore;
  readonly auth: AuthService;
  readonly projects: ProjectService;
  readonly tasks: TaskService;
}

interface RouteMeta {
  readonly operationId: string;
  readonly public: boolean;
  readonly requiresAuth: boolean;
  readonly requiresCsrf: boolean;
  readonly requireIfMatch: boolean;
  readonly requireIdempotency: boolean;
}

interface HandlerOutcome {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly outbox?: readonly OutboxEventInput[];
}

/**
 * The contract header schemas use `additionalProperties: false` and only list
 * the API headers, so passing them to Fastify would reject Host/User-Agent etc.
 * We instead read the same required-list metadata and enforce it in
 * `buildPreHandler` using the contract's own If-Match pattern.
 */
function headerRequirements(route: RouteDefinition): readonly string[] {
  const headers = route.headers as { readonly required?: readonly string[] } | undefined;
  return headers?.required ?? [];
}

function isMutation(route: RouteDefinition): boolean {
  return route.method !== 'get';
}

function routeMeta(route: RouteDefinition): RouteMeta {
  const required = headerRequirements(route);
  const isLogin = route.operationId === 'login';
  return {
    operationId: route.operationId,
    public: isLogin,
    requiresAuth: !isLogin,
    requiresCsrf: isMutation(route) && !isLogin,
    requireIfMatch: required.includes('If-Match'),
    requireIdempotency: required.includes('Idempotency-Key'),
  };
}

function toUserDto(user: UserRecord): UserDto {
  return {
    id: user.id,
    email: user.email,
    timeZone: user.timeZone,
    locale: user.locale,
    version: user.version,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    ownerId: project.ownerId,
    title: project.title,
    kind: project.kind ?? 'normal',
    archived: project.archived,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function toTaskDto(task: Task): TaskDto {
  return {
    id: task.id,
    ownerId: task.ownerId,
    projectId: task.projectId,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    status: task.status,
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    splittable: task.splittable,
    ...(task.session === undefined
      ? {}
      : { session: { minMinutes: task.session.minMinutes, maxMinutes: task.session.maxMinutes } }),
    priority: task.priority,
    dependsOn: [...task.dependsOn],
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.deletedAt === undefined ? {} : { deletedAt: task.deletedAt }),
    external: task.external.map((ref) => ({ provider: ref.provider, externalId: ref.externalId })),
  };
}

function toTaskPageDto(page: Page<Task>): { items: TaskDto[]; nextCursor: string | null } {
  return { items: page.items.map((task) => toTaskDto(task)), nextCursor: page.nextCursor };
}

function toProjectPageDto(page: Page<Project>): { items: ProjectDto[]; nextCursor: string | null } {
  return { items: page.items.map((project) => toProjectDto(project)), nextCursor: page.nextCursor };
}

function toDomainTaskCreate(input: TaskCreate): DomainTaskCreate {
  return input as unknown as DomainTaskCreate;
}

function toDomainTaskPatch(input: TaskPatch): DomainTaskPatch {
  return input as unknown as DomainTaskPatch;
}

function toTaskQuery(query: TaskListQuery): TaskQuery {
  return {
    ...(query.projectId === undefined ? {} : { projectId: query.projectId as Id }),
    ...(query.status === undefined ? {} : { status: query.status as TaskStatus }),
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}

function currentAuth(request: FastifyRequest) {
  if (request.authSession === null) {
    throw new ProblemError({
      status: 401,
      code: 'unauthenticated',
      title: 'Unauthenticated',
      detail: 'a valid session cookie is required',
    });
  }
  return request.authSession;
}

function timingSafeStringEqual(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  if (leftBytes.length !== rightBytes.length) return false;
  return timingSafeEqual(leftBytes, rightBytes);
}

function verifyCsrf(request: FastifyRequest): void {
  const auth = currentAuth(request);
  const header = headerValue(request, 'x-csrf-token');
  const cookie = request.cookies[CSRF_COOKIE];
  if (
    !timingSafeStringEqual(header, cookie) ||
    !timingSafeStringEqual(header, auth.csrfToken)
  ) {
    throw new ProblemError({
      status: 403,
      code: 'forbidden',
      title: 'CSRF validation failed',
      detail: 'X-CSRF-Token must match the csrf cookie and the session',
    });
  }
}

function setSessionCookies(
  reply: FastifyReply,
  session: { readonly id: string; readonly csrfToken: string },
  config: AppConfig,
): void {
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  reply.setCookie(SID_COOKIE, session.id, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge,
  });
  reply.setCookie(CSRF_COOKIE, session.csrfToken, {
    path: '/',
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: 'lax',
    maxAge,
  });
}

function clearSessionCookies(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(SID_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'lax' });
  reply.clearCookie(CSRF_COOKIE, { path: '/', secure: config.cookieSecure, sameSite: 'lax' });
}

function applyHeaders(reply: FastifyReply, headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) reply.header(name, value);
}

function sendOutcome(reply: FastifyReply, outcome: HandlerOutcome): FastifyReply {
  reply.code(outcome.status);
  if (outcome.headers !== undefined) applyHeaders(reply, outcome.headers);
  if (outcome.status === 204 || outcome.body === undefined) return reply.send();
  return reply.send(outcome.body);
}

/**
 * Idempotency (08 §1, ADR-016 §2): reserve pending before the use-case runs,
 * replay completed responses, 409 while another identical key is in flight.
 */
async function runIdempotent(
  runtime: RouteRuntime,
  request: FastifyRequest,
  reply: FastifyReply,
  operation: () => Promise<HandlerOutcome>,
): Promise<FastifyReply> {
  const auth = currentAuth(request);
  const key = requireIdempotencyKey(request);
  const route = request.routeOptions.url ?? request.url;
  const reservation = await runtime.idempotency.reserve({
    ownerId: auth.userId,
    key,
    route,
    requestHash: requestHash(request, request.body),
  });

  if (reservation.kind === 'mismatch') {
    throw new ProblemError({
      status: 422,
      code: 'idempotency_mismatch',
      title: 'Idempotency key reuse',
      detail: 'the same Idempotency-Key was used with a different request',
    });
  }
  if (reservation.kind === 'pending') {
    throw new ProblemError({
      status: 409,
      code: 'idempotency_in_progress',
      title: 'Idempotency key in progress',
      detail: 'another request with this Idempotency-Key is still pending',
      headers: { 'Retry-After': '1' },
    });
  }
  if (reservation.kind === 'replay') {
    reply.code(reservation.response.status);
    applyHeaders(reply, reservation.response.headers);
    if (
      reservation.response.status === 204 ||
      reservation.response.body === null ||
      reservation.response.body === undefined
    ) {
      return reply.send();
    }
    return reply.send(reservation.response.body);
  }

  try {
    const outcome = await operation();
    await runtime.idempotency.complete({
      ownerId: auth.userId,
      key,
      response: {
        status: outcome.status,
        body: outcome.body ?? null,
        headers: outcome.headers ?? {},
      },
      outbox: outcome.outbox ?? [],
    });
    return sendOutcome(reply, outcome);
  } catch (error) {
    // 08 §1 pinned storage rule: 409/422 domain results are stored and replayed
    // with no outbox rows; everything else releases the reservation.
    const releaseQuietly = async (): Promise<void> => {
      try {
        await runtime.idempotency.release(auth.userId, key);
      } catch {
        // Always surface the original failure; a failed release is recoverable.
        // Log key metadata only: request bodies and headers stay out of logs.
        request.log.warn(
          { ownerId: auth.userId, key, route },
          'idempotency release failed',
        );
      }
    };

    if (error instanceof DomainError) {
      const problem = domainErrorToProblem(error);
      if (problem.status === 409 || problem.status === 422) {
        try {
          await runtime.idempotency.complete({
            ownerId: auth.userId,
            key,
            response: {
              status: problem.status,
              body: problemBodyFor(request, problem),
              headers: { 'Content-Type': 'application/problem+json' },
            },
            outbox: [],
          });
        } catch {
          await releaseQuietly();
        }
      } else {
        await releaseQuietly();
      }
    } else {
      await releaseQuietly();
    }
    throw error;
  }
}

function buildHandlers(runtime: RouteRuntime): Record<string, (request: FastifyRequest, reply: FastifyReply) => Promise<FastifyReply>> {
  const userSettings = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const expected = requireIfMatch(request);
      const patch = request.body as UserSettingsPatch;
      const user = await runtime.auth.updateSettings(
        auth.userId,
        {
          ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
          ...(patch.locale === undefined ? {} : { locale: patch.locale }),
        },
        expected,
      );
      return {
        status: 200,
        body: toUserDto(user),
        headers: { ETag: etagForVersion(user.version) },
      };
    });

  const createProject = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const key = requireIdempotencyKey(request);
      const input = request.body as ProjectCreate;
      const project = await runtime.projects.create(auth.userId, { title: input.title }, key);
      return {
        status: 201,
        body: toProjectDto(project),
        headers: { ETag: etagForVersion(project.version) },
      };
    });

  const createTask = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const key = requireIdempotencyKey(request);
      const input = request.body as TaskCreate;
      if (input.projectId === undefined) {
        await runtime.projects.ensureInbox(auth.userId);
      }
      const task = await runtime.tasks.create(
        auth.userId,
        toDomainTaskCreate(input),
        key,
      );
      return {
        status: 201,
        body: toTaskDto(task),
        headers: { ETag: etagForVersion(task.version) },
        outbox: [{ topic: 'task.created', taskId: task.id, version: task.version }],
      };
    });

  const updateTask = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const id = (request.params as TaskIdParams).id as Id;
      const expected = requireIfMatch(request) as Version;
      const task = await runtime.tasks.update(
        auth.userId,
        id,
        toDomainTaskPatch(request.body as TaskPatch),
        expected,
      );
      return {
        status: 200,
        body: toTaskDto(task),
        headers: { ETag: etagForVersion(task.version) },
        outbox: [{ topic: 'task.updated', taskId: task.id, version: task.version }],
      };
    });

  const completeTask = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const id = (request.params as TaskIdParams).id as Id;
      const expected = requireIfMatch(request) as Version;
      const task = await runtime.tasks.complete(auth.userId, id, expected);
      return {
        status: 200,
        body: toTaskDto(task),
        headers: { ETag: etagForVersion(task.version) },
        outbox:
          task.version === expected
            ? []
            : [{ topic: 'task.completed', taskId: task.id, version: task.version }],
      };
    });

  const deleteTask = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const id = (request.params as TaskIdParams).id as Id;
      const expected = requireIfMatch(request) as Version;
      const version = await runtime.tasks.remove(auth.userId, id, expected);
      return {
        status: 204,
        outbox: [{ topic: 'task.deleted', taskId: id, version }],
      };
    });

  const createTaskDependency = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const id = (request.params as TaskIdParams).id as Id;
      const expected = requireIfMatch(request) as Version;
      const input = request.body as TaskDependencyCreate;
      const result = await runtime.tasks.addDependency(
        auth.userId,
        id,
        input.dependsOnTaskId as Id,
        expected,
      );
      const body: TaskDependency = {
        taskId: result.taskId,
        dependsOnTaskId: result.dependsOnTaskId,
      };
      return {
        status: 201,
        body,
        headers: { ETag: etagForVersion(result.version) },
        outbox: [{ topic: 'task.updated', taskId: result.taskId, version: result.version }],
      };
    });

  return {
    login: async (request, reply) => {
      const body = request.body as LoginRequest;
      const { session } = await runtime.auth.login(body.email, body.password, request.ip);
      setSessionCookies(reply, session, runtime.config);
      return reply.code(204).send();
    },
    logout: async (request, reply) => {
      const auth = currentAuth(request);
      await runtime.auth.logout(auth.sessionId);
      clearSessionCookies(reply, runtime.config);
      return reply.code(204).send();
    },
    getMe: async (request, reply) => {
      const auth = currentAuth(request);
      const user = await runtime.auth.me(auth.userId);
      const etag = etagForVersion(user.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(toUserDto(user));
    },
    updateMySettings: userSettings,
    listProjects: async (request, reply) => {
      const auth = currentAuth(request);
      const query = request.query as { cursor?: string; limit?: number };
      const page = await runtime.projects.list(auth.userId, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      const body = toProjectPageDto(page);
      const etag = etagForBody(body);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(body);
    },
    createProject,
    listTasks: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.tasks.list(
        auth.userId,
        toTaskQuery(request.query as TaskListQuery),
      );
      const body = toTaskPageDto(page);
      const etag = etagForBody(body);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(body);
    },
    createTask,
    getTask: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as TaskIdParams).id as Id;
      const task = await runtime.tasks.get(auth.userId, id);
      if (task === null) {
        throw new ProblemError({
          status: 404,
          code: 'not_found',
          title: 'Not found',
          detail: `task not found: ${id}`,
        });
      }
      const etag = etagForVersion(task.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(toTaskDto(task));
    },
    updateTask,
    completeTask,
    deleteTask,
    createTaskDependency,
  };
}

/**
 * `/tasks/{id}:complete` -> `/tasks/:id([^:]+)::complete`. find-my-way needs the
 * `::` escape for a static action suffix; the bare `:id:complete` form would
 * swallow every POST /tasks/<x> (including /tasks/<id> and other actions).
 */
export function toFastifyPath(path: string): string {
  const withActions = path.replace(
    /\{([^}]+)\}:([A-Za-z][A-Za-z0-9]*)$/,
    ':$1([^:]+)::$2',
  );
  return withActions.replace(/\{([^}]+)\}/g, ':$1');
}

function stripSchemaMeta<T>(schema: T): T {
  if (Array.isArray(schema)) return schema.map((entry) => stripSchemaMeta(entry)) as T;
  if (schema !== null && typeof schema === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === '$id') continue;
      output[key] = stripSchemaMeta(value);
    }
    return output as T;
  }
  return schema;
}

function responseSchemas(route: RouteDefinition): Record<string, object> {
  const schemas: Record<string, object> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    if (response.schema === undefined) continue;
    schemas[status] = stripSchemaMeta(response.schema) as object;
  }
  return schemas;
}

/**
 * Ajv coercion is disabled so request bodies keep their JSON types. Only the
 * numeric query fields from the contract need string -> number conversion.
 */
function coerceQueryParameters(request: FastifyRequest): void {
  const query = request.query;
  if (query === null || typeof query !== 'object') return;
  const record = query as Record<string, unknown>;
  const limit = record['limit'];
  if (typeof limit === 'string' && /^-?\d+$/.test(limit)) {
    record['limit'] = Number(limit);
  }
}

function buildPreHandler(runtime: RouteRuntime, meta: RouteMeta) {
  return async function preHandler(request: FastifyRequest): Promise<void> {
    coerceQueryParameters(request);
    if (meta.requiresAuth) {
      const sessionId = request.cookies[SID_COOKIE];
      if (sessionId === undefined || sessionId === '') {
        throw new ProblemError({
          status: 401,
          code: 'unauthenticated',
          title: 'Unauthenticated',
          detail: 'a valid session cookie is required',
        });
      }
      const session = await runtime.sessions.touch(sessionId);
      if (session === null) {
        throw new ProblemError({
          status: 401,
          code: 'unauthenticated',
          title: 'Unauthenticated',
          detail: 'the session is missing or expired',
        });
      }
      request.authSession = {
        sessionId: session.id,
        userId: session.userId,
        csrfToken: session.csrfToken,
      };
    }
    if (meta.requiresCsrf) verifyCsrf(request);
    if (meta.requireIfMatch) requireIfMatch(request);
    if (meta.requireIdempotency) requireIdempotencyKey(request);
  };
}

export function registerRoutes(app: FastifyInstance, runtime: RouteRuntime): void {
  const handlers = buildHandlers(runtime);
  for (const route of routes) {
    const meta = routeMeta(route);
    const handler = handlers[meta.operationId];
    if (handler === undefined) {
      throw new Error(`no handler registered for operation ${meta.operationId}`);
    }
    const schema: Record<string, unknown> = { response: responseSchemas(route) };
    if (route.params !== undefined) schema['params'] = stripSchemaMeta(route.params);
    if (route.body !== undefined) schema['body'] = stripSchemaMeta(route.body);
    if (route.query !== undefined) schema['querystring'] = stripSchemaMeta(route.query);

    app.route({
      method: route.method.toUpperCase() as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      url: toFastifyPath(route.path),
      schema: schema as never,
      preValidation: buildPreHandler(runtime, meta),
      handler,
    });
  }
}

export function createRuntime(options: {
  config: AppConfig;
  clock: Clock;
  users: UserRepository;
  sessions: SessionStore;
  idempotency: IdempotencyStore;
  auth: AuthService;
  repos: AppRepositories;
}): RouteRuntime {
  return {
    config: options.config,
    clock: options.clock,
    users: options.users,
    sessions: options.sessions,
    idempotency: options.idempotency,
    auth: options.auth,
    projects: new ProjectService(options.repos.projects),
    tasks: new TaskService(options.repos.tasks),
  };
}

