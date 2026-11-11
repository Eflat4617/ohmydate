import type { EstimationFeedback, WorkSession } from '@ohmydate/contracts';
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

describe.skipIf(!hasDatabase)('focus sessions (M4-02)', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let ownerId: Id;
  let taskId: Id;
  let blockId: Id;

  beforeEach(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.seedUser({ email: 'session@example.com', password: 'correct-horse' });
    ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
    alice = await login(ctx, 'session@example.com', 'correct-horse');
    await seedAvailability(ctx, ownerId);
    const seeded = await seedM4Task(ctx, ownerId, { p50Min: 60, p90Min: 60 });
    taskId = seeded.task.id;
    const plan = await seedActivePlan(ctx, ownerId, taskId, {
      horizonStart: '2026-11-12T00:00:00Z',
      horizonEnd: '2026-11-15T00:00:00Z',
      blockStart: '2026-11-12T10:00:00Z',
      blockEnd: '2026-11-12T11:00:00Z',
    });
    blockId = plan.blockId;
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function startSession(): Promise<WorkSession> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        taskId,
        blockId,
        clientId: 'device-1',
        clientStartedAt: '2026-11-12T08:00:00Z',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as WorkSession;
  }

  test('only one active session exists per owner under concurrency', async () => {
    const make = () =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          taskId,
          blockId,
          clientId: 'device-1',
          clientStartedAt: '2026-11-12T08:00:00Z',
        },
      });
    const responses = await Promise.all([make(), make()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.statusCode === 409);
    expect(conflict?.json()).toMatchObject({ code: 'active_session_exists' });
  });

  test('session read endpoints support resume and owner isolation', async () => {
    const session = await startSession();
    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: authHeaders(alice),
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['etag']).toBe('W/"1"');
    expect((get.json() as WorkSession).id).toBe(session.id);

    const cached = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: authHeaders(alice, { 'if-none-match': 'W/"1"' }),
    });
    expect(cached.statusCode).toBe(304);

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/sessions?state=active',
      headers: authHeaders(alice),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: WorkSession[] }).items).toHaveLength(1);

    await ctx.seedUser({ email: 'other-session@example.com', password: 'correct-horse' });
    const other = await login(ctx, 'other-session@example.com', 'correct-horse');
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}`,
      headers: authHeaders(other),
    });
    expect(hidden.statusCode).toBe(404);
  });

  test('pause/resume/complete compute focused and paused seconds server-side', async () => {
    const session = await startSession();
    expect(session).toMatchObject({ state: 'active', focusedSec: 0, pausedSec: 0, version: 1 });

    ctx.clock.set('2026-11-12T08:10:00Z' as Instant);
    const pause = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:pause`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:10:00Z' },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ state: 'paused', focusedSec: 600, pausedSec: 0, version: 2 });

    ctx.clock.set('2026-11-12T08:15:00Z' as Instant);
    const resume = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:resume`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:15:00Z' },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json()).toMatchObject({ state: 'active', focusedSec: 600, pausedSec: 300, version: 3 });

    ctx.clock.set('2026-11-12T08:25:00Z' as Instant);
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:25:00Z' },
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({
      state: 'completed',
      focusedSec: 1200,
      pausedSec: 300,
      endedAt: '2026-11-12T08:25:00.000Z',
      version: 4,
    });

    const block = await ctx.db
      .selectFrom('schedule_block')
      .select(['status'])
      .where('id', '=', blockId)
      .executeTakeFirstOrThrow();
    expect(block.status).toBe('done');
  });

  test('offline event timestamps are clamped and stale If-Match returns 412', async () => {
    const session = await startSession();
    ctx.clock.set('2026-11-12T08:10:00Z' as Instant);
    const pause = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:pause`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-11T23:00:00Z' },
    });
    expect(pause.statusCode).toBe(200);
    expect(pause.json()).toMatchObject({ focusedSec: 0 });

    const stale = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:resume`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:10:00Z' },
    });
    expect(stale.statusCode).toBe(412);

    const illegal = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:pause`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:11:00Z' },
    });
    expect(illegal.statusCode).toBe(409);
    expect(illegal.json()).toMatchObject({ code: 'session_state_conflict' });
  });

  test('review creates estimation feedback and never logs the note', async () => {
    const session = await startSession();
    ctx.clock.set('2026-11-12T08:50:00Z' as Instant);
    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { clientAt: '2026-11-12T08:50:00Z' },
    });
    expect(complete.statusCode).toBe(200);
    const completed = complete.json() as WorkSession;
    const note = 'private note that must never be logged';
    const review = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/review`,
      headers: authHeaders(alice, {
        'if-match': `W/"${String(completed.version)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { outcome: 'done', reasonChips: ['focus_lost'], note },
    });
    expect(review.statusCode).toBe(201);
    const feedback = review.json() as EstimationFeedback;
    expect(feedback).toMatchObject({
      taskId,
      estimatedP50: 60,
      actualFocusMin: 50,
      quality: 'ok',
    });

    const duplicate = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/review`,
      headers: authHeaders(alice, {
        'if-match': `W/"${String(completed.version)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { outcome: 'done', reasonChips: [] },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'session_state_conflict' });
  });

  test('review before completion returns session_state_conflict', async () => {
    const session = await startSession();
    const review = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/review`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { outcome: 'done', reasonChips: [] },
    });
    expect(review.statusCode).toBe(409);
    expect(review.json()).toMatchObject({ code: 'session_state_conflict' });
  });
});
