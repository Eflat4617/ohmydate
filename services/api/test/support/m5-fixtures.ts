import { randomUUID } from 'node:crypto';
import type { Plan, PlanVersionDto, ReplanProposal } from '@ohmydate/contracts';
import type { Id, Instant, Task } from '@ohmydate/domain';
import { PgPlanningStore } from '../../src/adapters/pg-planning-store.js';
import { PgReplanStore } from '../../src/adapters/pg-replan-store.js';
import { ReplanService } from '../../src/application/replan-service.js';
import {
  authHeaders,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './test-context.js';

export const M5_AVAILABILITY = {
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '18:00',
    kind: 'work',
  })),
  exceptions: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 480,
    breakMin: 15,
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
    riskLevel: 'p50',
  },
};

export const M5_HORIZON = {
  start: '2026-11-11T00:00:00Z',
  end: '2026-11-14T00:00:00Z',
};

export async function seedPlanTask(
  ctx: TestContext,
  ownerId: Id,
  options: {
    readonly title?: string;
    readonly estimate?: { readonly p50Min: number; readonly p90Min: number };
    readonly dueAt?: string;
    readonly dependsOn?: readonly Id[];
    readonly method?: 'prior' | 'template' | 'personal' | 'llm';
  } = {},
): Promise<Task> {
  const project = await ctx.repos.projects.create(ownerId, { title: 'M5 project' }, randomUUID());
  await ctx.db
    .insertInto('project')
    .values({ id: project.id, owner_id: ownerId, title: project.title, kind: 'normal' })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
  const task = await ctx.repos.tasks.create(
    ownerId,
    {
      projectId: project.id,
      title: options.title ?? 'M5 task',
      splittable: true,
      session: { minMinutes: 30, maxMinutes: 120 },
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as Instant }),
      ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
    },
    randomUUID(),
  );
  await ctx.db
    .insertInto('task')
    .values({
      id: task.id,
      owner_id: ownerId,
      project_id: project.id,
      title_cache: task.title,
      status_cache: 'todo',
      due_at: options.dueAt === undefined ? null : new Date(Date.parse(options.dueAt)),
      splittable: true,
      min_session_min: 30,
      max_session_min: 120,
      priority: 2,
    })
    .execute();
  const estimate = options.estimate ?? { p50Min: 60, p90Min: 60 };
  await ctx.db
    .insertInto('estimate')
    .values({
      id: ctx.ids.next(),
      owner_id: ownerId,
      task_id: task.id,
      p50_min: estimate.p50Min,
      p90_min: estimate.p90Min,
      method: options.method ?? 'template',
      confidence: 0.6,
      is_current: true,
      created_at: new Date(Date.parse(ctx.clock.now())),
    })
    .execute();
  return task;
}

/**
 * Link a task to a template through the intake approval ledger (the path the
 * estimator uses to find a task's template group).
 */
export async function linkTaskToTemplate(
  ctx: TestContext,
  ownerId: Id,
  taskId: Id,
  templateId: Id,
): Promise<void> {
  const sessionId = ctx.ids.next();
  await ctx.db
    .insertInto('intake_session')
    .values({
      id: sessionId,
      owner_id: ownerId,
      state: 'feasibility_check',
      input: JSON.stringify({ title: 'linked' }) as never,
      template_id: templateId,
    })
    .execute();
  await ctx.db
    .insertInto('intake_approval')
    .values({
      session_id: sessionId,
      owner_id: ownerId,
      draft_version: 1,
      state: 'completed',
      lease_expires_at: new Date(Date.parse(ctx.clock.now())),
      idempotency_key: randomUUID(),
    })
    .execute();
  await ctx.db
    .insertInto('intake_approval_step')
    .values({
      session_id: sessionId,
      step_key: 's1',
      planned_task_id: taskId,
      state: 'created',
      task_id: taskId,
    })
    .execute();
}

export async function availabilityVersion(ctx: TestContext, session: TestSession): Promise<number> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: '/api/v1/availability',
    headers: authHeaders(session),
  });
  return (response.json() as { version: number }).version;
}

