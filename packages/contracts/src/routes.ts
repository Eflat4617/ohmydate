import { Type, type TSchema } from '@sinclair/typebox';
import { LoginRequestSchema, LlmBudgetSchema, LlmConsentSchema, LlmSettingsSchema, UserSchema, UserSettingsPatchSchema } from './auth.js';
import {
  CursorSchema,
  IdempotencyKeyHeaderSchema,
  IfMatchAvailabilityHeaderSchema,
  IfMatchHeaderSchema,
  IfNoneMatchHeaderSchema,
} from './common.js';
import { ProblemSchema } from './problem.js';
import { ExplanationItemSchema } from './explanation.js';
import {
  ApprovePlanRequestSchema,
  AvailabilityExceptionSchema,
  AvailabilityPreferencesSchema,
  AvailabilityPutSchema,
  AvailabilityRuleSchema,
  AvailabilitySchema,
  CommitmentCreateSchema,
  CommitmentListQuerySchema,
  CommitmentOccurrenceSchema,
  CommitmentPageSchema,
  CommitmentPatchSchema,
  CommitmentSchema,
  PlanBlockSchema,
  PlanCandidateParamsSchema,
  PlanCandidateSchema,
  PlanCreateSchema,
  PlanHorizonSchema,
  PlanIdParamsSchema,
  PlanMetricsSchema,
  PlanSchema,
  PlanScopeSchema,
  PlanVersionSchema,
  PreviewEditRequestSchema,
  PreviewEditResponseSchema,
  ScheduleBlockListQuerySchema,
  ScheduleBlockPageSchema,
  ScheduleBlockSchema,
} from './planning.js';
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
import {
  EstimationFeedbackIdParamsSchema,
  EstimationFeedbackPatchSchema,
  EstimationProfileGroupSchema,
  EstimationProfileItemSchema,
  EstimationProfileSchema,
  EstimationRatioStatsSchema,
  EstimationResetSchema,
  ReplanApproveRequestSchema,
  ReplanBeforeMetricsSchema,
  ReplanBeforeSchema,
  ReplanCandidateSchema,
  ReplanTaskSlackSchema,
  ReplanProposalIdParamsSchema,
  ReplanProposalListQuerySchema,
  ReplanProposalPageSchema,
  ReplanProposalSchema,
  ReplanRejectSchema,
  ReplanRequestSchema,
  ReplanTriggerSchema,
} from './replanning.js';
import {
  EstimationFeedbackSchema,
  ExportIdParamsSchema,
  ExportSchema,
  ExportStartResponseSchema,
  NotificationIdParamsSchema,
  NotificationPageSchema,
  NotificationQuerySchema,
  NotificationSchema,
  PushSubscriptionCreateSchema,
  PushSubscriptionIdParamsSchema,
  PushSubscriptionKeysSchema,
  PushSubscriptionSchema,
  SessionCreateSchema,
  SessionEventRequestSchema,
  SessionIdParamsSchema,
  SessionListQuerySchema,
  SessionReviewRequestSchema,
  TodayAcceptRequestSchema,
  TodayBlockSchema,
  TodayProposalBlockSchema,
  TodayProposalParamsSchema,
  TodayProposalSchema,
  TodayQuerySchema,
  TodayRescheduleRequestSchema,
  TodayRiskSchema,
  TodaySchema,
  TodayShrinkRequestSchema,
  WorkSessionPageSchema,
  WorkSessionSchema,
} from './today.js';

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
  /** Longer operation description rendered into OpenAPI. */
  readonly description?: string;
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

/**
 * Approval and availability replacement are keyed to the user-wide
 * `availability_version`, not to the plan/entity version (08 §2.4, §2.4a).
 */
