import { planningRoutes, type GoalSummary } from '@ohmydate/contracts';
import type { Id } from '@ohmydate/domain';
import { sql } from 'kysely';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

/**
 * FU-98: GET /goals lists the owner's planning goals (one per wizard session)
 * with the tasks each approval created, so the plan picker can offer "one
 * folder per generated plan". Seeds the planner tables directly, the same way
 * the goal-scope test in planning.test.ts does.
 */

/** `GoalPage` is a generic page schema; this is its concrete body. */
interface GoalPage {
  readonly items: readonly GoalSummary[];
  readonly nextCursor: string | null;
}

interface StepSeed {
  readonly key: string;
  readonly taskId: Id;
  readonly state?: 'created' | 'unknown';
}

async function seedGoal(
  ctx: TestContext,
  ownerId: Id,
  options: {
    title: string;
    createdAt: string;
    steps?: readonly StepSeed[];
    deleted?: boolean;
    status?: 'active' | 'completed' | 'archived';
  },
): Promise<Id> {
  const goalId = ctx.ids.next();
  await ctx.db
    .insertInto('goal')
    .values({
      id: goalId,
      owner_id: ownerId,
      title: options.title,
      status: options.status ?? 'active',
      // Microsecond precision on purpose: the keyset must not skip rows that
      // share the cursor's millisecond.
      created_at: sql<Date>`${options.createdAt}::timestamptz`,
      deleted_at: options.deleted === true ? sql<Date>`now()` : null,
    })
    .execute();
  const sessionId = ctx.ids.next();
  await ctx.db
    .insertInto('intake_session')
    .values({ id: sessionId, owner_id: ownerId, goal_id: goalId, state: 'scheduled' })
    .execute();
  const steps = options.steps ?? [];
  if (steps.length > 0) {
    await ctx.db
      .insertInto('intake_approval')
      .values({
        session_id: sessionId,
        owner_id: ownerId,
        draft_version: 1,
        state: 'completed',
        lease_expires_at: new Date(Date.parse('2026-11-11T00:00:00Z')),
        idempotency_key: `goal-${goalId}`,
      })
      .execute();
    for (const step of steps) {
      const created = (step.state ?? 'created') === 'created';
      await ctx.db
        .insertInto('intake_approval_step')
        .values({
          session_id: sessionId,
          step_key: step.key,
          planned_task_id: step.taskId,
          state: step.state ?? 'created',
          task_id: created ? step.taskId : null,
        })
        .execute();
    }
  }
  return goalId;
}

async function listGoals(ctx: TestContext, session: TestSession, query = ''): Promise<GoalPage> {
  const response = await ctx.app.inject({
    method: 'GET',
    url: `/api/v1/goals${query}`,
    headers: authHeaders(session),
  });
  expect(response.statusCode).toBe(200);
  return response.json() as GoalPage;
}

