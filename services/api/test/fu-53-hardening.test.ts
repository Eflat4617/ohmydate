import type { Id, Instant } from '@ohmydate/domain';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import pg from 'pg';
import { PgExportPayloadBuilder, PgExportStore } from '../src/adapters/pg-export-store.js';
import type { Database } from '../src/db/types.js';
import { PlanService } from '../src/application/plan-service.js';
import {
  EXPORT_TOO_LARGE_MESSAGE,
  ExportService,
  type ExportStore,
} from '../src/application/export-service.js';
import type { PlanningStore } from '../src/application/planning-ports.js';
import {
  authHeaders,
  createTestContext,
  databaseUrl,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { seedActivePlan, seedAvailability, seedM4Task } from './support/m4-fixtures.js';

const { Client } = pg;

const DAY = '2026-11-12';
const HORIZON = {
  horizonStart: '2026-11-12T00:00:00Z',
  horizonEnd: '2026-11-15T00:00:00Z',
};

async function setupToday(
  ctx: TestContext,
): Promise<{ ownerId: Id; alice: TestSession; taskId: Id; planVersionId: Id; blockId: Id }> {
  const ownerId = await ctx.seedUser({ email: 'fu53@example.com', password: 'correct-horse' });
  ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
  const alice = await login(ctx, 'fu53@example.com', 'correct-horse');
  await seedAvailability(ctx, ownerId);
  const seeded = await seedM4Task(ctx, ownerId, {
    title: 'FU-53 task',
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

async function waitForLockWaiters(
  ctx: TestContext,
  table: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await sql<{ waiting: number }>`
      select count(*)::int as waiting
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and query like ${`%${ctx.schema}%`}
         and query like ${`%${table}%`}
    `.execute(ctx.db);
    if (Number(result.rows[0]?.waiting ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${String(count)} lock waiters on ${table}`);
}

describe.skipIf(!hasDatabase)('FU-53 daily API hardening', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('(a) approval racing after the preflight commits exactly once; the loser is 409', async () => {
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
    const { id: proposalId } = propose.json() as { id: string };

    // Pause between the TodayService preflight (which reads an unlocked
    // snapshot) and the store approval (which locks this row): both requests
    // pass preflight, then queue on the availability row until released. A
    // dedicated connection keeps the barrier out of the application pool.
    const barrier = new Client({ connectionString: databaseUrl as string });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query(
        `SELECT "version" FROM "${ctx.schema}"."user_availability_version" WHERE "owner_id" = $1 FOR UPDATE`,
        [fixture.ownerId],
      );

      const approve = () =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/today/proposals/${proposalId}:approve`,
          headers: authHeaders(fixture.alice, {
            'if-match': 'W/"availability:1"',
            'idempotency-key': newIdempotencyKey(),
          }),
        });
      const first = approve();
      const second = approve();
      await waitForLockWaiters(ctx, 'user_availability_version', 2);
      await barrier.query('COMMIT');

      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
      const conflict = responses.find((response) => response.statusCode === 409);
      expect(conflict?.json()).toMatchObject({ code: 'illegal_transition' });
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end().catch(() => undefined);
    }

    const versions = await ctx.db
      .selectFrom('plan_version')
      .select('seq')
      .where('owner_id', '=', fixture.ownerId)
      .orderBy('seq', 'asc')
      .execute();
    expect(versions.map((row) => row.seq)).toEqual([1, 2]);
  });

  test('(b) two distinct paused sessions resuming concurrently leave exactly one active', async () => {
    const fixture = await setupToday(ctx);
    const create = async (): Promise<{ id: string; version: number }> => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: authHeaders(fixture.alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          taskId: fixture.taskId,
          blockId: fixture.blockId,
          clientId: 'fu53-device',
          clientStartedAt: '2026-11-12T08:00:00Z',
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      return response.json() as { id: string; version: number };
    };
    const pause = async (session: { id: string; version: number }): Promise<number> => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session.id}:pause`,
        headers: authHeaders(fixture.alice, {
          'if-match': `W/"${String(session.version)}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { clientAt: '2026-11-12T08:01:00Z' },
      });
      expect(response.statusCode, response.body).toBe(200);
      return (response.json() as { version: number }).version;
    };

    const first = await create();
    const firstVersion = await pause(first);
    const second = await create();
    const secondVersion = await pause(second);

    const barrier = new Client({ connectionString: databaseUrl as string });
    await barrier.connect();
    try {
      await barrier.query('BEGIN');
      await barrier.query(
        `SELECT "id" FROM "${ctx.schema}"."work_session"
          WHERE "owner_id" = $1 AND "id" IN ($2, $3) FOR UPDATE`,
        [fixture.ownerId, first.id, second.id],
      );

      const resume = (session: { id: string }, version: number) => () =>
        ctx.app.inject({
          method: 'POST',
          url: `/api/v1/sessions/${session.id}:resume`,
          headers: authHeaders(fixture.alice, {
            'if-match': `W/"${String(version)}"`,
            'idempotency-key': newIdempotencyKey(),
          }),
          payload: { clientAt: '2026-11-12T08:02:00Z' },
        });
      const firstResume = resume(first, firstVersion)();
      const secondResume = resume(second, secondVersion)();
      await waitForLockWaiters(ctx, 'work_session', 2);
      await barrier.query('COMMIT');

      const responses = await Promise.all([firstResume, secondResume]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
      const conflict = responses.find((response) => response.statusCode === 409);
      expect(conflict?.json()).toMatchObject({ code: 'active_session_exists' });

      const winnerIndex = responses.findIndex((response) => response.statusCode === 200);
      const loser = winnerIndex === 0 ? second : first;
      const loserVersion = winnerIndex === 0 ? secondVersion : firstVersion;
      const loserRow = await ctx.db
        .selectFrom('work_session')
        .select(['state', 'version'])
        .where('id', '=', loser.id as Id)
        .executeTakeFirstOrThrow();
      expect(loserRow).toMatchObject({ state: 'paused', version: loserVersion });
    } finally {
      await barrier.query('ROLLBACK').catch(() => undefined);
      await barrier.end().catch(() => undefined);
    }
  });

  test('(M2) malformed schedule-block cursor IDs return 422 validation_failed', async () => {
    const fixture = await setupToday(ctx);
    const page = async (cursor: string) => {
      const query = new URLSearchParams({
        from: '2026-11-12T00:00:00Z',
        to: '2026-11-13T00:00:00Z',
        cursor,
      });
      return ctx.app.inject({
        method: 'GET',
        url: `/api/v1/schedule-blocks?${query.toString()}`,
        headers: authHeaders(fixture.alice),
      });
    };

    const malformed = await page('2026-11-12T10:00:00.000Z|not-a-uuid');
    expect(malformed.statusCode, malformed.body).toBe(422);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });

    const control = await page(`2026-11-12T10:00:00.000Z|${fixture.blockId}`);
    expect(control.statusCode, control.body).toBe(200);
  });

  test('(f) schedule-block pagination pushes range and cursor into SQL with a stable order', async () => {
    const fixture = await setupToday(ctx);
    const extraStarts = [
      '2026-11-12T12:00:00Z',
      '2026-11-12T13:00:00Z',
      '2026-11-12T14:00:00Z',
      '2026-11-12T15:00:00Z',
    ];
    for (const startAt of extraStarts) {
      const startMs = Date.parse(startAt);
      await ctx.db
        .insertInto('schedule_block')
        .values({
          id: ctx.ids.next(),
          owner_id: fixture.ownerId,
          plan_version_id: fixture.planVersionId,
          task_id: fixture.taskId,
          start_at: new Date(startMs),
          end_at: new Date(startMs + 30 * 60_000),
          locked: false,
          status: 'planned',
        })
        .execute();
    }

    const getPage = async (cursor?: string) => {
      const query = new URLSearchParams({
        from: '2026-11-12T00:00:00Z',
        to: '2026-11-13T00:00:00Z',
        limit: '2',
        ...(cursor === undefined ? {} : { cursor }),
      });
      const response = await ctx.app.inject({
        method: 'GET',
        url: `/api/v1/schedule-blocks?${query.toString()}`,
        headers: authHeaders(fixture.alice),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json() as {
        items: Array<{ id: string; startAt: string }>;
        nextCursor: string | null;
      };
    };

    const seen: string[] = [];
    let cursor: string | undefined;
    const pages: Array<{ items: Array<{ id: string; startAt: string }>; nextCursor: string | null }> = [];
    do {
      const page = await getPage(cursor);
      pages.push(page);
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages[0]?.nextCursor).not.toBeNull();
    expect(pages[1]?.nextCursor).not.toBeNull();
    expect(pages[2]?.nextCursor).toBeNull();
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(pages.flatMap((page) => page.items.map((item) => item.startAt))).toEqual([
      '2026-11-12T10:00:00.000Z',
      '2026-11-12T12:00:00.000Z',
      '2026-11-12T13:00:00.000Z',
      '2026-11-12T14:00:00.000Z',
      '2026-11-12T15:00:00.000Z',
    ]);

    // Boundary cursor: resuming exactly at the first page's last startAt must
    // not repeat that row.
    const boundary = await getPage(pages[0]?.nextCursor ?? '');
    expect(boundary.items.map((item) => item.startAt)).toEqual([
      '2026-11-12T13:00:00.000Z',
      '2026-11-12T14:00:00.000Z',
    ]);
  });

  test('(f) schedule-block range is half-open and owner-scoped across pages', async () => {
    const fixture = await setupToday(ctx);
    // Same owner: end == from and start == to are both outside [from, to).
    await ctx.db
      .insertInto('schedule_block')
      .values([
        {
          id: ctx.ids.next(),
          owner_id: fixture.ownerId,
          plan_version_id: fixture.planVersionId,
          task_id: fixture.taskId,
          start_at: new Date('2026-11-11T23:30:00Z'),
          end_at: new Date('2026-11-12T00:00:00Z'),
          locked: false,
          status: 'planned',
        },
        {
          id: ctx.ids.next(),
          owner_id: fixture.ownerId,
          plan_version_id: fixture.planVersionId,
          task_id: fixture.taskId,
          start_at: new Date('2026-11-13T00:00:00Z'),
          end_at: new Date('2026-11-13T00:30:00Z'),
          locked: false,
          status: 'planned',
        },
      ])
      .execute();

    const otherOwner = await ctx.seedUser({
      email: 'fu53-other@example.com',
      password: 'correct-horse',
    });
    await seedAvailability(ctx, otherOwner);
    const otherTask = await seedM4Task(ctx, otherOwner, { title: 'Foreign block' });
    const otherPlan = await seedActivePlan(ctx, otherOwner, otherTask.task.id, {
      ...HORIZON,
      blockStart: '2026-11-12T10:00:00Z',
      blockEnd: '2026-11-12T11:00:00Z',
    });

    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z&limit=1',
      headers: authHeaders(fixture.alice),
    });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    expect(page.items.map((item) => item.id)).toEqual([fixture.blockId]);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.id)).not.toContain(otherPlan.blockId);
  });

  test('(M1) export size guard counts rendered JSON before fetching the next section', async () => {
    const fixture = await setupToday(ctx);
    // Many small rows make the rendered, indented task section much larger
    // than the compact database rows that the previous guard counted.
    const project = await ctx.db
      .selectFrom('project')
      .select('id')
      .where('owner_id', '=', fixture.ownerId)
      .executeTakeFirstOrThrow();
    const rows = Array.from({ length: 1_200 }, (_, index) => ({
      id: ctx.ids.next(),
      owner_id: fixture.ownerId,
      project_id: project.id,
      title_cache: `Rendered row ${String(index)}`,
      status_cache: 'todo' as const,
      due_at: null,
      splittable: true,
      min_session_min: 15,
      max_session_min: 240,
      priority: 2,
      created_at: new Date('2026-11-12T08:00:00Z'),
      updated_at: new Date('2026-11-12T08:00:00Z'),
      version: 1,
    }));
    for (let index = 0; index < rows.length; index += 400) {
      await ctx.db.insertInto('task').values(rows.slice(index, index + 400)).execute();
    }

    // Reference: the same compact raw columns the old guard counted.
    const raw = await ctx.db
      .selectFrom('task')
      .select([
        'id',
        'project_id',
        'title_cache',
        'status_cache',
        'due_at',
        'splittable',
        'min_session_min',
        'max_session_min',
        'priority',
        'created_at',
        'updated_at',
        'deleted_at',
        'version',
      ])
      .where('owner_id', '=', fixture.ownerId)
      .execute();
    const maxBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8') + 1;

    const calls: string[] = [];
    const proxy = new Proxy(ctx.db, {
      get(target, property, receiver) {
        if (property === 'selectFrom') {
          return (table: string) => {
            calls.push(table);
            return target.selectFrom(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Kysely<Database>;

    const store = new PgExportStore({ db: ctx.db, clock: ctx.clock });
    const service = new ExportService({
      store,
      clock: ctx.clock,
      ids: ctx.ids,
      builder: new PgExportPayloadBuilder({ db: proxy, maxBytes }),
    });
    const { exportId } = await service.start(fixture.ownerId);
    expect(calls).toEqual(['task']);

    const row = await ctx.db
      .selectFrom('export_job')
      .select(['state', 'artifact', 'failure_code'])
      .where('id', '=', exportId)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('failed');
    expect(row.artifact).toBeNull();
    expect(row.failure_code).toBe(EXPORT_TOO_LARGE_MESSAGE);
  });

  test('(M1) the incremental artifact is byte-identical to JSON.stringify(..., null, 2)', async () => {
    const fixture = await setupToday(ctx);
    const builder = new PgExportPayloadBuilder({ db: ctx.db });
    const buffer = await builder.build(fixture.ownerId, ctx.clock.now());
    const text = buffer.toString('utf8');
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
  });

  test('(e) oversize exports abort before reading the whole dataset', async () => {
    const fixture = await setupToday(ctx);
    const calls: string[] = [];
    const proxy = new Proxy(ctx.db, {
      get(target, property, receiver) {
        if (property === 'selectFrom') {
          return (table: string) => {
            calls.push(table);
            return target.selectFrom(table as never);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Kysely<Database>;

    const builder = new PgExportPayloadBuilder({ db: proxy, maxBytes: 1 });
    await expect(builder.build(fixture.ownerId, ctx.clock.now())).rejects.toThrow(/50 MB/);
    // Even the wrapper exceeds the one-byte ceiling, so no table is read.
    expect(calls).toEqual([]);
    calls.length = 0;

    const fullBuilder = new PgExportPayloadBuilder({ db: proxy });
    const buffer = await fullBuilder.build(fixture.ownerId, ctx.clock.now());
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(calls).toHaveLength(8);
  });

  test('(d) saveReady failure injection leaves the job without a partial artifact', async () => {
    const fixture = await setupToday(ctx);
    const store = new PgExportStore({ db: ctx.db, clock: ctx.clock });
    const id = ctx.ids.next();
    const now = ctx.clock.now();
    const expiresAt = '2026-11-13T08:00:00Z' as Instant;
    await store.createQueued(fixture.ownerId, id, now);
    await store.markRunning(fixture.ownerId, id, now);

    await sql.raw(
      `CREATE OR REPLACE FUNCTION "${ctx.schema}".reject_export_ready() RETURNS trigger AS $$
         BEGIN
           IF NEW.state = 'ready' THEN
             RAISE EXCEPTION 'injected saveReady failure';
           END IF;
           RETURN NEW;
         END;
       $$ LANGUAGE plpgsql`,
    ).execute(ctx.db);
    await sql.raw(
      `CREATE TRIGGER reject_export_ready BEFORE UPDATE ON "${ctx.schema}".export_job
         FOR EACH ROW EXECUTE FUNCTION "${ctx.schema}".reject_export_ready()`,
    ).execute(ctx.db);
    try {
      await expect(
        store.saveReady(fixture.ownerId, id, Buffer.from('artifact'), now, expiresAt),
      ).rejects.toThrow(/injected saveReady failure/);
      const row = await ctx.db
        .selectFrom('export_job')
        .select(['state', 'artifact', 'size_bytes', 'expires_at'])
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        state: 'running',
        artifact: null,
        size_bytes: null,
        expires_at: null,
      });
    } finally {
      await sql.raw(
        `DROP TRIGGER IF EXISTS reject_export_ready ON "${ctx.schema}".export_job`,
      ).execute(ctx.db);
      await sql.raw(`DROP FUNCTION IF EXISTS "${ctx.schema}".reject_export_ready()`).execute(
        ctx.db,
      );
    }
  });

  test('(d) ExportService marks the job failed, never ready, when saveReady throws', async () => {
    const calls: string[] = [];
    const store: ExportStore = {
      createQueued: async () => {
        calls.push('createQueued');
      },
      markRunning: async () => {
        calls.push('markRunning');
      },
      markFailed: async (_ownerId, _id, code) => {
        calls.push(`markFailed:${code}`);
      },
      saveReady: async () => {
        throw new Error('artifact write failed');
      },
      get: async () => null,
      readArtifact: async () => null,
      purgeExpired: async () => 0,
    };
    const service = new ExportService({
      store,
      clock: ctx.clock,
      ids: ctx.ids,
      builder: { build: async () => Buffer.from('content') },
    });
    await service.start(ctx.ids.next());
    expect(calls).toEqual(['createQueued', 'markRunning', 'markFailed:artifact write failed']);
  });

  test('(f) PlanService passes the window, cursor and limit to the store (no read-all)', async () => {
    const calls: unknown[] = [];
    const store = {
      listScheduleBlocks: async (_ownerId: Id, query: unknown) => {
        calls.push(query);
        return [];
      },
      listActiveBlocks: async () => {
        throw new Error('listActiveBlocks must not be used by the range endpoint');
      },
    } as unknown as PlanningStore;
    const service = new PlanService({
      tasks: {} as never,
      store,
      clock: ctx.clock,
    });
    const page = await service.listScheduleBlocks('owner' as Id, {
      from: '2026-11-12T00:00:00Z',
      to: '2026-11-13T00:00:00Z',
      cursor: '2026-11-12T10:00:00.000Z|0190f000-0000-7000-8000-000000000000',
      limit: 2,
    });
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(calls).toEqual([
      {
        from: '2026-11-12T00:00:00Z',
        to: '2026-11-13T00:00:00Z',
        cursorStartAt: '2026-11-12T10:00:00.000Z',
        cursorId: '0190f000-0000-7000-8000-000000000000',
        limit: 3,
      },
    ]);
  });
});
