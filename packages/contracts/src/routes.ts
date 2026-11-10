import { Type, type TSchema } from '@sinclair/typebox';
import { LoginRequestSchema, UserSchema, UserSettingsPatchSchema } from './auth.js';
import {
  CursorSchema,
  IdempotencyKeyHeaderSchema,
  IfMatchHeaderSchema,
  IfNoneMatchHeaderSchema,
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
import {
  DecompositionDraftPatchSchema,
  DecompositionDraftSchema,
  DecompositionEstimateSchema,
  DecompositionStepSchema,
  IntakeAnswerSchema,
  IntakeAnswersRequestSchema,
  IntakeAssumptionSchema,
  IntakeDetectedTypeSchema,
  IntakeErrorSchema,
  IntakeInputSchema,
  IntakeSessionCreateSchema,
  IntakeSessionIdParamsSchema,
  IntakeSessionSchema,
  IntakeTypeConfirmationSchema,
  PlannedQuestionSchema,
} from './intake.js';
import {
  PageTaskTemplateSchema,
  TaskTemplateIdParamsSchema,
  TaskTemplateListQuerySchema,
  TaskTemplateSchema,
  TemplateStatsSchema,
} from './template.js';

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
  500: 'Internal error',
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

const IdempotencyHeadersSchema = Type.Object(
  {
    'Idempotency-Key': IdempotencyKeyHeaderSchema,
  },
  { additionalProperties: false, required: ['Idempotency-Key'] },
);

const IfMatchAndIdempotencyHeadersSchema = Type.Object(
  {
    'If-Match': IfMatchHeaderSchema,
    'Idempotency-Key': IdempotencyKeyHeaderSchema,
  },
  { additionalProperties: false, required: ['If-Match', 'Idempotency-Key'] },
);

const IfNoneMatchHeadersSchema = Type.Object(
  {
    'If-None-Match': Type.Optional(IfNoneMatchHeaderSchema),
  },
  { additionalProperties: false },
);

const PageQuerySchema = Type.Object(
  {
    cursor: Type.Optional(CursorSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false, $id: 'PageQuery' },
);

const coreRoutes: readonly RouteDefinition[] = [
  {
    method: 'post',
    path: '/auth/login',
    operationId: 'login',
    summary: 'Create a session cookie',
    body: LoginRequestSchema,
    responses: {
      204: { description: 'Session created' },
      ...problems(400, 401, 429),
    },
  },
  {
    method: 'post',
    path: '/auth/logout',
    operationId: 'logout',
    summary: 'Destroy the current session',
    responses: {
      204: { description: 'Session destroyed' },
      ...problems(401, 403),
    },
  },
  {
    method: 'get',
    path: '/me',
    operationId: 'getMe',
    summary: 'Read the current user',
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Current user', schema: UserSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401),
    },
  },
  {
    method: 'patch',
    path: '/me/settings',
    operationId: 'updateMySettings',
    summary: 'Update user settings',
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: UserSettingsPatchSchema,
    responses: {
      200: { description: 'Updated user', schema: UserSchema },
      ...problems(400, 401, 403, 409, 412, 422, 428),
    },
  },
  {
    method: 'get',
    path: '/projects',
    operationId: 'listProjects',
    summary: 'List projects',
    query: PageQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Project page', schema: PageProjectSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
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
      ...problems(400, 401, 403, 409, 422),
    },
  },
  {
    method: 'get',
    path: '/tasks',
    operationId: 'listTasks',
    summary: 'List tasks',
    query: TaskListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Task page', schema: PageTaskSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422, 503),
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
      ...problems(400, 401, 403, 404, 409, 422, 503),
    },
  },
  {
    method: 'get',
    path: '/tasks/{id}',
    operationId: 'getTask',
    summary: 'Read a task',
    params: TaskIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Task', schema: TaskSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404, 503),
    },
  },
  {
    method: 'patch',
    path: '/tasks/{id}',
    operationId: 'updateTask',
    summary: 'Update a task',
    params: TaskIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: TaskPatchSchema,
    responses: {
      200: { description: 'Updated task', schema: TaskSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/tasks/{id}:complete',
    operationId: 'completeTask',
    summary: 'Complete a task',
    params: TaskIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Completed task', schema: TaskSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'delete',
    path: '/tasks/{id}',
    operationId: 'deleteTask',
    summary: 'Soft delete a task',
    params: TaskIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      204: { description: 'Task deleted' },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/tasks/{id}/dependencies',
    operationId: 'createTaskDependency',
    summary: 'Add a task dependency',
    params: TaskIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: TaskDependencyCreateSchema,
    responses: {
      201: { description: 'Created dependency', schema: TaskDependencySchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
];

/**
 * Intake and template routes (08 §2.3).
 *
 * M2-03 wires the handlers for every operation below, so `routes` (the
 * registered table) includes them after `coreRoutes`. `contractRoutes` remains
 * the single source consumed by the generator and contract tests.
 */
export const intakeRoutes: readonly RouteDefinition[] = [
  {
    method: 'post',
    path: '/intake-sessions',
    operationId: 'createIntakeSession',
    summary: 'Start an intake interview',
    headers: IdempotencyHeadersSchema,
    body: IntakeSessionCreateSchema,
    responses: {
      201: { description: 'Intake session created', schema: IntakeSessionSchema },
      202: { description: 'Intake session accepted; type detection is running' },
      ...problems(400, 401, 403, 409, 422, 503),
    },
  },
  {
    method: 'get',
    path: '/intake-sessions/{id}',
    operationId: 'getIntakeSession',
    summary: 'Read an intake session (resume support)',
    params: IntakeSessionIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Intake session', schema: IntakeSessionSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}/answers',
    operationId: 'answerIntakeQuestions',
    summary: 'Submit interview answers',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: IntakeAnswersRequestSchema,
    responses: {
      200: { description: 'Updated intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}/type-confirmation',
    operationId: 'confirmIntakeType',
    summary: 'Confirm or reject a similar task type',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: IntakeTypeConfirmationSchema,
    responses: {
      200: { description: 'Updated intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'get',
    path: '/intake-sessions/{id}/draft',
    operationId: 'getIntakeDraft',
    summary: 'Read the decomposition draft',
    params: IntakeSessionIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Decomposition draft', schema: DecompositionDraftSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
  {
    method: 'patch',
    path: '/intake-sessions/{id}/draft',
    operationId: 'updateIntakeDraft',
    summary: 'Edit the decomposition draft',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: DecompositionDraftPatchSchema,
    responses: {
      200: { description: 'Updated decomposition draft', schema: DecompositionDraftSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}/draft:approve',
    operationId: 'approveIntakeDraft',
    summary: 'Approve the draft and create tasks',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Intake session advanced to feasibility check', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}:pause',
    operationId: 'pauseIntakeSession',
    summary: 'Pause an intake interview',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Paused intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}:resume',
    operationId: 'resumeIntakeSession',
    summary: 'Resume a paused intake interview',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Resumed intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}:cancel',
    operationId: 'cancelIntakeSession',
    summary: 'Cancel an intake interview',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Cancelled intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}:manual',
    operationId: 'enterManualIntakeMode',
    summary: 'Switch the intake interview to manual mode',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Manual-mode intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 428),
    },
  },
  {
    method: 'get',
    path: '/templates',
    operationId: 'listTaskTemplates',
    summary: 'Search task templates',
    query: TaskTemplateListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Task template page', schema: PageTaskTemplateSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'get',
    path: '/templates/{id}',
    operationId: 'getTaskTemplate',
    summary: 'Read a task template',
    params: TaskTemplateIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Task template', schema: TaskTemplateSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
];

/**
 * Registered routes for the served API. M2-03 moved the intake/template
 * handlers into the composition root, so `intakeRoutes` is now part of the
 * registered table rather than a contract-only preview.
 */
export const routes: readonly RouteDefinition[] = [...coreRoutes, ...intakeRoutes];

export const contractRoutes: readonly RouteDefinition[] = [...routes];

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
  IntakeInput: IntakeInputSchema,
  IntakeSessionCreate: IntakeSessionCreateSchema,
  IntakeSession: IntakeSessionSchema,
  IntakeSessionIdParams: IntakeSessionIdParamsSchema,
  IntakeDetectedType: IntakeDetectedTypeSchema,
  IntakeAnswer: IntakeAnswerSchema,
  IntakeAnswersRequest: IntakeAnswersRequestSchema,
  PlannedQuestion: PlannedQuestionSchema,
  IntakeAssumption: IntakeAssumptionSchema,
  DecompositionEstimate: DecompositionEstimateSchema,
  DecompositionStep: DecompositionStepSchema,
  DecompositionDraft: DecompositionDraftSchema,
  DecompositionDraftPatch: DecompositionDraftPatchSchema,
  IntakeTypeConfirmation: IntakeTypeConfirmationSchema,
  IntakeError: IntakeErrorSchema,
  TemplateStats: TemplateStatsSchema,
  TaskTemplate: TaskTemplateSchema,
  PageTaskTemplate: PageTaskTemplateSchema,
  TaskTemplateListQuery: TaskTemplateListQuerySchema,
  TaskTemplateIdParams: TaskTemplateIdParamsSchema,
} as const;

export type SchemaRegistry = typeof schemaRegistry;
