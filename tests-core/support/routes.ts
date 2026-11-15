import { randomUUID } from 'node:crypto';
import type { Core } from './core.js';
import { API_PREFIX } from './contract.js';

/** State one request needs, created fresh for every check. */
export interface Prepared {
  /** Values for the parameters of the path template. */
  readonly params?: Readonly<Record<string, string>>;
  /** Current version of the resource the request changes (for `If-Match`). */
  readonly version?: number;
  /** Other ids the request builders need. */
  readonly data?: Readonly<Record<string, string>>;
}

/**
 * One ported operation. The generic suite in `parity.test.ts` derives
 * everything else — method, path, required headers, schemas, declared
 * statuses — from the contract, so porting a route means adding one entry.
 */
export interface RouteEntry {
  readonly operationId: string;
  /** Status of a valid request. */
  readonly successStatus: number;
  /**
   * What the success response's `ETag` is: the resource version
   * (`W/"<n>"`), a content hash of a list (`W/"<16 hex>"`), another tag
   * (`pattern`), or no tag at all.
   */
  readonly etag: 'version' | 'content' | 'none' | { readonly pattern: RegExp };
  /** Creates the resources a single request needs. */
  readonly prepare?: (core: Core) => Promise<Prepared>;
  /** Query string of a valid request, without `?`. */
  readonly query?: (prepared: Prepared) => string;
  /** Body of a valid request. */
  readonly body?: (prepared: Prepared) => unknown;
  /** A different valid body; proves `idempotency_mismatch`. */
  readonly otherBody?: (prepared: Prepared) => unknown;
  /** A query string the contract rejects. */
  readonly invalidQuery?: string;
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

interface TaskDto {
  readonly id: string;
  readonly version: number;
}

/** Creates a task through the API and returns it. */
export async function createTask(core: Core, title: string): Promise<TaskDto> {
  const response = await core.request('POST', `${API_PREFIX}/tasks`, {
    headers: { 'idempotency-key': newIdempotencyKey() },
    body: { title },
  });
  if (response.status !== 201) {
    throw new Error(`could not create a task: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body as TaskDto;
}

async function oneTask(core: Core): Promise<Prepared> {
  const task = await createTask(core, 'parity task');
  return { params: { id: task.id }, version: task.version };
}

interface ProjectDto {
  readonly id: string;
  readonly version: number;
}

/** Creates a normal project (a folder) through the API and returns it. */
export async function createProject(core: Core, title: string): Promise<ProjectDto> {
  const response = await core.request('POST', `${API_PREFIX}/projects`, {
    headers: { 'idempotency-key': newIdempotencyKey() },
    body: { title },
  });
  if (response.status !== 201) {
    throw new Error(`could not create a project: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body as ProjectDto;
}

async function oneProject(core: Core): Promise<Prepared> {
  const project = await createProject(core, 'parity folder');
  return { params: { id: project.id }, version: project.version };
}

/**
 * Operations served by the Rust core, in the order they were ported.
 * The suite fails when the core serves an operation that is missing here.
 */
export const portedRoutes: readonly RouteEntry[] = [
  // RC-00 — walking skeleton: owner, projects, tasks.
  {
    operationId: 'getMe',
    successStatus: 200,
    etag: { pattern: /^W\/"[0-9a-f-]{36}:[1-9][0-9]*"$/ },
  },
  {
    operationId: 'listProjects',
    successStatus: 200,
    etag: 'content',
    query: () => 'limit=5',
    invalidQuery: 'limit=0',
  },
  {
    operationId: 'createProject',
    successStatus: 201,
    etag: 'version',
    body: () => ({ title: 'Parity project' }),
    otherBody: () => ({ title: 'Another project' }),
  },
  {
    operationId: 'listTasks',
    successStatus: 200,
    etag: 'content',
    prepare: async (core) => {
      await createTask(core, 'listed task');
      return {};
    },
    query: () => 'limit=10&status=todo',
    invalidQuery: 'limit=0',
  },
  {
    operationId: 'createTask',
    successStatus: 201,
    etag: 'version',
    body: () => ({
      title: 'Parity task',
      description: 'created by the parity harness',
      dueAt: '2026-11-20T23:59:00+09:00',
      splittable: true,
      session: { minMinutes: 30, maxMinutes: 90 },
      priority: 1,
    }),
    otherBody: () => ({ title: 'A different task' }),
  },
  {
    operationId: 'getTask',
    successStatus: 200,
    etag: 'version',
    prepare: oneTask,
  },
  {
    operationId: 'updateTask',
    successStatus: 200,
    etag: 'version',
    prepare: oneTask,
    body: () => ({ title: 'Renamed', status: 'in_progress', dueAt: null }),
    otherBody: () => ({ title: 'Renamed differently' }),
  },
  {
    operationId: 'completeTask',
    successStatus: 200,
    etag: 'version',
    prepare: oneTask,
  },
  {
    operationId: 'deleteTask',
    successStatus: 204,
    etag: 'none',
    prepare: oneTask,
  },
  {
    operationId: 'createTaskDependency',
    successStatus: 201,
    etag: 'version',
    prepare: async (core) => {
      const [first, second, waiting] = await Promise.all([
        createTask(core, 'first'),
        createTask(core, 'second'),
        createTask(core, 'waiting'),
      ]);
      return {
        params: { id: waiting.id },
        version: waiting.version,
        data: { first: first.id, second: second.id },
      };
    },
    body: (prepared) => ({ dependsOnTaskId: prepared.data?.['first'] }),
    otherBody: (prepared) => ({ dependsOnTaskId: prepared.data?.['second'] }),
  },
  // FOLD-01 — rename and archive a folder. Its own rules: `projects.test.ts`.
  {
    operationId: 'updateProject',
    successStatus: 200,
    etag: 'version',
    prepare: oneProject,
    body: () => ({ title: 'Renamed folder', archived: true }),
    otherBody: () => ({ title: 'Renamed differently' }),
  },
];

/**
 * Contract operations the desktop core does not serve by design
 * (blueprint 15 §2): they answer 404 like an unknown route.
 */
export const droppedOperations: readonly string[] = [
  'login',
  'logout',
  'createPushSubscription',
  'deletePushSubscription',
];
