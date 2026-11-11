import type { Notification, TodayProposal } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { PgTodayStore } from '../src/adapters/pg-today-store.js';
import { PgExportStore } from '../src/adapters/pg-export-store.js';
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

async function setupToday(
  ctx: TestContext,
): Promise<{ ownerId: Id; alice: TestSession; taskId: Id; planVersionId: Id; blockId: Id }> {
  const ownerId = await ctx.seedUser({ email: 'regress@example.com', password: 'correct-horse' });
  ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
  const alice = await login(ctx, 'regress@example.com', 'correct-horse');
  await seedAvailability(ctx, ownerId);
  const seeded = await seedM4Task(ctx, ownerId, {
    title: 'Regression task',
    dueAt: '2026-11-13T18:00:00Z',
  });
  const plan = await seedActivePlan(ctx, ownerId, seeded.task.id, {
    ...HORIZON,
    blockStart: '2026-11-12T10:00:00Z',
    blockEnd: '2026-11-12T11:00:00Z',
  });
  return {
    ownerId,
    alice,
    taskId: seeded.task.id,
    planVersionId: plan.planVersionId,
    blockId: plan.blockId,
  };
}

describe.skipIf(!hasDatabase)('M4-02R regressions', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('H1: approval rechecks task liveness inside the TX (soft-delete -> 409, no blocks)', async () => {
    const fixture = await setupToday(ctx);
    const propose = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(fixture.alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { date: DAY, blockId: fixture.blockId, targetMin: 30 },
    });
    expect(propose.statusCode).toBe(201);
    const proposal = propose.json() as TodayProposal;

    // Simulates a provider soft-delete racing the approval after preflight.
    await ctx.db
      .updateTable('task')
      .set({ deleted_at: new Date('2026-11-12T08:05:00Z') })
      .where('id', '=', fixture.taskId)
      .execute();

    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(fixture.alice, {
        'if-match': 'W/"availability:1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json()).toMatchObject({ code: 'illegal_transition' });

    const versions = await ctx.db
      .selectFrom('plan_version')
      .select(['seq'])
      .where('owner_id', '=', fixture.ownerId)
      .execute();
    expect(versions.map((row) => row.seq)).toEqual([1]);
  });

  test('H3: a 250-block proposal persists through the dedicated proposal table', async () => {
    const fixture = await setupToday(ctx);
    const store = new PgTodayStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids });
    const blocks = Array.from({ length: 250 }, (_, index) => {
      const startMs = Date.parse('2026-11-12T10:00:00Z') + index * 30 * 60_000;
      return {
        taskId: fixture.taskId,
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(startMs + 30 * 60_000).toISOString(),
      };
    });
    const record = await store.createProposal({
      id: ctx.ids.next(),
      ownerId: fixture.ownerId,
      planId: (await ctx.db.selectFrom('plan').select('id').where('owner_id', '=', fixture.ownerId).executeTakeFirstOrThrow()).id as Id,
      kind: 'reschedule',
      date: DAY,
      timeZone: 'UTC',
      blocks: [{ blockId: fixture.blockId, taskId: fixture.taskId, startAt: blocks[0]!.startAt, endAt: blocks[0]!.endAt }],
      candidateBlocks: blocks,
      basePlanVersionId: fixture.planVersionId,
      basePlanVersion: 3,
      availabilityVersion: 1,
      expiresAt: '2026-11-13T08:00:00Z' as Instant,
      now: ctx.clock.now(),
    });
    expect(record.candidateBlocks).toHaveLength(250);
  });

  test('M: resume while another session is active returns 409 active_session_exists', async () => {
    const fixture = await setupToday(ctx);
    const create = async () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: authHeaders(fixture.alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          taskId: fixture.taskId,
          clientId: 'device',
          clientStartedAt: '2026-11-12T08:00:00Z',
        },
      });
    const first = (await create()).json() as { id: string; version: number };
    const pause = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${first.id}:pause`,
      headers: authHeaders(fixture.alice, {
        'if-match': `W/"${String(first.version)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:01:00Z' },
    });
    const paused = pause.json() as { version: number };
    expect(pause.statusCode).toBe(200);

    const second = await create();
    expect(second.statusCode).toBe(201);

    const resume = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${first.id}:resume`,
        headers: authHeaders(fixture.alice, {
          'if-match': `W/"${String(paused.version)}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { clientAt: '2026-11-12T08:02:00Z' },
      });
    const sequential = await resume();
    expect(sequential.statusCode).toBe(409);
    expect(sequential.json()).toMatchObject({ code: 'active_session_exists' });

    const concurrent = await Promise.all([resume(), resume()]);
    expect(concurrent.map((response) => response.statusCode)).toEqual([409, 409]);
    for (const response of concurrent) {
      expect(response.json()).toMatchObject({ code: 'active_session_exists' });
    }
  });

  test('M: dismissing a sent notification preserves sentAt on the row and replay', async () => {
    const fixture = await setupToday(ctx);
    await ctx.db
      .updateTable('schedule_block')
      .set({
        start_at: new Date('2026-11-12T08:05:00Z'),
        end_at: new Date('2026-11-12T09:05:00Z'),
      })
      .where('id', '=', fixture.blockId)
      .execute();
    const { PgNotificationStore } = await import('../src/adapters/pg-notification-store.js');
    const store = new PgNotificationStore({ db: ctx.db, ids: ctx.ids });
    await store.runUpcoming(ctx.clock.now());
    const row = await ctx.db
      .selectFrom('notification')
      .selectAll()
      .where('owner_id', '=', fixture.ownerId)
      .executeTakeFirstOrThrow();
    expect(row.sent_at).not.toBeNull();

    const headers = authHeaders(fixture.alice, {
      'if-match': `W/"${String(row.version)}"`,
      'idempotency-key': newIdempotencyKey(),
    });
    const dismiss = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${row.id}:dismiss`,
      headers,
    });
    expect(dismiss.statusCode).toBe(200);
    const body = dismiss.json() as Notification;
    expect(body.sentAt).toBe(row.sent_at?.toISOString());
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${row.id}:dismiss`,
      headers,
    });
    expect(replay.statusCode).toBe(200);
    expect((replay.json() as Notification).sentAt).toBe(row.sent_at?.toISOString());
    const after = await ctx.db
      .selectFrom('notification')
      .select(['sent_at', 'state'])
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();
    expect(after.state).toBe('dismissed');
    expect(after.sent_at?.toISOString()).toBe(row.sent_at?.toISOString());
  });

  test('M: expired exports are not downloadable and purge clears artifacts', async () => {
    const fixture = await setupToday(ctx);
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: authHeaders(fixture.alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: {},
    });
    expect(start.statusCode).toBe(202);
    const { exportId } = start.json() as { exportId: string };
    const ready = await ctx.db
      .selectFrom('export_job')
      .select(['state', 'artifact', 'content_type', 'size_bytes'])
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    expect(ready.state).toBe('ready');
    expect(ready.artifact).not.toBeNull();
    expect(ready.content_type).toBe('application/json');
    expect(ready.size_bytes).toBe(ready.artifact?.byteLength);
    const artifactJob = await ctx.db
      .selectFrom('job')
      .select('id')
      .where('id', '=', exportId)
      .executeTakeFirst();
    expect(artifactJob).toBeUndefined();
    ctx.clock.set('2026-11-13T09:00:00Z' as Instant);

    const metadata = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: authHeaders(fixture.alice),
    });
    expect(metadata.statusCode).toBe(404);
    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}?download=1`,
      headers: authHeaders(fixture.alice),
    });
    expect(download.statusCode).toBe(404);

    const store = new PgExportStore({ db: ctx.db });
    const purged = await store.purgeExpired(ctx.clock.now());
    expect(purged).toBeGreaterThanOrEqual(1);
    const row = await ctx.db
      .selectFrom('export_job')
      .select(['artifact', 'state'])
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    expect(row.artifact).toBeNull();
    expect(row.state).toBe('ready');
  });
});