export async function putM5Availability(ctx: TestContext, session: TestSession): Promise<number> {
  const expected = await availabilityVersion(ctx, session);
  const response = await ctx.app.inject({
    method: 'PUT',
    url: '/api/v1/availability',
    headers: authHeaders(session, {
      'if-match': `W/"availability:${expected}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: M5_AVAILABILITY,
  });
  if (response.statusCode !== 200) {
    throw new Error(`availability PUT failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { version: number }).version;
}

/** POST /plans + approve the first candidate; returns the plan and version. */
export async function approvedPlan(
  ctx: TestContext,
  session: TestSession,
  taskIds: readonly string[],
  policy: 'front_loaded' | 'balanced' | 'focus_blocked' = 'front_loaded',
): Promise<{ plan: Plan; version: PlanVersionDto }> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/plans',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload: { scope: { taskIds }, policies: [policy], horizon: M5_HORIZON },
  });
  if (created.statusCode !== 201) {
    throw new Error(`plan create failed: ${created.statusCode} ${created.body}`);
  }
  const plan = created.json() as Plan;
  const candidate = plan.candidates[0];
  if (candidate === undefined || !candidate.feasible) {
    throw new Error(`no feasible candidate: ${created.body}`);
  }
  const approved = await ctx.app.inject({
    method: 'POST',
    url: `/api/v1/plans/${plan.id}/candidates/${candidate.id}:approve`,
    headers: authHeaders(session, {
      'if-match': `W/"availability:${plan.availabilityVersion}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: {},
  });
  if (approved.statusCode !== 201) {
    throw new Error(`plan approve failed: ${approved.statusCode} ${approved.body}`);
  }
  return { plan, version: approved.json() as PlanVersionDto };
}

/** A second ReplanService over the same schema (the detection job's view). */
export function replanServiceFor(ctx: TestContext): ReplanService {
  return new ReplanService({
    tasks: ctx.repos.tasks,
    planning: new PgPlanningStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids }),
    store: new PgReplanStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids }),
    clock: ctx.clock,
    ids: ctx.ids,
  });
}

export async function listProposals(
  ctx: TestContext,
  session: TestSession,
  state?: string,
): Promise<ReplanProposal[]> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/replan-proposals${state === undefined ? '' : `?state=${state}`}`,
    headers: authHeaders(session),
  });
  if (response.statusCode !== 200) {
    throw new Error(`list failed: ${response.statusCode} ${response.body}`);
  }
  return (response.json() as { items: ReplanProposal[] }).items;
}

export async function requestReplan(
  ctx: TestContext,
  session: TestSession,
  body: Record<string, unknown>,
) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/replan-proposals:request',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload: body,
  });
}

export async function approveProposal(
  ctx: TestContext,
  session: TestSession,
  proposal: Pick<ReplanProposal, 'id' | 'availabilityVersion'>,
  options: { readonly ifMatch?: string; readonly key?: string; readonly body?: unknown } = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/replan-proposals/${proposal.id}:approve`,
    headers: authHeaders(session, {
      'if-match': options.ifMatch ?? `W/"availability:${proposal.availabilityVersion}"`,
      'idempotency-key': options.key ?? newIdempotencyKey(),
    }),
    payload: options.body ?? {},
  });
}

export async function rejectProposal(
  ctx: TestContext,
  session: TestSession,
  proposal: Pick<ReplanProposal, 'id' | 'version'>,
  options: { readonly ifMatch?: string; readonly reason?: string } = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/replan-proposals/${proposal.id}:reject`,
    headers: authHeaders(session, {
      'if-match': options.ifMatch ?? `W/"${proposal.version}"`,
      'idempotency-key': newIdempotencyKey(),
    }),
    payload: options.reason === undefined ? {} : { reason: options.reason },
  });
}

export function minutesOf(blocks: readonly { startAt: string; endAt: string; taskId: string }[], taskId: string): number {
  return blocks
    .filter((block) => block.taskId === taskId)
    .reduce((sum, block) => sum + (Date.parse(block.endAt) - Date.parse(block.startAt)) / 60_000, 0);
}
