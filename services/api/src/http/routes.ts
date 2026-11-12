import {
  dailyRoutes,
  notesRoutes,
  planningRoutes,
  replanningRoutes,
  routes,
  type ContextDocumentCreate,
  type ContextDocumentDto,
  type ContextDocumentIdParams,
  type ContextDocumentListQuery,
  type ContextDocumentPatch,
  type DocumentLinkCreate,
  type DocumentLinkParams,
  type NoteAiUsageDto,
  type NoteAiUsageListQuery,
  type EstimationFeedbackIdParams,
  type EstimationFeedbackPatch,
  type EstimationReset,
  type ReplanApproveRequest,
  type ReplanProposalIdParams,
  type ReplanProposalListQuery,
  type ReplanReject,
  type ReplanRequest,
  type ApprovePlanRequest,
  type AvailabilityPut,
  type CommitmentCreate,
  type CommitmentListQuery,
  type CommitmentPatch,
  type DecompositionDraftDto,
  type DecompositionDraftPatch,
  type IntakeAnswersRequest,
  type IntakeSessionCreate,
  type IntakeSessionDto,
  type IntakeSessionIdParams,
  type IntakeTypeConfirmation,
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
  type TaskTemplate,
  type TaskTemplateIdParams,
  type TaskTemplateListQuery,
  type User as UserDto,
  type UserSettingsPatch,
  type PlanCandidateParams,
  type PlanCreate,
  type PlanIdParams,
  type PreviewEditRequest,
  type RouteDefinition,
  type EstimationFeedback,
  type ExportIdParams,
  type NotificationIdParams,
  type NotificationQuery,
  type PushSubscriptionCreate,
  type PushSubscriptionIdParams,
  type SessionCreate,
  type SessionEventRequest,
  type SessionIdParams,
  type SessionListQuery,
  type SessionReviewRequest,
  type ScheduleBlockIdParams,
  type ScheduleBlockListQuery,
  type GoalListQuery,
  type TodayAcceptRequest,
  type TodayQuery,
  type TodayRescheduleRequest,
  type TodayShrinkRequest,
  type TodayProposalParams,
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
import { llmPromptLimits, type AppConfig } from '../config.js';
import type { Clock } from '@ohmydate/domain';
import type {
  AppRepositories,
  IdempotencyStore,
  LlmUserSettings,
  OutboxEventInput,
  SessionStore,
  UserRecord,
  UserRepository,
} from '../application/ports.js';
import { AuthService } from '../application/auth-service.js';
import { PlanService } from '../application/plan-service.js';
import type { PlanningStore } from '../application/planning-ports.js';
import { IntakeError } from '../application/intake/intake-error.js';
import { DailyProblemError } from '../application/daily-errors.js';
import { ReplanSuppressedError } from '../application/replan-errors.js';
import { IntakeService } from '../application/intake/intake-service.js';
import { InProcessIntakeApprovalLock } from '../application/intake/in-process-approval-lock.js';
import { PgAgentRunRepository } from '../adapters/pg-agent-run-repository.js';
import { PgIntakeApprovalLock } from '../adapters/pg-intake-approval-lock.js';
import { PgIntakeApprovalRepository } from '../adapters/pg-intake-approval-repository.js';
import { PgIntakeSessionRepository } from '../adapters/pg-intake-session-repository.js';
import { PgTaskTemplateRepository } from '../adapters/pg-task-template-repository.js';
import { ProjectService } from '../application/project-service.js';
import { TaskService } from '../application/task-service.js';
import { TodayService } from '../application/today-service.js';
import { SessionService } from '../application/session-service.js';
import type { NotificationStore } from '../application/notification-service.js';
import { PgTodayStore } from '../adapters/pg-today-store.js';
import { PgWorkSessionStore } from '../adapters/pg-work-session-store.js';
import { PgNotificationStore } from '../adapters/pg-notification-store.js';
import { PgPushSubscriptionStore } from '../adapters/pg-push-subscription-store.js';
import { ExportService } from '../application/export-service.js';
import { PgExportPayloadBuilder, PgExportStore } from '../adapters/pg-export-store.js';
import { EstimationService } from '../application/estimation-service.js';
import { ReplanService } from '../application/replan-service.js';
import { PgEstimationStore } from '../adapters/pg-estimation-store.js';
import { PgReplanStore } from '../adapters/pg-replan-store.js';
import { PgNoteStore } from '../adapters/pg-note-store.js';
import { NotesService } from '../application/notes/notes-service.js';
import type { NoteRecord, NoteUsageRecord } from '../application/notes/ports.js';
import { resolvePushKey } from '../application/push-crypto.js';
import { sessionSecretMatches } from '../application/session-tokens.js';
import type { Database } from '../db/types.js';
import type { BudgetGuard, LlmPort } from '@ohmydate/llm';
import type { IdGenerator } from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import {
  etagForBody,
  etagForVersion,
  ifNoneMatch,
  requireAvailabilityIfMatch,
  requireIdempotencyKey,
  requireIfMatch,
  requestHash,
  headerValue,
} from './headers.js';
import { loggedPath } from './log-url.js';
import {
  ProblemError,
  domainErrorToProblem,
  planningErrorToProblem,
  problemBodyFor,
} from './problem.js';

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
  readonly planning: PlanService;
  readonly intake: IntakeService;
  readonly today: TodayService;
  readonly workSessions: SessionService;
  readonly notifications: NotificationStore;
  readonly pushSubscriptions: PgPushSubscriptionStore;
  readonly exports: ExportService;
  readonly replan: ReplanService;
  readonly estimation: EstimationService;
  readonly notes: NotesService;
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

function toUserDto(user: UserRecord, llmProvider: AppConfig['llmProvider']): UserDto {
  const llm = user.settings.llm;
  return {
    id: user.id,
    email: user.email,
    timeZone: user.timeZone,
    locale: user.locale,
    ...(llm === undefined ? {} : { llm }),
    llmProvider,
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
    kind: project.kind,
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

/** Raw Markdown only: the API never renders or returns HTML for notes. */
function toDocumentDto(note: NoteRecord): ContextDocumentDto {
  return {
    id: note.id,
    ownerId: note.ownerId,
    title: note.title,
    bodyMd: note.bodyMd,
    sensitivity: note.sensitivity,
    llmAllowed: note.llmAllowed,
    source: note.source,
    ...(note.sourceTaskId === undefined ? {} : { sourceTaskId: note.sourceTaskId }),
    links: note.links.map((link) => ({
      id: link.id,
      documentId: link.documentId,
      targetKind: link.targetKind,
      targetId: link.targetId,
      createdAt: link.createdAt,
    })),
    version: note.version,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

function toNoteUsageDto(usage: NoteUsageRecord): NoteAiUsageDto {
  return {
    id: usage.id,
    documentId: usage.documentId,
    agentRunId: usage.agentRunId,
    purpose: usage.purpose,
    promptIdVersion: usage.promptIdVersion,
    status: usage.status,
    provider: usage.provider,
    model: usage.model,
    documentVersion: usage.documentVersion,
    bodyHash: usage.bodyHash,
    sectionHashes: [...usage.sectionHashes],
    sentBytes: usage.sentBytes,
    stale: usage.documentVersion < usage.currentVersion,
    createdAt: usage.createdAt,
  };
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
  // Double submit: header == cookie, and the header hashes to the session's
  // stored CSRF digest (FU-92). Both comparisons are constant time.
  if (
    !timingSafeStringEqual(header, cookie) ||
    !sessionSecretMatches(header, auth.csrfTokenHash)
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
          { ownerId: auth.userId, key, route: request.routeOptions.url ?? loggedPath(request.url) },
          'idempotency release failed',
        );
      }
    };

    const problem =
      error instanceof DomainError
        ? domainErrorToProblem(error)
        : (planningErrorToProblem(error) ??
          (error instanceof DailyProblemError
            ? {
                status: error.status,
                code: error.code,
                title: error.title,
                ...(error.detail === undefined ? {} : { detail: error.detail }),
              }
            : error instanceof ReplanSuppressedError
              ? {
                  status: 409,
                  code: 'replan_suppressed' as const,
                  title: 'Replan suppressed',
                  detail: error.message,
                }
              : error instanceof IntakeError
              ? {
                  status: error.status,
                  code: error.code,
                  title: error.title,
                  detail: error.detail,
                }
              : undefined));

    // ADR-020 §11: a succession-wait 409 `approval_in_progress` is transient
    // contention, not a stored domain result. Release its reservation so the
    // same Idempotency-Key can retry once the previous holder's window ends.
    const transientConflict = error instanceof IntakeError && error.transient;
    if (
      problem !== undefined &&
      (problem.status === 409 || problem.status === 422) &&
      !transientConflict
    ) {
      try {
        await runtime.idempotency.complete({
          ownerId: auth.userId,
          key,
          response: {
            status: problem.status,
            body: problemBodyFor(request, problem),
            headers: {
              'Content-Type': 'application/problem+json',
              ...(error instanceof IntakeError ? (error.headers ?? {}) : {}),
              // 08 §1: replan_suppressed is a stored domain 409; the replay
              // carries the original Retry-After (M5-02R-1 M1).
              ...(error instanceof ReplanSuppressedError
                ? { 'Retry-After': String(error.retryAfterSec) }
                : {}),
            },
          },
          outbox: [],
        });
      } catch {
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
      let llm: LlmUserSettings | undefined;
      if (patch.llm !== undefined) {
        const current = await runtime.auth.me(auth.userId);
        const existing = current.settings.llm;
        const consent = patch.llm.consent;
        const budget = patch.llm.budget;
        llm = {
          ...(consent === undefined
            ? {}
            : {
                consent: {
                  granted: consent.granted,
                  at: runtime.clock.now(),
                  provider: runtime.config.llmProvider,
                },
              }),
          ...(budget === undefined
            ? {}
            : {
                budget: {
                  dailyUsd:
                    budget.dailyUsd ??
                    existing?.budget?.dailyUsd ??
                    runtime.config.llmDailyBudgetUsd,
                  monthlyUsd:
                    budget.monthlyUsd ??
                    existing?.budget?.monthlyUsd ??
                    runtime.config.llmMonthlyBudgetUsd,
                },
              }),
          ...(existing?.consent !== undefined && consent === undefined
            ? { consent: existing.consent }
            : {}),
        };
      }
      const user = await runtime.auth.updateSettings(
        auth.userId,
        {
          ...(patch.timeZone === undefined ? {} : { timeZone: patch.timeZone }),
          ...(patch.locale === undefined ? {} : { locale: patch.locale }),
          ...(llm === undefined ? {} : { llm }),
        },
        expected,
      );
      return {
        status: 200,
        body: toUserDto(user, runtime.config.llmProvider),
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

  const createPlan = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const plan = await runtime.planning.createPlan(auth.userId, request.body as PlanCreate);
      return {
        status: 201,
        body: plan,
        headers: { ETag: etagForVersion(plan.version) },
      };
    });

  const previewPlanCandidateEdit = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PlanCandidateParams;
      const body = request.body as PreviewEditRequest;
      const result = await runtime.planning.previewEdit(
        auth.userId,
        params.id as Id,
        params.cid as Id,
        body.blocks,
        requireIfMatch(request),
      );
      return { status: 200, body: result };
    });

  const approvePlanCandidate = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PlanCandidateParams;
      const expected = requireAvailabilityIfMatch(request);
      const body = (request.body ?? {}) as ApprovePlanRequest;
      const version = await runtime.planning.approve(
        auth.userId,
        params.id as Id,
        params.cid as Id,
        body.editedBlocks,
        expected,
        requireIdempotencyKey(request),
      );
      return {
        status: 201,
        body: version,
        headers: { ETag: etagForVersion(version.version) },
      };
    });

  const regeneratePlan = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PlanIdParams;
      const expected = requireIfMatch(request);
      const plan = await runtime.planning.regenerate(auth.userId, params.id as Id, expected);
      return {
        status: 201,
        body: plan,
        headers: { ETag: etagForVersion(plan.version) },
      };
    });

  const putAvailability = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const expected = requireAvailabilityIfMatch(request);
      const availability = await runtime.planning.putAvailability(
        auth.userId,
        request.body as AvailabilityPut,
        expected,
      );
      return {
        status: 200,
        body: availability,
        headers: { ETag: `W/"availability:${availability.version}"` },
      };
    });

  const createCommitment = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const commitment = await runtime.planning.createCommitment(
        auth.userId,
        request.body as CommitmentCreate,
      );
      return {
        status: 201,
        body: commitment,
        headers: { ETag: etagForVersion(commitment.version) },
      };
    });

  const updateCommitment = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PlanIdParams;
      const expected = requireIfMatch(request);
      const commitment = await runtime.planning.updateCommitment(
        auth.userId,
        params.id as Id,
        request.body as CommitmentPatch,
        expected,
      );
      return {
        status: 200,
        body: commitment,
        headers: { ETag: etagForVersion(commitment.version) },
      };
    });

  const deleteCommitment = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PlanIdParams;
      await runtime.planning.deleteCommitment(
        auth.userId,
        params.id as Id,
        requireIfMatch(request),
      );
      return { status: 204 };
    });

  const acceptToday = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const body = request.body as TodayAcceptRequest;
      const today = await runtime.today.accept(auth.userId, body.date, requireIfMatch(request));
      return {
        status: 200,
        body: today,
        headers: { ETag: etagForVersion(today.version) },
      };
    });

  const shrinkToday = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const proposal = await runtime.today.shrink(
        auth.userId,
        request.body as TodayShrinkRequest,
        requireIfMatch(request),
      );
      return {
        status: 201,
        body: proposal,
        headers: { ETag: etagForVersion(proposal.version) },
      };
    });

  const rescheduleToday = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const proposal = await runtime.today.reschedule(
        auth.userId,
        request.body as TodayRescheduleRequest,
        requireIfMatch(request),
      );
      return {
        status: 201,
        body: proposal,
        headers: { ETag: etagForVersion(proposal.version) },
      };
    });

  const approveTodayProposal = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as TodayProposalParams;
      const version = await runtime.today.approveProposal(
        auth.userId,
        params.id as Id,
        requireAvailabilityIfMatch(request),
        requireIdempotencyKey(request),
      );
      return {
        status: 201,
        body: version,
        headers: { ETag: etagForVersion(version.version) },
      };
    });

  const createSession = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const session = await runtime.workSessions.create(
        auth.userId,
        request.body as SessionCreate,
      );
      return {
        status: 201,
        body: session,
        headers: { ETag: etagForVersion(session.version) },
      };
    });

  const sessionAction = (
    action: 'pause' | 'resume' | 'complete',
  ) => async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as SessionIdParams;
      const body = request.body as SessionEventRequest;
      const expected = requireIfMatch(request) as Version;
      const session =
        action === 'pause'
          ? await runtime.workSessions.pause(auth.userId, params.id as Id, body, expected)
          : action === 'resume'
            ? await runtime.workSessions.resume(auth.userId, params.id as Id, body, expected)
            : await runtime.workSessions.complete(auth.userId, params.id as Id, body, expected);
      return {
        status: 200,
        body: session,
        headers: { ETag: etagForVersion(session.version) },
      };
    });

  const blockLockAction =
    (locked: boolean) => async (request: FastifyRequest, reply: FastifyReply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const params = request.params as ScheduleBlockIdParams;
        const block = await runtime.planning.setBlockLock(
          auth.userId,
          params.id as Id,
          locked,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: block,
          headers: { ETag: etagForVersion(block.version) },
        };
      });

  const reviewSession = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as SessionIdParams;
      const feedback: EstimationFeedback = await runtime.workSessions.review(
        auth.userId,
        params.id as Id,
        request.body as SessionReviewRequest,
        requireIfMatch(request) as Version,
      );
      return { status: 201, body: feedback };
    });

  const approveReplanProposal = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as ReplanProposalIdParams;
      const body = (request.body ?? {}) as ReplanApproveRequest;
      const version = await runtime.replan.approve(
        auth.userId,
        params.id as Id,
        requireAvailabilityIfMatch(request),
        requireIdempotencyKey(request),
        body.editedBlocks,
      );
      return {
        status: 201,
        body: version,
        headers: { ETag: etagForVersion(version.version) },
      };
    });

  const rejectReplanProposal = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as ReplanProposalIdParams;
      const body = (request.body ?? {}) as ReplanReject;
      const proposal = await runtime.replan.reject(
        auth.userId,
        params.id as Id,
        requireIfMatch(request),
        body.reason,
      );
      return {
        status: 200,
        body: proposal,
        headers: { ETag: etagForVersion(proposal.version) },
      };
    });

  const requestReplanProposal = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const proposal = await runtime.replan.request(auth.userId, request.body as ReplanRequest);
      return {
        status: 201,
        body: proposal,
        headers: { ETag: etagForVersion(proposal.version) },
      };
    });

  const patchEstimationFeedback = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as EstimationFeedbackIdParams;
      const body = request.body as EstimationFeedbackPatch;
      const item = await runtime.estimation.patchFeedback(
        auth.userId,
        params.id as Id,
        body.excluded,
        requireIfMatch(request),
      );
      return {
        status: 200,
        body: item,
        headers: { ETag: etagForVersion(item.version) },
      };
    });

  const resetEstimation = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const profile = await runtime.estimation.reset(auth.userId, request.body as EstimationReset);
      return { status: 200, body: profile };
    });

  const dismissNotification = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as NotificationIdParams;
      const notification = await runtime.notifications.dismiss(
        auth.userId,
        params.id as Id,
        requireIfMatch(request),
        runtime.clock.now(),
      );
      return {
        status: 200,
        body: notification,
        headers: { ETag: etagForVersion(notification.version) },
      };
    });

  const createPushSubscription = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const subscription = await runtime.pushSubscriptions.create(
        auth.userId,
        request.body as PushSubscriptionCreate,
      );
      return {
        status: 201,
        body: subscription,
        headers: { ETag: etagForVersion(subscription.version) },
      };
    });

  const deletePushSubscription = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const params = request.params as PushSubscriptionIdParams;
      await runtime.pushSubscriptions.delete(
        auth.userId,
        params.id as Id,
        requireIfMatch(request),
      );
      return { status: 204 };
    });

  const createExport = async (request: FastifyRequest, reply: FastifyReply) =>
    runIdempotent(runtime, request, reply, async () => {
      const auth = currentAuth(request);
      const started = await runtime.exports.start(auth.userId);
      return { status: 202, body: started };
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
      const etag = `W/"${user.id}:${user.version}"`;
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Vary', 'Cookie');
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(toUserDto(user, runtime.config.llmProvider));
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
    createPlan,
    getPlan: async (request, reply) => {
      const auth = currentAuth(request);
      const params = request.params as PlanIdParams;
      const plan = await runtime.planning.getPlan(auth.userId, params.id as Id);
      const etag = etagForVersion(plan.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(plan);
    },
    listGoals: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.planning.listGoals(auth.userId, request.query as GoalListQuery);
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    previewPlanCandidateEdit,
    approvePlanCandidate,
    regeneratePlan,
    getAvailability: async (request, reply) => {
      const auth = currentAuth(request);
      const availability = await runtime.planning.getAvailability(auth.userId);
      const etag = `W/"availability:${availability.version}"`;
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(availability);
    },
    putAvailability,
    listCommitments: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.planning.listCommitments(
        auth.userId,
        request.query as CommitmentListQuery,
      );
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    createCommitment,
    updateCommitment,
    deleteCommitment,
    getToday: async (request, reply) => {
      const auth = currentAuth(request);
      const query = request.query as TodayQuery;
      const today = await runtime.today.getToday(auth.userId, query.date);
      const etag = etagForVersion(today.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(today);
    },
    acceptToday,
    shrinkToday,
    rescheduleToday,
    approveTodayProposal,
    createSession,
    getSession: async (request, reply) => {
      const auth = currentAuth(request);
      const params = request.params as SessionIdParams;
      const session = await runtime.workSessions.get(auth.userId, params.id as Id);
      const etag = etagForVersion(session.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(session);
    },
    listSessions: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.workSessions.list(
        auth.userId,
        request.query as SessionListQuery,
      );
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    listScheduleBlocks: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.planning.listScheduleBlocks(
        auth.userId,
        request.query as ScheduleBlockListQuery,
      );
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    lockScheduleBlock: blockLockAction(true),
    unlockScheduleBlock: blockLockAction(false),
    pauseSession: sessionAction('pause'),
    resumeSession: sessionAction('resume'),
    completeSession: sessionAction('complete'),
    reviewSession,
    listNotifications: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.notifications.list(
        auth.userId,
        request.query as NotificationQuery,
      );
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    dismissNotification,
    listReplanProposals: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.replan.list(
        auth.userId,
        request.query as ReplanProposalListQuery,
      );
      const etag = etagForBody(page);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(page);
    },
    getReplanProposal: async (request, reply) => {
      const auth = currentAuth(request);
      const params = request.params as ReplanProposalIdParams;
      const proposal = await runtime.replan.get(auth.userId, params.id as Id);
      const etag = etagForVersion(proposal.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(proposal);
    },
    approveReplanProposal,
    rejectReplanProposal,
    requestReplanProposal,
    getEstimationProfile: async (request, reply) => {
      const auth = currentAuth(request);
      const profile = await runtime.estimation.profile(auth.userId);
      // generatedAt changes on every read; the validator covers the content.
      const etag = etagForBody({ ...profile, generatedAt: null });
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(profile);
    },
    patchEstimationFeedback,
    resetEstimation,
    createPushSubscription,
    deletePushSubscription,
    createExport,
    getExport: async (request, reply) => {
      const auth = currentAuth(request);
      const params = request.params as ExportIdParams;
      const query = (request.query ?? {}) as { download?: unknown };
      if (query.download === '1' || query.download === 1) {
        const artifact = await runtime.exports.download(auth.userId, params.id as Id);
        return reply
          .code(200)
          .type(artifact.contentType)
          .header(
            'Content-Disposition',
            `attachment; filename="ohmydate-export-${params.id}.json"`,
          )
          .send(artifact.content);
      }
      const host = request.headers.host ?? 'localhost';
      const record = await runtime.exports.get(
        auth.userId,
        params.id as Id,
        `${request.protocol}://${host}`,
      );
      const etag = etagForBody(record);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(record);
    },
    createIntakeSession: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const session = await runtime.intake.create(
          auth.userId,
          request.body as IntakeSessionCreate,
        );
        return {
          status: 201,
          body: session,
          headers: {
            ETag: etagForVersion(session.version),
            Location: `/api/v1/intake-sessions/${session.id}`,
          },
        };
      }),
    getIntakeSession: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as IntakeSessionIdParams).id as Id;
      const session: IntakeSessionDto = await runtime.intake.get(auth.userId, id);
      const etag = etagForVersion(session.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(session);
    },
    answerIntakeQuestions: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const expected = requireIfMatch(request);
        const session = await runtime.intake.submitAnswers(
          auth.userId,
          id,
          request.body as IntakeAnswersRequest,
          expected,
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    confirmIntakeType: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const expected = requireIfMatch(request);
        const session = await runtime.intake.confirmType(
          auth.userId,
          id,
          request.body as IntakeTypeConfirmation,
          expected,
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    getIntakeDraft: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as IntakeSessionIdParams).id as Id;
      const result = await runtime.intake.getDraft(auth.userId, id);
      const etag = etagForVersion(result.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(result.draft);
    },
    updateIntakeDraft: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const expected = requireIfMatch(request);
        const result = await runtime.intake.patchDraft(
          auth.userId,
          id,
          request.body as DecompositionDraftPatch,
          expected,
        );
        return {
          status: 200,
          body: result.draft as DecompositionDraftDto,
          headers: { ETag: etagForVersion(result.version) },
        };
      }),
    approveIntakeDraft: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const expected = requireIfMatch(request);
        const result = await runtime.intake.approveDraft(
          auth.userId,
          id,
          expected,
          requireIdempotencyKey(request),
        );
        return {
          status: 200,
          body: result.session,
          headers: { ETag: etagForVersion(result.session.version) },
          outbox: result.tasks.map((task) => ({
            topic: 'task.created',
            taskId: task.id,
            version: task.version,
          })),
        };
      }),
    pauseIntakeSession: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const session = await runtime.intake.pause(
          auth.userId,
          id,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    resumeIntakeSession: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const session = await runtime.intake.resume(
          auth.userId,
          id,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    cancelIntakeSession: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const session = await runtime.intake.cancel(
          auth.userId,
          id,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    enterManualIntakeMode: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as IntakeSessionIdParams).id as Id;
        const session = await runtime.intake.enterManual(
          auth.userId,
          id,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: session,
          headers: { ETag: etagForVersion(session.version) },
        };
      }),
    listDocuments: async (request, reply) => {
      const auth = currentAuth(request);
      const query = request.query as ContextDocumentListQuery;
      const page = await runtime.notes.list(auth.userId, {
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.targetKind === undefined ? {} : { targetKind: query.targetKind }),
        ...(query.targetId === undefined ? {} : { targetId: query.targetId as Id }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      const body = { items: page.items.map((note) => toDocumentDto(note)), nextCursor: page.nextCursor };
      const etag = etagForBody(body);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(body);
    },
    createDocument: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const input = request.body as ContextDocumentCreate;
        const note = await runtime.notes.create(auth.userId, {
          title: input.title,
          ...(input.bodyMd === undefined ? {} : { bodyMd: input.bodyMd }),
          ...(input.sensitivity === undefined ? {} : { sensitivity: input.sensitivity }),
          ...(input.llmAllowed === undefined ? {} : { llmAllowed: input.llmAllowed }),
          ...(input.links === undefined
            ? {}
            : {
                links: input.links.map((link) => ({
                  targetKind: link.targetKind,
                  targetId: link.targetId as Id,
                })),
              }),
        });
        return {
          status: 201,
          body: toDocumentDto(note),
          headers: { ETag: etagForVersion(note.version) },
        };
      }),
    getDocument: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as ContextDocumentIdParams).id as Id;
      const note = await runtime.notes.get(auth.userId, id);
      const etag = etagForVersion(note.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(toDocumentDto(note));
    },
    updateDocument: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as ContextDocumentIdParams).id as Id;
        const patch = request.body as ContextDocumentPatch;
        const note = await runtime.notes.update(
          auth.userId,
          id,
          {
            ...(patch.title === undefined ? {} : { title: patch.title }),
            ...(patch.bodyMd === undefined ? {} : { bodyMd: patch.bodyMd }),
            ...(patch.sensitivity === undefined ? {} : { sensitivity: patch.sensitivity }),
            ...(patch.llmAllowed === undefined ? {} : { llmAllowed: patch.llmAllowed }),
          },
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: toDocumentDto(note),
          headers: { ETag: etagForVersion(note.version) },
        };
      }),
    deleteDocument: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as ContextDocumentIdParams).id as Id;
        await runtime.notes.remove(auth.userId, id, requireIfMatch(request));
        return { status: 204 };
      }),
    addDocumentLink: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as ContextDocumentIdParams).id as Id;
        const input = request.body as DocumentLinkCreate;
        const note = await runtime.notes.addLink(
          auth.userId,
          id,
          { kind: input.targetKind, id: input.targetId as Id },
          requireIfMatch(request),
        );
        return {
          status: 201,
          body: toDocumentDto(note),
          headers: { ETag: etagForVersion(note.version) },
        };
      }),
    removeDocumentLink: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const params = request.params as DocumentLinkParams;
        const note = await runtime.notes.removeLink(
          auth.userId,
          params.id as Id,
          params.linkId as Id,
          requireIfMatch(request),
        );
        return {
          status: 200,
          body: toDocumentDto(note),
          headers: { ETag: etagForVersion(note.version) },
        };
      }),
    listDocumentAiUsage: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as ContextDocumentIdParams).id as Id;
      const query = request.query as NoteAiUsageListQuery;
      const page = await runtime.notes.listAiUsage(auth.userId, id, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
      const body = { items: page.items.map((usage) => toNoteUsageDto(usage)), nextCursor: page.nextCursor };
      const etag = etagForBody(body);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(body);
    },
    promoteTaskDescription: async (request, reply) =>
      runIdempotent(runtime, request, reply, async () => {
        const auth = currentAuth(request);
        const id = (request.params as TaskIdParams).id as Id;
        const note = await runtime.notes.promoteTaskDescription(
          auth.userId,
          id,
          requireIfMatch(request),
        );
        return {
          status: 201,
          body: toDocumentDto(note),
          headers: { ETag: etagForVersion(note.version) },
        };
      }),
    listTaskTemplates: async (request, reply) => {
      const auth = currentAuth(request);
      const page = await runtime.intake.listTemplates(
        auth.userId,
        request.query as TaskTemplateListQuery,
      );
      const body = { items: page.items, nextCursor: page.nextCursor };
      const etag = etagForBody(body);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(body);
    },
    getTaskTemplate: async (request, reply) => {
      const auth = currentAuth(request);
      const id = (request.params as TaskTemplateIdParams).id as Id;
      const template: TaskTemplate = await runtime.intake.getTemplate(auth.userId, id);
      const etag = etagForVersion(template.version);
      if (ifNoneMatch(request, etag)) return reply.code(304).header('ETag', etag).send();
      return reply.code(200).header('ETag', etag).send(template);
    },
  };
}

