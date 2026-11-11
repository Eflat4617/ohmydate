import { randomUUID } from 'node:crypto';
import type { Id, Instant, Task } from '@ohmydate/domain';
import type { TestContext } from './test-context.js';

export interface SeededM4Task {
  readonly task: Task;
  readonly projectId: Id;
}

export async function seedM4Task(
  ctx: TestContext,
  ownerId: Id,
  options: {
    readonly title?: string;
    readonly dueAt?: string;
    readonly p50Min?: number;
    readonly p90Min?: number;
  } = {},
): Promise<SeededM4Task> {
  const project = await ctx.repos.projects.create(
    ownerId,
    { title: 'M4 project' },
    randomUUID(),
  );
  await ctx.db
    .insertInto('project')
    .values({
      id: project.id,
      owner_id: ownerId,
      title: project.title,
      kind: 'normal',
    })
    .execute();
  const task = await ctx.repos.tasks.create(
    ownerId,
    {
      projectId: project.id,
      title: options.title ?? 'M4 task',
      splittable: true,
      ...(options.dueAt === undefined ? {} : { dueAt: options.dueAt as Instant }),
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
      min_session_min: 15,
      max_session_min: 240,
      priority: 2,
    })
    .execute();
  await ctx.db
    .insertInto('estimate')
    .values({
      id: ctx.ids.next(),
      owner_id: ownerId,
      task_id: task.id,
      p50_min: options.p50Min ?? 60,
      p90_min: options.p90Min ?? 60,
      method: 'template',
      confidence: 0.6,
      is_current: true,
    })
    .execute();
  return { task, projectId: project.id };
}

export async function seedAvailability(ctx: TestContext, ownerId: Id): Promise<void> {
  await ctx.db
    .insertInto('user_availability_version')
    .values({
      owner_id: ownerId,
      version: 1,
      time_zone: 'UTC',
      prefs: {
        maxDailyFocusMin: 240,
        breakAfterMin: 60,
        breakMin: 15,
        dayStartLocal: '08:00',
        dayEndLocal: '18:00',
        riskLevel: 'p50',
      } as never,
    })
    .onConflict((oc) => oc.column('owner_id').doNothing())
    .execute();
  for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
    await ctx.db
      .insertInto('availability_rule')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerId,
        weekday,
        start_local: '09:00',
        end_local: '18:00',
        time_zone: 'UTC',
        kind: 'work',
      })
      .execute();
  }
}

export interface SeededPlan {
  readonly planId: Id;
  readonly planVersionId: Id;
  readonly blockId: Id;
  readonly revision: number;
}

export async function seedActivePlan(
  ctx: TestContext,
  ownerId: Id,
  taskId: Id,
  options: {
    readonly blockStart: string;
    readonly blockEnd: string;
    readonly horizonStart: string;
    readonly horizonEnd: string;
  },
): Promise<SeededPlan> {
  const planId = ctx.ids.next();
  const planVersionId = ctx.ids.next();
  const blockId = ctx.ids.next();
  const revision = 3;
  await ctx.db
    .insertInto('plan')
    .values({
      id: planId,
      owner_id: ownerId,
      scope: JSON.stringify({ taskIds: [taskId] }) as never,
      status: 'active',
      availability_version: 1,
      horizon_start: new Date(Date.parse(options.horizonStart)),
      horizon_end: new Date(Date.parse(options.horizonEnd)),
      time_zone: 'UTC',
      version: revision,
    })
    .execute();
  await ctx.db
    .insertInto('plan_version')
    .values({
      id: planVersionId,
      owner_id: ownerId,
      plan_id: planId,
      seq: 1,
      candidate_id: null,
      reason: 'approved',
      created_by: 'user',
      availability_version: 1,
    })
    .execute();
  await ctx.db
    .updateTable('plan')
    .set({ current_version_id: planVersionId })
    .where('id', '=', planId)
    .execute();
  await ctx.db
    .insertInto('schedule_block')
    .values({
      id: blockId,
      owner_id: ownerId,
      plan_version_id: planVersionId,
      task_id: taskId,
      start_at: new Date(Date.parse(options.blockStart)),
      end_at: new Date(Date.parse(options.blockEnd)),
      locked: false,
      status: 'planned',
    })
    .execute();
  return { planId, planVersionId, blockId, revision };
}
