import type { PlanVersionDto, Today, TodayProposal } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { seedActivePlan, seedAvailability, seedM4Task } from './support/m4-fixtures.js';

const DAY = '2026-11-12';
const HORIZON = {
  horizonStart: '2026-11-12T00:00:00Z',
  horizonEnd: '2026-11-15T00:00:00Z',
};

describe.skipIf(!hasDatabase)('today API (M4-02)', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let ownerId: Id;
  let taskId: Id;

  beforeEach(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.seedUser({ email: 'today@example.com', password: 'correct-horse' });
    ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
    alice = await login(ctx, 'today@example.com', 'correct-horse');
    await seedAvailability(ctx, ownerId);
    const seeded = await seedM4Task(ctx, ownerId, {
      title: 'Write report',
      dueAt: '2026-11-13T18:00:00Z',
      p50Min: 60,
      p90Min: 60,
    });
    taskId = seeded.task.id;
    await seedActivePlan(ctx, ownerId, taskId, {
      ...HORIZON,
      blockStart: '2026-11-12T10:00:00Z',
      blockEnd: '2026-11-12T11:00:00Z',
    });
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('GET /today returns recommended blocks, slack, risk and plan ETag', async () => {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/today?date=${DAY}`,
      headers: authHeaders(alice),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('W/"3"');
    const body = response.json() as Today;
    expect(body).toMatchObject({
      date: DAY,
      timeZone: 'UTC',
      version: 3,
      risk: { level: 'low' },
    });
    expect(body.blocks).toHaveLength(1);
    expect(body.blocks[0]).toMatchObject({
      taskId,
      title: 'Write report',
      startAt: '2026-11-12T10:00:00.000Z',
      status: 'planned',
    });
    expect(body.slackMin).toBeGreaterThan(0);

    const cached = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/today?date=${DAY}`,
      headers: authHeaders(alice, { 'if-none-match': 'W/"3"' }),
    });
    expect(cached.statusCode).toBe(304);
  });

  test('GET /today flags overdue and negative slack as high risk', async () => {
    const overdue = await seedM4Task(ctx, ownerId, {
      title: 'Overdue',
      dueAt: '2026-11-11T18:00:00Z',
    });
    await ctx.db
      .updateTable('plan')
      .set({ scope: JSON.stringify({ taskIds: [taskId, overdue.task.id] }) as never })
      .where('owner_id', '=', ownerId)
      .execute();
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/today?date=${DAY}`,
      headers: authHeaders(alice),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Today;
    expect(body.risk.level).toBe('high');
    expect(body.risk.reasons.join(',')).toContain('task_overdue');
  });

  test('shrink proposal has no side effects and approval creates a plan version', async () => {
    const plan = await ctx.db
      .selectFrom('plan')
      .select(['id', 'current_version_id'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const oldVersionId = plan.current_version_id as Id;
    const block = await ctx.db
      .selectFrom('schedule_block')
      .select('id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();

    const propose = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY, blockId: block.id, targetMin: 30 },
    });
    expect(propose.statusCode).toBe(201);
    const proposal = propose.json() as TodayProposal;
    expect(proposal).toMatchObject({
      kind: 'shrink',
      date: DAY,
      basePlanVersionId: oldVersionId,
      availabilityVersion: 1,
      version: 1,
    });
    expect(proposal.blocks).toHaveLength(1);

    const unchanged = await ctx.db
      .selectFrom('plan')
      .select(['current_version_id', 'version'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(unchanged.current_version_id).toBe(oldVersionId);
    expect(unchanged.version).toBe(3);

    const idempotencyKey = newIdempotencyKey();
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(alice, {
        'if-match': 'W/"availability:1"',
        'idempotency-key': idempotencyKey,
      }),
    });
    expect(approve.statusCode).toBe(201);
    const version = approve.json() as PlanVersionDto;
    expect(version.seq).toBe(2);
    expect(version.reason).toBe('shrink');
    expect(version.blocks).toHaveLength(1);
    expect(version.blocks[0]?.endAt).toBe('2026-11-12T10:30:00.000Z');

    const superseded = await ctx.db
      .selectFrom('schedule_block')
      .select(['status'])
      .where('plan_version_id', '=', oldVersionId)
      .executeTakeFirstOrThrow();
    expect(superseded.status).toBe('superseded');

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(alice, {
        'if-match': 'W/"availability:1"',
        'idempotency-key': idempotencyKey,
      }),
    });
    expect(replay.statusCode).toBe(201);
    expect((replay.json() as PlanVersionDto).id).toBe(version.id);

    const after = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/today?date=${DAY}`,
      headers: authHeaders(alice),
    });
    expect(after.headers['etag']).toBe('W/"4"');
    expect((after.json() as Today).blocks[0]?.endAt).toBe('2026-11-12T10:30:00.000Z');
  });

  test('proposal approval rejects a stale availability version with 412', async () => {
    const block = await ctx.db
      .selectFrom('schedule_block')
      .select('id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const propose = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY, blockId: block.id, targetMin: 30 },
    });
    const proposal = propose.json() as TodayProposal;
    await ctx.db
      .updateTable('user_availability_version')
      .set({ version: 2 })
      .where('owner_id', '=', ownerId)
      .execute();
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(alice, {
        'if-match': 'W/"availability:2"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(approve.statusCode).toBe(412);
    expect(approve.json()).toMatchObject({ code: 'availability_changed' });
  });

  test('reschedule moves an unstarted block later', async () => {
    const block = await ctx.db
      .selectFrom('schedule_block')
      .select('id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:reschedule',
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY, blockIds: [block.id] },
    });
    expect(response.statusCode).toBe(201);
    const proposal = response.json() as TodayProposal;
    expect(proposal.kind).toBe('reschedule');
    expect(Date.parse(proposal.blocks[0]!.startAt)).toBeGreaterThan(Date.parse('2026-11-12T10:00:00Z'));
  });

  test('accept validates If-Match and is side-effect free', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:accept',
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as Today).version).toBe(3);

    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:accept',
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY },
    });
    expect(stale.statusCode).toBe(412);
  });

  test('schedule-block range query supports calendar clients and validates bounds', async () => {
    const page = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z',
      headers: authHeaders(alice),
    });
    expect(page.statusCode).toBe(200);
    const body = page.json() as { items: Array<{ taskId: string; planVersionId: string; status: string }>; nextCursor: string | null };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ taskId, status: 'planned' });
    expect(body.nextCursor).toBeNull();

    const tooWide = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-01-01T00:00:00Z&to=2027-01-03T00:00:00Z',
      headers: authHeaders(alice),
    });
    expect(tooWide.statusCode).toBe(422);
    expect(tooWide.json()).toMatchObject({ code: 'validation_failed' });

    await ctx.seedUser({ email: 'other-blocks@example.com', password: 'correct-horse' });
    const other = await login(ctx, 'other-blocks@example.com', 'correct-horse');
    const isolated = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z',
      headers: authHeaders(other),
    });
    expect(isolated.statusCode).toBe(200);
    expect((isolated.json() as { items: unknown[] }).items).toEqual([]);
  });

  test('other owners cannot see the plan through today actions', async () => {
    await ctx.seedUser({ email: 'other-today@example.com', password: 'correct-horse' });
    const other = await login(ctx, 'other-today@example.com', 'correct-horse');
    const block = await ctx.db
      .selectFrom('schedule_block')
      .select('id')
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    const shrink = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(other, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY, blockId: block.id, targetMin: 30 },
    });
    expect(shrink.statusCode).toBe(404);
  });
});
