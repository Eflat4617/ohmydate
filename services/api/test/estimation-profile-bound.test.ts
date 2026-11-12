import type { Id, Instant } from '@ohmydate/domain';
import { PgEstimationStore } from '../src/adapters/pg-estimation-store.js';
import { MAX_LEARNING_FEEDBACK_ROWS } from '../src/application/estimation-service.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const START = '2026-11-11T08:00:00Z' as Instant;
const ROWS = 5_000;

/**
 * FU-64: the estimator classifies only the newest feedback window. A 5,000-row
 * history must neither be scanned whole nor make a profile request slow, while
 * histories within the bound keep their previous result (see the M5-02
 * estimation-learning suite and the domain estimator tests).
 */
describe.skipIf(!hasDatabase)('estimation feedback window (FU-64)', () => {
  let ctx: TestContext;
  let ownerId: Id;
  let session: TestSession;
  let taskIds: Id[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    ctx.clock.set(START);
    const email = 'fu64-window@example.com';
    ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    session = await login(ctx, email, 'correct-horse');

    const projectId = ctx.ids.next() as Id;
    await ctx.db
      .insertInto('project')
      .values({ id: projectId, owner_id: ownerId, title: 'FU-64 perf', kind: 'normal' })
      .execute();
    const tasks: Array<{ id: Id; owner_id: Id; project_id: Id; status_cache: 'todo' }> = [];
    for (let index = 0; index < ROWS; index += 1) {
      tasks.push({
        id: ctx.ids.next() as Id,
        owner_id: ownerId,
        project_id: projectId,
        status_cache: 'todo',
      });
    }
    for (let offset = 0; offset < tasks.length; offset += 1_000) {
      await ctx.db
        .insertInto('task')
        .values(tasks.slice(offset, offset + 1_000))
        .execute();
    }
    taskIds = tasks.map((task) => task.id);

    const feedback: Array<{
      id: Id;
      owner_id: Id;
      task_id: Id;
      estimated_p50: number;
      actual_focus_min: number;
      created_at: Date;
    }> = [];
    for (let index = 0; index < ROWS; index += 1) {
      feedback.push({
        id: ctx.ids.next() as Id,
        owner_id: ownerId,
        task_id: taskIds[index] as Id,
        estimated_p50: 60,
        actual_focus_min: 60 + (index % 7) * 5,
        created_at: new Date(Date.parse(START) + index * 1_000),
      });
    }
    for (let offset = 0; offset < feedback.length; offset += 1_000) {
      await ctx.db
        .insertInto('estimation_feedback')
        .values(feedback.slice(offset, offset + 1_000))
        .execute();
    }
  });

  afterAll(async () => {
    await ctx.close();
  });

  test('reads only the newest bounded window, never the whole history (negative)', async () => {
    const store = new PgEstimationStore({ db: ctx.db, ids: ctx.ids });
    const snapshot = await store.snapshot(ownerId);
    expect(snapshot.feedback).toHaveLength(MAX_LEARNING_FEEDBACK_ROWS);
    expect(MAX_LEARNING_FEEDBACK_ROWS).toBeLessThan(ROWS);
    const oldest = snapshot.feedback[0];
    expect(oldest?.createdAt).toBe(
      new Date(Date.parse(START) + (ROWS - MAX_LEARNING_FEEDBACK_ROWS) * 1_000).toISOString(),
    );
    const newest = snapshot.feedback.at(-1);
    expect(newest?.createdAt).toBe(
      new Date(Date.parse(START) + (ROWS - 1) * 1_000).toISOString(),
    );
  });

  test('serves a profile request over 5,000 rows within 200 ms of CPU', async () => {
    const profile = async () =>
      ctx.app.inject({
        method: 'GET',
        url: '/api/v1/estimation/profile',
        headers: authHeaders(session),
      });
    // Warm up JIT/route/serialisation caches before timing.
    expect((await profile()).statusCode).toBe(200);

    let bestCpuMs = Number.POSITIVE_INFINITY;
    let bestWallMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cpuStart = process.cpuUsage();
      const wallStart = performance.now();
      const response = await profile();
      const cpu = process.cpuUsage(cpuStart);
      const cpuMs = (cpu.user + cpu.system) / 1_000;
      const wallMs = performance.now() - wallStart;
      expect(response.statusCode).toBe(200);
      const body = response.json() as { sampleCount: number; items: unknown[] };
      expect(body.sampleCount).toBe(MAX_LEARNING_FEEDBACK_ROWS);
      expect(body.items).toHaveLength(MAX_LEARNING_FEEDBACK_ROWS);
      bestCpuMs = Math.min(bestCpuMs, cpuMs);
      bestWallMs = Math.min(bestWallMs, wallMs);
    }
    // CPU time keeps the gate independent of machine load (FU-66 pattern).
    console.log(`profile window perf: cpu=${bestCpuMs.toFixed(1)}ms wall=${bestWallMs.toFixed(1)}ms`);
    expect(bestCpuMs).toBeLessThan(200);
  });

  test('PATCH of a row older than the window returns the row it committed (regression)', async () => {
    const oldest = await ctx.db
      .selectFrom('estimation_feedback')
      .select(['id', 'version'])
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .executeTakeFirstOrThrow();
    const patch = async (version: number, excluded: boolean) =>
      ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/estimation/feedback/${oldest.id}`,
        headers: authHeaders(session, {
          'if-match': `W/"${version}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { excluded },
      });

    const response = await patch(oldest.version, true);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      feedbackId: oldest.id,
      excluded: true,
      version: oldest.version + 1,
    });
    const stored = await ctx.db
      .selectFrom('estimation_feedback')
      .select(['excluded', 'version'])
      .where('owner_id', '=', ownerId)
      .where('id', '=', oldest.id)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ excluded: true, version: oldest.version + 1 });

    // A retry with the version the response advertised behaves consistently.
    const retry = await patch(stored.version, false);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({
      feedbackId: oldest.id,
      excluded: false,
      version: oldest.version + 2,
    });
    expect(
      await ctx.db
        .selectFrom('estimation_feedback')
        .select(['excluded', 'version'])
        .where('owner_id', '=', ownerId)
        .where('id', '=', oldest.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ excluded: false, version: oldest.version + 2 });
  });
});
