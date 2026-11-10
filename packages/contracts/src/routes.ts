import { Type, type TSchema } from '@sinclair/typebox';
import {
  LoginRequestSchema,
  UserSchema,
  UserSettingsPatchSchema,
} from './auth.js';
import {
  CursorSchema,
  IdempotencyKeyHeaderSchema,
  IfMatchHeaderSchema,
} from './common.js';
import { ProblemSchema } from './problem.js';
import {
  PageProjectSchema,
  ProjectCreateSchema,
  ProjectSchema,
  ProjectPatchSchema,
} from './project.js';
import {
  PageTaskSchema,
  TaskCreateSchema,
  TaskDependencyCreateSchema,
  TaskDependencySchema,
  TaskIdParamsSchema,
  TaskListQuerySchema,
  TaskPatchSchema,
  TaskSchema,
} from './task.js';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

export interface RouteResponse {
  readonly description: string;
  readonly schema?: TSchema;
}

export interface RouteDefinition {
  readonly method: HttpMethod;
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly params?: TSchema;
  readonly query?: TSchema;
  readonly headers?: TSchema;
  readonly body?: TSchema;
  readonly responses: Readonly<Record<number, RouteResponse>>;
}

const PROBLEM_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: 'Malformed request',
  401: 'Unauthenticated',
  403: 'Forbidden',
  404: 'Not found',
  409: 'State conflict',
  412: 'Version precondition failed',
  422: 'Domain validation failed',
  428: 'If-Match header required',
  429: 'Rate limited',
  503: 'Provider unavailable',
};

function problems(...statuses: readonly number[]): Record<number, RouteResponse> {
  const responses: Record<number, RouteResponse> = {};
  for (const status of statuses) {
    responses[status] = {
      description: PROBLEM_DESCRIPTIONS[status] ?? 'Error',
      schema: ProblemSchema,
    };
  }
  return responses;
}

const IfMatchHeadersSchema = Type.Object(
  {
    'If-Match': IfMatchHeaderSchema,
  },
  { additionalProperties: false, required: ['If-Match'] },
);

const IdempotencyHeadersSchema = Type.Object(
  {
    'Idempotency-Key': IdempotencyKeyHeaderSchema,
  },
  { additionalProperties: false, required: ['Idempotency-Key'] },
);

const PageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'PageQuery' },
);

export const routes: readonly RouteDefinition[] = [
  {
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Create a session cookie',
    body: LoginRequestSchema,
    responses: {
      204: { description: 'Session created' },
      ...problems(400, 401, 429, 503),
    },
  },
  {
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: 'Destroy the current session',
    responses: {
      204: { description: 'Session destroyed' },
      ...problems(401),
    },
  },
  {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Read the current user',
    responses: {
      200: { description: 'Current user', schema: UserSchema },
      304: { description: 'Not modified' },
      ...problems(401),
    },
  },
  {
    method: 'patch',
    path: '/me/settings',
    operationId: 'updateMySettings',
    summary: 'Update user settings',
    headers: IfMatchHeadersSchema,
    body: UserSettingsPatchSchema,
    responses: {
      200: { description: 'Updated user', schema: UserSchema },
      ...problems(400, 401, 404, 412, 422, 428, 503),
    },
  },
  {
    method: 'get',
    path: '/projects',
    operationId: 'listProjects',
    summary: 'List projects',
    query: PageQuerySchema,
    responses: {
      200: { description: 'Project page', schema: PageProjectSchema },
      ...problems(401, 422),
    },
  },
  {
    method: 'post',
    path: '/projects',
    operationId: 'createProject',
    summary: 'Create a project',
    headers: IdempotencyHeadersSchema,
    body: ProjectCreateSchema,
    responses: {
      201: { description: 'Created project', schema: ProjectSchema },
      ...problems(400, 401, 409, 422, 503),
    },
  },
  {
    method: 'get',
    path: '/tasks',
    operationId: 'listTasks',
    summary: 'List tasks',
    query: TaskListQuerySchema,
    responses: {
      200: { description: 'Task page', schema: PageTaskSchema },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'post',
    path: '/tasks',
    operationId: 'createTask',
    summary: 'Create a task',
    headers: IdempotencyHeadersSchema,
    body: TaskCreateSchema,
    responses: {
      201: { description: 'Created task', schema: TaskSchema },
      ...problems(400, 401, 422, 503),
    },
  },
  {
    method: 'get',
    path: '/tasks/{id}',
    operationId: 'getTask',
    summary: 'Read a task',
    params: TaskIdParamsSchema,
    responses: {
      200: { description: 'Task', schema: TaskSchema },
      304: { description: 'Not modified' },
      ...problems(401, 404),
    },
  },
  {
    method: 'patch',
    path: '/tasks/{id}',
    operationId: 'updateTask',
    summary: 'Update a task',
    params: TaskIdParamsSchema,
    headers: IfMatchHeadersSchema,
    body: TaskPatchSchema,
    responses: {
      200: { description: 'Updated task', schema: TaskSchema },
      ...problems(400, 401, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/tasks/{id}:complete',
    operationId: 'completeTask',
    summary: 'Complete a task',
    params: TaskIdParamsSchema,
    headers: IfMatchHeadersSchema,
    responses: {
      200: { description: 'Completed task', schema: TaskSchema },
      ...problems(401, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'delete',
    path: '/tasks/{id}',
    operationId: 'deleteTask',
    summary: 'Soft delete a task',
    params: TaskIdParamsSchema,
    headers: IfMatchHeadersSchema,
    responses: {
      204: { description: 'Task deleted' },
      ...problems(401, 404, 409, 412, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/tasks/{id}/dependencies',
    operationId: 'createTaskDependency',
    summary: 'Add a task dependency',
    params: TaskIdParamsSchema,
    headers: IdempotencyHeadersSchema,
    body: TaskDependencyCreateSchema,
    responses: {
      201: { description: 'Created dependency', schema: TaskDependencySchema },
      ...problems(400, 401, 404, 409, 422, 503),
    },
  },
];

export const schemaRegistry = {
  Problem: ProblemSchema,
  ProjectCreate: ProjectCreateSchema,
  Project: ProjectSchema,
  ProjectPatch: ProjectPatchSchema,
  PageProject: PageProjectSchema,
  Task: TaskSchema,
  TaskCreate: TaskCreateSchema,
  TaskPatch: TaskPatchSchema,
  PageTask: PageTaskSchema,
  TaskListQuery: TaskListQuerySchema,
  TaskIdParams: TaskIdParamsSchema,
  TaskDependencyCreate: TaskDependencyCreateSchema,
  TaskDependency: TaskDependencySchema,
  LoginRequest: LoginRequestSchema,
  User: UserSchema,
  UserSettingsPatch: UserSettingsPatchSchema,
} as const;

export type SchemaRegistry = typeof schemaRegistry;