describe.skipIf(!hasDatabase)('GET /goals (FU-98)', () => {
  let ctx: TestContext;
  let aliceId: Id;
  let bobId: Id;
  let alice: TestSession;
  let bob: TestSession;
  let older: Id;
  let newer: Id;
  let deleted: Id;
  let foreign: Id;
  const task = {
    s1: '' as Id,
    s2: '' as Id,
    s10: '' as Id,
    failed: '' as Id,
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    aliceId = await ctx.seedUser({ email: 'goals@example.com', password: 'correct-horse' });
    bobId = await ctx.seedUser({ email: 'goals-other@example.com', password: 'correct-horse' });
    alice = await login(ctx, 'goals@example.com', 'correct-horse');
    bob = await login(ctx, 'goals-other@example.com', 'correct-horse');
    task.s1 = ctx.ids.next();
    task.s2 = ctx.ids.next();
    task.s10 = ctx.ids.next();
    task.failed = ctx.ids.next();
    older = await seedGoal(ctx, aliceId, {
      title: '논문 초안',
      createdAt: '2026-11-10T09:00:00.000100Z',
      // Inserted out of order: the response follows step order s1, s2, s10.
      steps: [
        { key: 's10', taskId: task.s10 },
        { key: 's2', taskId: task.s2 },
        { key: 's1', taskId: task.s1 },
        { key: 's3', taskId: task.failed, state: 'unknown' },
      ],
    });
    newer = await seedGoal(ctx, aliceId, {
      title: '이사 준비',
      createdAt: '2026-11-12T09:00:00.000100Z',
      status: 'completed',
    });
    deleted = await seedGoal(ctx, aliceId, {
      title: '지운 계획',
      createdAt: '2026-11-13T09:00:00Z',
      deleted: true,
      steps: [{ key: 's1', taskId: ctx.ids.next() }],
    });
    foreign = await seedGoal(ctx, bobId, {
      title: 'Bob plan',
      createdAt: '2026-11-11T09:00:00Z',
      steps: [{ key: 's1', taskId: ctx.ids.next() }],
    });
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('the route is part of the served planning table', () => {
    const route = planningRoutes.find((candidate) => candidate.operationId === 'listGoals');
    expect(route).toMatchObject({ method: 'get', path: '/goals' });
  });

  test('lists the owner’s goals newest first with their created task ids in step order', async () => {
    const page = await listGoals(ctx, alice);
    expect(page.items.map((goal) => goal.id)).toEqual([newer, older]);
    expect(page.nextCursor).toBeNull();
    const [first, second] = page.items;
    expect(first).toMatchObject({ id: newer, title: '이사 준비', status: 'completed', taskIds: [] });
    expect(second).toMatchObject({ id: older, title: '논문 초안', status: 'active' });
    expect(second?.taskIds).toEqual([task.s1, task.s2, task.s10]);
  });

  test('negative: a failed step, a deleted goal and another owner’s goal are never listed', async () => {
    const page = await listGoals(ctx, alice);
    const ids = page.items.map((goal) => goal.id);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(foreign);
    expect(page.items.flatMap((goal) => goal.taskIds)).not.toContain(task.failed);

    const bobPage = await listGoals(ctx, bob);
    expect(bobPage.items.map((goal) => goal.id)).toEqual([foreign]);
  });

  test('pages with a createdAt|id cursor and never skips goals created in the same millisecond', async () => {
    const carol = await ctx.seedUser({ email: 'goals-carol@example.com', password: 'correct-horse' });
    const session = await login(ctx, 'goals-carol@example.com', 'correct-horse');
    // Three goals inside one millisecond (different microseconds).
    const a = await seedGoal(ctx, carol, { title: 'A', createdAt: '2026-11-12T10:00:00.123100Z' });
    const b = await seedGoal(ctx, carol, { title: 'B', createdAt: '2026-11-12T10:00:00.123900Z' });
    const c = await seedGoal(ctx, carol, { title: 'C', createdAt: '2026-11-12T10:00:00.123500Z' });
    const d = await seedGoal(ctx, carol, { title: 'D', createdAt: '2026-11-11T10:00:00Z' });

    const seen: Id[] = [];
    let cursor: string | null = null;
    for (let pageCount = 0; pageCount < 10; pageCount += 1) {
      const query: string = cursor === null ? '?limit=1' : `?limit=1&cursor=${encodeURIComponent(cursor)}`;
      const page = await listGoals(ctx, session, query);
      expect(page.items.length).toBeLessThanOrEqual(1);
      seen.push(...page.items.map((goal) => goal.id as Id));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    // Same millisecond → id descending (ids are UUIDv7, so c > b > a).
    expect(seen).toEqual([c, b, a, d]);
  });

  test('negative: a malformed cursor or limit is a 422/400 problem, and anonymous callers get 401', async () => {
    const badCursor = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/goals?cursor=not-a-cursor',
      headers: authHeaders(alice),
    });
    expect(badCursor.statusCode).toBe(422);
    expect(badCursor.json()).toMatchObject({ code: 'validation_failed' });

    const badId = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/goals?cursor=${encodeURIComponent('2026-11-12T00:00:00.000Z|123')}`,
      headers: authHeaders(alice),
    });
    expect(badId.statusCode).toBe(422);

    const badLimit = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/goals?limit=0',
      headers: authHeaders(alice),
    });
    expect([400, 422]).toContain(badLimit.statusCode);

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/v1/goals' });
    expect(anonymous.statusCode).toBe(401);
  });

  test('answers If-None-Match with 304 for an unchanged page', async () => {
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/goals',
      headers: authHeaders(alice),
    });
    const etag = first.headers['etag'];
    expect(typeof etag).toBe('string');
    const again = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/goals',
      headers: authHeaders(alice, { 'if-none-match': String(etag) }),
    });
    expect(again.statusCode).toBe(304);
  });
});