/**
 * `/tasks/{id}:complete` -> `/tasks/:id([^:]+)::complete`. find-my-way needs the
 * `::` escape for a static action suffix; the bare `:id:complete` form would
 * swallow every POST /tasks/<x> (including /tasks/<id> and other actions).
 */
export function toFastifyPath(path: string): string {
  const withCollectionAction = path.replace(
    /\/([^/{}]+):([A-Za-z][A-Za-z0-9-]*)$/,
    '/$1::$2',
  );
  const withActions = withCollectionAction.replace(
    /\{([^}]+)\}:([A-Za-z][A-Za-z0-9-]*)$/,
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
        csrfTokenHash: session.csrfTokenHash,
      };
    }
    if (meta.requiresCsrf) verifyCsrf(request);
    if (meta.requireIfMatch) {
      if (
        meta.operationId === 'approvePlanCandidate' ||
        meta.operationId === 'approveTodayProposal' ||
        meta.operationId === 'approveReplanProposal' ||
        meta.operationId === 'putAvailability'
      ) {
        requireAvailabilityIfMatch(request);
      } else {
        requireIfMatch(request);
      }
    }
    if (meta.requireIdempotency) requireIdempotencyKey(request);
  };
}

export function registerRoutes(app: FastifyInstance, runtime: RouteRuntime): void {
  const handlers = buildHandlers(runtime);
  for (const route of [
    ...routes,
    ...planningRoutes,
    ...dailyRoutes,
    ...replanningRoutes,
    ...notesRoutes,
  ]) {
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
  ids: IdGenerator;
  db: Kysely<Database>;
  users: UserRepository;
  sessions: SessionStore;
  idempotency: IdempotencyStore;
  auth: AuthService;
  repos: AppRepositories;
  planningStore: PlanningStore;
  llm: LlmPort | null;
  budgetGuard: BudgetGuard;
  /** Ids-only operational logger for background use-cases (never bodies). */
  logger?: { warn(message: string, details?: Readonly<Record<string, unknown>>): void };
}): RouteRuntime {
  const databaseUrl = options.config.databaseUrl;
  const approvalLock =
    databaseUrl !== null && databaseUrl.length > 0
      ? new PgIntakeApprovalLock({ connectionString: databaseUrl })
      : new InProcessIntakeApprovalLock();
  const noteStore = new PgNoteStore({ db: options.db, clock: options.clock });
  const intake = new IntakeService({
    clock: options.clock,
    ids: options.ids,
    notes: noteStore,
    sessions: new PgIntakeSessionRepository(options.db, options.clock, options.ids),
    templates: new PgTaskTemplateRepository(options.db),
    agentRuns: new PgAgentRunRepository(options.db),
    approvals: new PgIntakeApprovalRepository(options.db, options.clock),
    approvalLock,
    providerMaxCallMs: options.config.providerMaxCallMs,
    tasks: options.repos.tasks,
    llm: options.llm,
    llmProvider: options.config.llmProvider,
    budgetGuard: options.budgetGuard,
    promptLimits: llmPromptLimits(options.config),
    // FU-89: generated text follows the owner's locale (ko-KR when missing/invalid).
    ownerLocales: { localeOf: async (ownerId) => (await options.users.get(ownerId))?.locale ?? null },
  });
  const todayStore = new PgTodayStore({
    db: options.db,
    clock: options.clock,
    ids: options.ids,
  });
  const today = new TodayService({
    tasks: options.repos.tasks,
    planning: options.planningStore,
    today: todayStore,
    clock: options.clock,
    ids: options.ids,
  });
  const estimation = new EstimationService({
    store: new PgEstimationStore({ db: options.db, ids: options.ids }),
    clock: options.clock,
  });
  const sessions = new SessionService({
    store: new PgWorkSessionStore({ db: options.db }),
    clock: options.clock,
    ids: options.ids,
    estimation: {
      baseP50: (ownerId, taskId) => estimation.baseP50(ownerId, taskId),
      afterReview: (ownerId, feedbackId) => estimation.refreshAfterReview(ownerId, feedbackId),
    },
  });
  const replan = new ReplanService({
    tasks: options.repos.tasks,
    planning: options.planningStore,
    store: new PgReplanStore({ db: options.db, clock: options.clock, ids: options.ids }),
    clock: options.clock,
    ids: options.ids,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const notifications = new PgNotificationStore({ db: options.db, ids: options.ids });
  const pushSubscriptions = new PgPushSubscriptionStore({
    db: options.db,
    ids: options.ids,
    key: resolvePushKey(options.config),
    clock: options.clock,
  });
  const exportStore = new PgExportStore({ db: options.db, clock: options.clock });
  const exports = new ExportService({
    store: exportStore,
    builder: new PgExportPayloadBuilder({ db: options.db }),
    clock: options.clock,
    ids: options.ids,
  });
  return {
    config: options.config,
    clock: options.clock,
    users: options.users,
    sessions: options.sessions,
    idempotency: options.idempotency,
    auth: options.auth,
    projects: new ProjectService(options.repos.projects),
    tasks: new TaskService(options.repos.tasks),
    planning: new PlanService({
      tasks: options.repos.tasks,
      store: options.planningStore,
      clock: options.clock,
    }),
    intake,
    today,
    workSessions: sessions,
    notifications,
    pushSubscriptions,
    exports,
    replan,
    estimation,
    notes: new NotesService({
      store: noteStore,
      tasks: options.repos.tasks,
      projects: options.repos.projects,
      ids: options.ids,
    }),
  };
}