const IfMatchAvailabilityAndIdempotencyHeadersSchema = Type.Object(
  {
    'If-Match': IfMatchAvailabilityHeaderSchema,
    'Idempotency-Key': IdempotencyKeyHeaderSchema,
  },
  { additionalProperties: false, required: ['If-Match', 'Idempotency-Key'] },
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
      ...problems(400, 401, 403, 409, 422),
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
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
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
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
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
    summary: 'Pause an intake interview (state becomes needs_input; other states return 409)',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Paused intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/intake-sessions/{id}:resume',
    operationId: 'resumeIntakeSession',
    summary: 'Resume a paused intake interview (needs_input restores the previous state)',
    params: IntakeSessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Resumed intake session', schema: IntakeSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
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
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
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
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
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

/**
 * Planning, availability and commitment routes (08 §2.4, §2.4a).
 *
 * Contract-only like `intakeRoutes`: M3-04 supplies the handlers. Approval and
 * regeneration are `:action` POSTs on an existing plan and therefore require
 * both `If-Match` and `Idempotency-Key`; approve pins `If-Match` to the
 * user-wide `W/"availability:<n>"` tag.
 */
export const planningRoutes: readonly RouteDefinition[] = [
  {
    method: 'post',
    path: '/plans',
    operationId: 'createPlan',
    summary: 'Generate plan candidates for a goal or task set',
    headers: IdempotencyHeadersSchema,
    body: PlanCreateSchema,
    responses: {
      201: { description: 'Plan with up to three candidates', schema: PlanSchema },
      ...problems(400, 401, 403, 422),
    },
  },
  {
    method: 'get',
    path: '/plans/{id}',
    operationId: 'getPlan',
    summary: 'Read a plan with its candidates and metrics',
    params: PlanIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Plan', schema: PlanSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
  {
    method: 'post',
    path: '/plans/{id}/candidates/{cid}:preview-edit',
    operationId: 'previewPlanCandidateEdit',
    summary: 'Validate an edited candidate without side effects',
    description:
      'Pre-flight validation maps edited blocks outside the persisted plan horizon or outside the plan task scope to 422 validation_failed with errors[{path: "/blocks/<i>", message}] before H1-H8 validation. If-Match is the plan resource version W/"<n>"; a stale version returns 412 version_conflict. Validator findings are returned in the 200 PreviewEditResponse, not as a 422.',
    params: PlanCandidateParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: PreviewEditRequestSchema,
    responses: {
      200: { description: 'Validator result', schema: PreviewEditResponseSchema },
      ...problems(400, 401, 403, 404, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/plans/{id}/candidates/{cid}:approve',
    operationId: 'approvePlanCandidate',
    summary: 'Approve a candidate as a new plan version',
    description:
      'The same pre-flight mapping as preview-edit applies: edited blocks outside the persisted plan horizon or plan task scope fail with 422 validation_failed errors[{path: "/editedBlocks/<i>", message}], while scheduler findings use 422 constraint_violation with violations[].',
    params: PlanCandidateParamsSchema,
    headers: IfMatchAvailabilityAndIdempotencyHeadersSchema,
    body: ApprovePlanRequestSchema,
    responses: {
      201: { description: 'Approved plan version', schema: PlanVersionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/plans/{id}:regenerate',
    operationId: 'regeneratePlan',
    summary: 'Regenerate candidates after a stale availability version',
    description:
      'Candidates are regenerated against the plan\'s original persisted horizon and time zone; the response Plan DTO echoes them unchanged.',
    params: PlanIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      201: { description: 'Regenerated plan', schema: PlanSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'get',
    path: '/availability',
    operationId: 'getAvailability',
    summary: 'Read availability rules, exceptions and preferences',
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Availability', schema: AvailabilitySchema },
      304: { description: 'Not modified' },
      ...problems(400, 401),
    },
  },
  {
    method: 'put',
    path: '/availability',
    operationId: 'putAvailability',
    summary: 'Replace availability and bump availability_version',
    headers: IfMatchAvailabilityAndIdempotencyHeadersSchema,
    body: AvailabilityPutSchema,
    responses: {
      200: { description: 'Updated availability', schema: AvailabilitySchema },
      ...problems(400, 401, 403, 409, 412, 422, 428),
    },
  },
  {
    method: 'get',
    path: '/commitments',
    operationId: 'listCommitments',
    summary: 'List commitments expanded within a bounded period',
    query: CommitmentListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Commitment page with expanded occurrences', schema: CommitmentPageSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'post',
    path: '/commitments',
    operationId: 'createCommitment',
    summary: 'Create a fixed commitment',
    headers: IdempotencyHeadersSchema,
    body: CommitmentCreateSchema,
    responses: {
      201: { description: 'Created commitment', schema: CommitmentSchema },
      ...problems(400, 401, 403, 422),
    },
  },
  {
    method: 'patch',
    path: '/commitments/{id}',
    operationId: 'updateCommitment',
    summary: 'Update a commitment',
    params: PlanIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: CommitmentPatchSchema,
    responses: {
      200: { description: 'Updated commitment', schema: CommitmentSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'delete',
    path: '/commitments/{id}',
    operationId: 'deleteCommitment',
    summary: 'Soft delete a commitment',
    params: PlanIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      204: { description: 'Commitment deleted' },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
];

/**
 * Today, focus session, notification, push and export routes (08 §2.5, §2.9,
 * §2.10). Contract-only: M4-02 supplies the handlers. `POST /today:shrink`
 * and `POST /today:reschedule` only create a proposal; approving it through
 * `POST /today/proposals/{id}:approve` is the write that creates a plan
 * version, mirroring the planning approval flow.
 */
export const dailyRoutes: readonly RouteDefinition[] = [
  {
    method: 'get',
    path: '/today',
    operationId: 'getToday',
    summary: 'Read today blocks, slack and risk',
    query: TodayQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Today view', schema: TodaySchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'post',
    path: '/today:accept',
    operationId: 'acceptToday',
    summary: "Accept today's recommended blocks",
    description:
      'If-Match pins the active plan revision echoed as Today.version. The request is idempotent and returns the accepted Today view.',
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: TodayAcceptRequestSchema,
    responses: {
      200: { description: 'Accepted today view', schema: TodaySchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/today:shrink',
    operationId: 'shrinkToday',
    summary: 'Propose a shorter block for today',
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: TodayShrinkRequestSchema,
    responses: {
      201: { description: 'Shrink proposal', schema: TodayProposalSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/today:reschedule',
    operationId: 'rescheduleToday',
    summary: 'Propose moving today blocks',
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: TodayRescheduleRequestSchema,
    responses: {
      201: { description: 'Reschedule proposal', schema: TodayProposalSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/today/proposals/{id}:approve',
    operationId: 'approveTodayProposal',
    summary: 'Apply a today shrink/reschedule proposal',
    description:
      'If-Match is the user-wide availability version W/"availability:<n>", the same lock as plan approval (08 §2.4). The proposal persists its base plan version and availability snapshot; in one transaction the server re-reads availability and locked blocks, re-runs validation, supersedes prior active blocks and creates a new plan version. A stale snapshot returns 412 availability_changed.',
    params: TodayProposalParamsSchema,
    headers: IfMatchAvailabilityAndIdempotencyHeadersSchema,
    responses: {
      201: { description: 'Approved plan version', schema: PlanVersionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/sessions',
    operationId: 'createSession',
    summary: 'Start a focus session',
    description:
      'Only one active session per owner exists. A second with the same owner returns 409 active_session_exists.',
    headers: IdempotencyHeadersSchema,
    body: SessionCreateSchema,
    responses: {
      201: { description: 'Started session', schema: WorkSessionSchema },
      ...problems(400, 401, 403, 404, 409, 422),
    },
  },
  {
    method: 'get',
    path: '/sessions/{id}',
    operationId: 'getSession',
    summary: 'Read a focus session (resume/deep-link support)',
    params: SessionIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Work session', schema: WorkSessionSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
  {
    method: 'get',
    path: '/sessions',
    operationId: 'listSessions',
    summary: 'List focus sessions, optionally filtered by state',
    query: SessionListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Work session page', schema: WorkSessionPageSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'get',
    path: '/schedule-blocks',
    operationId: 'listScheduleBlocks',
    summary: 'List active approved blocks overlapping a calendar range (FU-51)',
    description: 'The range must be positive and at most 366 days (422 validation_failed otherwise). Only non-superseded approved blocks of the owner are returned.',
    query: ScheduleBlockListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Schedule block page', schema: ScheduleBlockPageSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'post',
    path: '/sessions/{id}:pause',
    operationId: 'pauseSession',
    summary: 'Pause a focus session',
    params: SessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: SessionEventRequestSchema,
    responses: {
      200: { description: 'Paused session', schema: WorkSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/sessions/{id}:resume',
    operationId: 'resumeSession',
    summary: 'Resume a paused focus session',
    params: SessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: SessionEventRequestSchema,
    responses: {
      200: { description: 'Resumed session', schema: WorkSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/sessions/{id}:complete',
    operationId: 'completeSession',
    summary: 'Complete a focus session',
    params: SessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: SessionEventRequestSchema,
    responses: {
      200: { description: 'Completed session', schema: WorkSessionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/sessions/{id}/review',
    operationId: 'reviewSession',
    summary: 'Submit end-of-session feedback',
    description:
      'Creates a task completion review and estimation feedback. The optional note is personal text and is never logged.',
    params: SessionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: SessionReviewRequestSchema,
    responses: {
      201: { description: 'Estimation feedback', schema: EstimationFeedbackSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'get',
    path: '/notifications',
    operationId: 'listNotifications',
    summary: 'List notifications',
    query: NotificationQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Notification page', schema: NotificationPageSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'post',
    path: '/notifications/{id}:dismiss',
    operationId: 'dismissNotification',
    summary: 'Dismiss a notification',
    params: NotificationIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      200: { description: 'Dismissed notification', schema: NotificationSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/push-subscriptions',
    operationId: 'createPushSubscription',
    summary: 'Register a browser push subscription',
    description:
      'The endpoint must be HTTPS. Key material is encrypted at rest and never returned.',
    headers: IdempotencyHeadersSchema,
    body: PushSubscriptionCreateSchema,
    responses: {
      201: { description: 'Created push subscription', schema: PushSubscriptionSchema },
      ...problems(400, 401, 403, 409, 422),
    },
  },
  {
    method: 'delete',
    path: '/push-subscriptions/{id}',
    operationId: 'deletePushSubscription',
    summary: 'Remove a push subscription',
    params: PushSubscriptionIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    responses: {
      204: { description: 'Push subscription removed' },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/exports',
    operationId: 'createExport',
    summary: 'Request a data export',
    description:
      'Queues a zip export (JSON + Markdown + attachments) and returns 202 with the export id.',
    headers: IdempotencyHeadersSchema,
    responses: {
      202: { description: 'Export queued', schema: ExportStartResponseSchema },
      ...problems(400, 401, 403, 409, 422),
    },
  },
  {
    method: 'get',
    path: '/exports/{id}',
    operationId: 'getExport',
    summary: 'Read export state and download URL',
    description:
      'Metadata is always readable. downloadUrl appears only when state is ready and expires at expiresAt.',
    params: ExportIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Export job', schema: ExportSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
];

/**
 * M5 replanning and estimation-learning routes (08 §2.6, §2.10, 05 §6/§10/§11).
 * Contract-only: M5-02 supplies the handlers. Proposal approval pins
 * `If-Match` to the user-wide `W/"availability:<n>"` tag exactly like plan
 * approval (08 §2.4), while rejection pins it to the proposal's own version.
 */
export const replanningRoutes: readonly RouteDefinition[] = [
  {
    method: 'get',
    path: '/replan-proposals',
    operationId: 'listReplanProposals',
    summary: 'List replan proposals, optionally filtered by state',
    query: ReplanProposalListQuerySchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Replan proposal page', schema: ReplanProposalPageSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 422),
    },
  },
  {
    method: 'get',
    path: '/replan-proposals/{id}',
    operationId: 'getReplanProposal',
    summary: 'Read a replan proposal',
    params: ReplanProposalIdParamsSchema,
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Replan proposal', schema: ReplanProposalSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401, 404),
    },
  },
  {
    method: 'post',
    path: '/replan-proposals/{id}:approve',
    operationId: 'approveReplanProposal',
    summary: 'Approve a replan proposal as a new plan version',
    description:
      'Reuses the plan-approval atomicity contract (08 §2.4): If-Match is the user-wide availability version W/"availability:<n>", and one transaction re-reads availability and locked blocks, re-runs validation, supersedes prior blocks and creates a plan version with createdBy="replan". A stale snapshot returns 412 availability_changed, a non-pending proposal returns 409 proposal_state_conflict, and scheduler findings return 422 constraint_violation{violations[]}.',
    params: ReplanProposalIdParamsSchema,
    headers: IfMatchAvailabilityAndIdempotencyHeadersSchema,
    body: ReplanApproveRequestSchema,
    responses: {
      201: { description: 'Approved plan version', schema: PlanVersionSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428, 503),
    },
  },
  {
    method: 'post',
    path: '/replan-proposals/{id}:reject',
    operationId: 'rejectReplanProposal',
    summary: 'Reject a replan proposal and suppress the same reason for 24 h',
    description:
      'If-Match is the proposal resource version W/"<n>". A rejected proposal records a replan_suppression(owner, reason, until = now + 24 h) so the same reason is not proposed again inside the window (05 §11).',
    params: ReplanProposalIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: ReplanRejectSchema,
    responses: {
      200: { description: 'Rejected replan proposal', schema: ReplanProposalSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/replan-proposals:request',
    operationId: 'requestReplanProposal',
    summary: 'Request a user-initiated replan proposal',
    description:
      'Creates a pending proposal for a plan with trigger kind user_request. When the same reason is inside its 24 h post-rejection suppression window, or the owner already received two proposals today, the response is 409 replan_suppressed with Retry-After seconds until the next allowed attempt.',
    headers: IdempotencyHeadersSchema,
    body: ReplanRequestSchema,
    responses: {
      201: { description: 'Created replan proposal', schema: ReplanProposalSchema },
      ...problems(400, 401, 403, 404, 409, 422),
    },
  },
  {
    method: 'get',
    path: '/estimation/profile',
    operationId: 'getEstimationProfile',
    summary: 'Read the personal estimation profile ("내 패턴")',
    description:
      'Returns per-template/task-kind log-ratio statistics with sample count, confidence and method, plus feedback items whose outlier/exclusion state can be toggled. Priors and shrinkage use k=5 and |z|>2.5 outlier rejection (05 §6).',
    headers: IfNoneMatchHeadersSchema,
    responses: {
      200: { description: 'Estimation profile', schema: EstimationProfileSchema },
      304: { description: 'Not modified' },
      ...problems(400, 401),
    },
  },
  {
    method: 'patch',
    path: '/estimation/feedback/{id}',
    operationId: 'patchEstimationFeedback',
    summary: 'Exclude or re-include one learning feedback item',
    params: EstimationFeedbackIdParamsSchema,
    headers: IfMatchAndIdempotencyHeadersSchema,
    body: EstimationFeedbackPatchSchema,
    responses: {
      200: { description: 'Updated feedback item', schema: EstimationProfileItemSchema },
      ...problems(400, 401, 403, 404, 409, 412, 422, 428),
    },
  },
  {
    method: 'post',
    path: '/estimation:reset',
    operationId: 'resetEstimation',
    summary: 'Reset learned estimation corrections by scope',
    description:
      'Resets personal corrections for one template (scope="template", templateId required) or all templates (scope="all") per 05 §6 and 08 §2.10. Returns the refreshed estimation profile.',
    headers: IdempotencyHeadersSchema,
    body: EstimationResetSchema,
    responses: {
      200: { description: 'Refreshed estimation profile', schema: EstimationProfileSchema },
      ...problems(400, 401, 403, 422),
    },
  },
];

export const contractRoutes: readonly RouteDefinition[] = [
  ...routes,
  ...planningRoutes,
  ...dailyRoutes,
  ...replanningRoutes,
];

export const schemaRegistry = {
  Problem: ProblemSchema,
  ExplanationItem: ExplanationItemSchema,
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
  LlmConsent: LlmConsentSchema,
  LlmBudget: LlmBudgetSchema,
  LlmSettings: LlmSettingsSchema,
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
  AvailabilityRule: AvailabilityRuleSchema,
  AvailabilityException: AvailabilityExceptionSchema,
  AvailabilityPreferences: AvailabilityPreferencesSchema,
  Availability: AvailabilitySchema,
  AvailabilityPut: AvailabilityPutSchema,
  CommitmentOccurrence: CommitmentOccurrenceSchema,
  Commitment: CommitmentSchema,
  CommitmentCreate: CommitmentCreateSchema,
  CommitmentPatch: CommitmentPatchSchema,
  CommitmentListQuery: CommitmentListQuerySchema,
  CommitmentPage: CommitmentPageSchema,
  PlanScope: PlanScopeSchema,
  PlanHorizon: PlanHorizonSchema,
  PlanCreate: PlanCreateSchema,
  PlanBlock: PlanBlockSchema,
  PlanMetrics: PlanMetricsSchema,
  PlanCandidate: PlanCandidateSchema,
  Plan: PlanSchema,
  PlanIdParams: PlanIdParamsSchema,
  PlanCandidateParams: PlanCandidateParamsSchema,
  PreviewEditRequest: PreviewEditRequestSchema,
  PreviewEditResponse: PreviewEditResponseSchema,
  ApprovePlanRequest: ApprovePlanRequestSchema,
  ScheduleBlock: ScheduleBlockSchema,
  ScheduleBlockListQuery: ScheduleBlockListQuerySchema,
  ScheduleBlockPage: ScheduleBlockPageSchema,
  PlanVersion: PlanVersionSchema,
  TodayRisk: TodayRiskSchema,
  TodayBlock: TodayBlockSchema,
  Today: TodaySchema,
  TodayQuery: TodayQuerySchema,
  TodayAcceptRequest: TodayAcceptRequestSchema,
  TodayShrinkRequest: TodayShrinkRequestSchema,
  TodayRescheduleRequest: TodayRescheduleRequestSchema,
  TodayProposalBlock: TodayProposalBlockSchema,
  TodayProposal: TodayProposalSchema,
  TodayProposalParams: TodayProposalParamsSchema,
  WorkSession: WorkSessionSchema,
  WorkSessionPage: WorkSessionPageSchema,
  SessionCreate: SessionCreateSchema,
  SessionIdParams: SessionIdParamsSchema,
  SessionListQuery: SessionListQuerySchema,
  SessionEventRequest: SessionEventRequestSchema,
  SessionReviewRequest: SessionReviewRequestSchema,
  EstimationFeedback: EstimationFeedbackSchema,
  Notification: NotificationSchema,
  NotificationQuery: NotificationQuerySchema,
  NotificationPage: NotificationPageSchema,
  NotificationIdParams: NotificationIdParamsSchema,
  PushSubscriptionKeys: PushSubscriptionKeysSchema,
  PushSubscriptionCreate: PushSubscriptionCreateSchema,
  PushSubscription: PushSubscriptionSchema,
  PushSubscriptionIdParams: PushSubscriptionIdParamsSchema,
  Export: ExportSchema,
  ExportStartResponse: ExportStartResponseSchema,
  ExportIdParams: ExportIdParamsSchema,
  ReplanTrigger: ReplanTriggerSchema,
  ReplanCandidate: ReplanCandidateSchema,
  ReplanTaskSlack: ReplanTaskSlackSchema,
  ReplanBeforeMetrics: ReplanBeforeMetricsSchema,
  ReplanBefore: ReplanBeforeSchema,
  ReplanProposal: ReplanProposalSchema,
  ReplanProposalPage: ReplanProposalPageSchema,
  ReplanProposalListQuery: ReplanProposalListQuerySchema,
  ReplanProposalIdParams: ReplanProposalIdParamsSchema,
  ReplanApproveRequest: ReplanApproveRequestSchema,
  ReplanReject: ReplanRejectSchema,
  ReplanRequest: ReplanRequestSchema,
  EstimationRatioStats: EstimationRatioStatsSchema,
  EstimationProfileGroup: EstimationProfileGroupSchema,
  EstimationProfileItem: EstimationProfileItemSchema,
  EstimationProfile: EstimationProfileSchema,
  EstimationReset: EstimationResetSchema,
  EstimationFeedbackPatch: EstimationFeedbackPatchSchema,
  EstimationFeedbackIdParams: EstimationFeedbackIdParamsSchema,
} as const;

export type SchemaRegistry = typeof schemaRegistry;
