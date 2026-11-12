import type {
  Plan,
  ReplanProposal,
  ScheduleBlockDto,
  Today,
  TodayProposal,
} from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { sql } from 'kysely';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import {
  approveProposal,
  approvedPlan,
  minutesOf,
  putM5Availability,
  requestReplan,
  seedPlanTask,
} from './support/m5-fixtures.js';

/**
 * FU-71: `POST /schedule-blocks/{id}:lock` / `:unlock` (08 §2.5). Locks are
 * honoured everywhere already (06 §7, M5-02R-1 H1); these tests pin the user
 * action itself: If-Match on the block version, Idempotency-Key replay, owner
 * scope, only planned not-started blocks of an active plan, times unchanged,
 * and that the next replan keeps a locked block and may move an unlocked one.
 */

const START = '2026-11-11T08:00:00Z' as Instant;

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!hasDatabase)('schedule block lock/unlock (FU-71)', () => {
  let ctx: TestContext;
  let counter = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  async function newOwner(label: string): Promise<{ ownerId: Id; session: TestSession }> {
    counter += 1;
    const email = `fu71-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  function lockRequest(
    session: TestSession,
    blockId: string,
    action: 'lock' | 'unlock',
    options: { readonly ifMatch?: string | null; readonly key?: string } = {},
  ) {
    const headers: Record<string, string> = { 'idempotency-key': options.key ?? newIdempotencyKey() };
    if (options.ifMatch !== null) headers['if-match'] = options.ifMatch ?? 'W/"1"';
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/schedule-blocks/${blockId}:${action}`,
      headers: authHeaders(session, headers),
    });
  }

  async function blockRow(blockId: string) {
    return ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'status', 'locked', 'start_at', 'end_at', 'version'])
      .where('id', '=', blockId as Id)
      .executeTakeFirstOrThrow();
  }

  async function planVersion(planId: string): Promise<number> {
    const row = await ctx.db
      .selectFrom('plan')
      .select(['version'])
      .where('id', '=', planId as Id)
      .executeTakeFirstOrThrow();
    return row.version;
  }

  async function calendar(session: TestSession): Promise<ScheduleBlockDto[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-11T00:00:00Z&to=2026-11-14T00:00:00Z',
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: ScheduleBlockDto[] }).items;
  }

  /**
   * FU-86 race gate: holds the plan row (`FOR UPDATE`) as a concurrent writer
   * would. Every lock and approval TX takes that row before it reads blocks,
   * so requests sent meanwhile queue on it in the order they arrive (Postgres
   * hands a row lock to its waiters first come, first served).
   */
  async function holdPlanRow(planId: string): Promise<{ pid: number; release: () => Promise<void> }> {
    let open!: () => void;
    const released = new Promise<void>((resolve) => {
      open = resolve;
    });
    let ready!: (pid: number) => void;
    const pidReady = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = ctx.db.transaction().execute(async (trx) => {
      await trx.selectFrom('plan').select('id').where('id', '=', planId as Id).forUpdate().execute();
      const row = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      ready(row.rows[0]?.pid ?? -1);
      await released;
    });
    const pid = await pidReady;
    return {
      pid,
      release: async () => {
        open();
        await holder;
      },
    };
  }

  /** Backends waiting on the holder, directly or behind another waiter in the same queue. */
  async function queuedBehind(holderPid: number): Promise<number> {
    const rows = (
      await sql<{ pid: number; blockers: number[] }>`
        select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where wait_event_type = 'Lock' and datname = current_database()`.execute(ctx.db)
    ).rows;
    const chain = new Set<number>([holderPid]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const row of rows) {
        if (!chain.has(row.pid) && row.blockers.some((pid) => chain.has(pid))) {
          chain.add(row.pid);
          grew = true;
        }
      }
    }
    return chain.size - 1;
  }

  /**
   * Sends `first`, waits until it queues on the held plan row, sends `second`,
   * waits until it queues behind, then releases the row: `first` runs first.
   */
  async function inOrder<A, B>(planId: string, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
    const gate = await holdPlanRow(planId);
    let a: Promise<A> | undefined;
    let b: Promise<B> | undefined;
    try {
      a = first();
      await waitFor(async () => (await queuedBehind(gate.pid)) >= 1, 'the first request to queue on the plan row');
      b = second();
      await waitFor(async () => (await queuedBehind(gate.pid)) >= 2, 'the second request to queue behind it');
    } finally {
      await gate.release();
    }
    return Promise.all([a, b]);
  }

  async function auditActions(blockId: string): Promise<string[]> {
    const rows = await ctx.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', blockId as Id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    return rows.map((row) => row.action);
  }

  async function onePlan(label: string) {
    const owner = await newOwner(label);
    const task = await seedPlanTask(ctx, owner.ownerId, { title: `FU-71 ${label}` });
    const { plan, version } = await approvedPlan(ctx, owner.session, [task.id]);
    const block = version.blocks[0];
    if (block === undefined) throw new Error('approved block missing');
    return { ...owner, task, plan, block };
  }

  test('lock then unlock: times unchanged, block version and plan revision bump, audit has ids only', async () => {
    const { session, plan, block } = await onePlan('toggle');
    const before = await blockRow(block.id);
    const revision = await planVersion(plan.id);
    expect(before.locked).toBe(false);

    const locked = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${before.version}"` });
    expect(locked.statusCode).toBe(200);
    const lockedBody = locked.json() as ScheduleBlockDto;
    expect(lockedBody).toMatchObject({ id: block.id, locked: true, status: 'planned', version: before.version + 1 });
    expect(Date.parse(lockedBody.startAt)).toBe(before.start_at.getTime());
    expect(Date.parse(lockedBody.endAt)).toBe(before.end_at.getTime());
    expect(locked.headers['etag']).toBe(`W/"${before.version + 1}"`);
    expect(await blockRow(block.id)).toMatchObject({
      locked: true,
      start_at: before.start_at,
      end_at: before.end_at,
      version: before.version + 1,
    });
    expect(await planVersion(plan.id)).toBe(revision + 1);
    expect((await calendar(session)).find((item) => item.id === block.id)).toMatchObject({ locked: true });

    const unlocked = await lockRequest(session, block.id, 'unlock', { ifMatch: `W/"${lockedBody.version}"` });
    expect(unlocked.statusCode).toBe(200);
    expect(unlocked.json()).toMatchObject({ id: block.id, locked: false, version: before.version + 2 });
    expect(await blockRow(block.id)).toMatchObject({ locked: false, start_at: before.start_at, end_at: before.end_at });
    expect(await planVersion(plan.id)).toBe(revision + 2);

    const audit = await ctx.db
      .selectFrom('audit_event')
      .select(['actor', 'action', 'entity', 'diff_summary'])
      .where('entity_id', '=', block.id as Id)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
    expect(audit.map((row) => row.action)).toEqual(['schedule_block.locked', 'schedule_block.unlocked']);
    expect(audit.every((row) => row.actor === 'user' && row.entity === 'schedule_block')).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('FU-71 toggle');
  });

  test('Today.version follows the plan revision after a lock (Today actions must refresh)', async () => {
    const { session, block } = await onePlan('today-version');
    const read = async (): Promise<Today> => {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/today?date=2026-11-11',
        headers: authHeaders(session),
      });
      expect(response.statusCode).toBe(200);
      return response.json() as Today;
    };
    const today = await read();
    const response = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` });
    expect(response.statusCode).toBe(200);
    const after = await read();
    expect(after.version).toBe(today.version + 1);
    // An accept pinned to the old revision is a stale precondition (negative).
    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:accept',
      headers: authHeaders(session, { 'if-match': `W/"${today.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11' },
    });
    expect(stale.statusCode).toBe(412);
  });

  test('a stale If-Match is 412 version_conflict and changes nothing; a missing one is 428', async () => {
    const { session, plan, block } = await onePlan('stale');
    const revision = await planVersion(plan.id);
    const stale = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version + 5}"` });
    expect(stale.statusCode).toBe(412);
    expect(stale.headers['content-type']).toContain('application/problem+json');
    expect(stale.json()).toMatchObject({ code: 'version_conflict' });
    expect(await blockRow(block.id)).toMatchObject({ locked: false, version: block.version });
    expect(await planVersion(plan.id)).toBe(revision);

    const missing = await lockRequest(session, block.id, 'lock', { ifMatch: null });
    expect(missing.statusCode).toBe(428);
    expect((await blockRow(block.id)).locked).toBe(false);

    // 412 is not stored: the same key with the right version then succeeds.
    const key = newIdempotencyKey();
    expect((await lockRequest(session, block.id, 'lock', { ifMatch: 'W/"99"', key })).statusCode).toBe(412);
    const retried = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"`, key });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ locked: true });
  });

  test("another owner's block is 404 not_found and stays untouched", async () => {
    const { block } = await onePlan('owner-a');
    const other = await newOwner('owner-b');
    const before = await blockRow(block.id);
    for (const action of ['lock', 'unlock'] as const) {
      const response = await lockRequest(other.session, block.id, action, { ifMatch: `W/"${before.version}"` });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    }
    const unknown = await lockRequest(other.session, '01a1cec5-5000-7008-a1c5-abb08e90622b', 'lock');
    expect(unknown.statusCode).toBe(404);
    expect(await blockRow(block.id)).toEqual(before);
  });

  test('a started, done or superseded block is 409 illegal_transition (history is not lockable)', async () => {
    const { session, plan, block } = await onePlan('history');
    const before = await blockRow(block.id);
    const revision = await planVersion(plan.id);

    // Started: now is one minute past the block start.
    ctx.clock.set(new Date(before.start_at.getTime() + 60_000).toISOString() as Instant);
    const started = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${before.version}"` });
    expect(started.statusCode).toBe(409);
    expect(started.json()).toMatchObject({ code: 'illegal_transition' });
    expect(await blockRow(block.id)).toEqual(before);

    // Exactly at its start the block is still future (06 §7.1) and lockable.
    ctx.clock.set(before.start_at.toISOString() as Instant);
    const atStart = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${before.version}"` });
    expect(atStart.statusCode).toBe(200);
    ctx.clock.set(START);

    // Done (a completed focus session marks it so).
    await ctx.db.updateTable('schedule_block').set({ status: 'done' }).where('id', '=', block.id as Id).execute();
    const done = await lockRequest(session, block.id, 'unlock', { ifMatch: `W/"${before.version + 1}"` });
    expect(done.statusCode).toBe(409);
    expect(done.json()).toMatchObject({ code: 'illegal_transition' });
    expect(await blockRow(block.id)).toMatchObject({ status: 'done', locked: true });

    await ctx.db.updateTable('schedule_block').set({ status: 'superseded' }).where('id', '=', block.id as Id).execute();
    const superseded = await lockRequest(session, block.id, 'unlock', { ifMatch: `W/"${before.version + 1}"` });
    expect(superseded.statusCode).toBe(409);
    expect(await planVersion(plan.id)).toBe(revision + 1);
  });

  test('FU-86: a block of a soft-deleted plan is 404 not_found (lock and unlock) and nothing changes', async () => {
    const { session, plan, block } = await onePlan('deleted-plan');
    await ctx.db
      .updateTable('plan')
      .set({ deleted_at: new Date(START) })
      .where('id', '=', plan.id as Id)
      .execute();
    const before = await blockRow(block.id);
    const revision = await planVersion(plan.id);
    for (const action of ['lock', 'unlock'] as const) {
      const response = await lockRequest(session, block.id, action, { ifMatch: `W/"${before.version}"` });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'not_found' });
    }
    expect(await blockRow(block.id)).toEqual(before);
    expect(await planVersion(plan.id)).toBe(revision);
    expect(await auditActions(block.id)).toEqual([]);
    // Consistent with the calendar, which no longer lists the block.
    expect((await calendar(session)).some((item) => item.id === block.id)).toBe(false);
  });

  test('FU-86: a block of a plan that is not active is 409 illegal_transition and nothing changes', async () => {
    const { session, plan, block } = await onePlan('inactive-plan');
    const before = await blockRow(block.id);
    const revision = await planVersion(plan.id);
    for (const status of ['superseded', 'draft'] as const) {
      await ctx.db.updateTable('plan').set({ status }).where('id', '=', plan.id as Id).execute();
      for (const action of ['lock', 'unlock'] as const) {
        const response = await lockRequest(session, block.id, action, { ifMatch: `W/"${before.version}"` });
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({ code: 'illegal_transition' });
      }
    }
    expect(await blockRow(block.id)).toEqual(before);
    expect(await planVersion(plan.id)).toBe(revision);
    expect(await auditActions(block.id)).toEqual([]);
    // Active again, the same block is lockable (the 409 came from the plan state).
    await ctx.db.updateTable('plan').set({ status: 'active' }).where('id', '=', plan.id as Id).execute();
    const locked = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${before.version}"` });
    expect(locked.statusCode).toBe(200);
  });

  test('the same Idempotency-Key replays the stored answer; a new key on the same state is a no-op', async () => {
    const { session, plan, block } = await onePlan('replay');
    const key = newIdempotencyKey();
    const first = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"`, key });
    expect(first.statusCode).toBe(200);
    const revision = await planVersion(plan.id);
    // The replay is the stored response even though If-Match is now stale.
    const replay = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"`, key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['etag']).toBe(first.headers['etag']);
    expect(await blockRow(block.id)).toMatchObject({ locked: true, version: block.version + 1 });
    expect(await planVersion(plan.id)).toBe(revision);

    // The key is bound to the request: the same key on :unlock is a mismatch.
    const mismatch = await lockRequest(session, block.id, 'unlock', { ifMatch: `W/"${block.version + 1}"`, key });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ code: 'idempotency_mismatch' });

    const again = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version + 1}"` });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ locked: true, version: block.version + 1 });
    expect(await planVersion(plan.id)).toBe(revision);
    const audit = await ctx.db
      .selectFrom('audit_event')
      .select(['action'])
      .where('entity_id', '=', block.id as Id)
      .execute();
    expect(audit).toHaveLength(1);
  });

  test('a pending Today proposal computed before the lock cannot be approved (412 stale revision, nothing moves)', async () => {
    const { session, block } = await onePlan('today-proposal');
    const todayResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/today?date=2026-11-11',
      headers: authHeaders(session),
    });
    const today = todayResponse.json() as Today;
    const shrink = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(session, { 'if-match': `W/"${today.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11', blockId: block.id, targetMin: 30 },
    });
    expect(shrink.statusCode).toBe(201);
    const proposal = shrink.json() as TodayProposal;

    const locked = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` });
    expect(locked.statusCode).toBe(200);
    const approve = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${proposal.availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    // Its base plan revision is gone: the same 412 a Today view answers with a refresh.
    expect(approve.statusCode).toBe(412);
    expect(approve.json()).toMatchObject({ code: 'version_conflict' });
    const row = await blockRow(block.id);
    expect(row).toMatchObject({ status: 'planned', locked: true });
    expect(Date.parse(block.startAt)).toBe(row.start_at.getTime());
    expect(Date.parse(block.endAt)).toBe(row.end_at.getTime());
  });

  test('a pending replan proposal approved after its moved block was locked is rejected; the lock holds', async () => {
    const { ownerId, session } = await newOwner('race-lock');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Race lock' });
    const { plan, version } = await approvedPlan(ctx, session, [task.id]);
    const block = version.blocks[0];
    if (block === undefined) throw new Error('block missing');
    // A commitment over the block makes the replan move it.
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Over the block', startAt: block.startAt, endAt: block.endAt, timeZone: 'UTC' },
    });
    expect(commitment.statusCode).toBe(201);
    const requested = await requestReplan(ctx, session, { planId: plan.id });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    expect(minutesOf(proposal.candidate.blocks, task.id)).toBe(60);
    expect(proposal.candidate.blocks.some((entry) => entry.startAt === block.startAt)).toBe(false);

    const locked = await lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` });
    expect(locked.statusCode).toBe(200);
    const approved = await approveProposal(ctx, session, proposal);
    expect(approved.statusCode).toBe(422);
    expect(approved.json()).toMatchObject({ code: 'constraint_violation' });
    expect(await blockRow(block.id)).toMatchObject({
      status: 'planned',
      locked: true,
      start_at: new Date(block.startAt),
      end_at: new Date(block.endAt),
    });
  });

  test('a pending replan proposal approved after a kept block was unlocked cannot drop that block', async () => {
    const { ownerId, session } = await newOwner('race-unlock');
    const pinned = await seedPlanTask(ctx, ownerId, { title: 'Race pinned' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Race free' });
    const { plan, version } = await approvedPlan(ctx, session, [pinned.id, free.id]);
    const pinnedBlock = version.blocks.find((block) => block.taskId === pinned.id);
    if (pinnedBlock === undefined) throw new Error('block missing');
    const locked = await lockRequest(session, pinnedBlock.id, 'lock', { ifMatch: `W/"${pinnedBlock.version}"` });
    expect(locked.statusCode).toBe(200);
    const requested = await requestReplan(ctx, session, { planId: plan.id });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    // Computed while locked: the candidate leaves the pinned block alone.
    expect(proposal.candidate.blocks.filter((block) => block.taskId === pinned.id)).toEqual([]);

    const unlocked = await lockRequest(session, pinnedBlock.id, 'unlock', {
      ifMatch: `W/"${(locked.json() as ScheduleBlockDto).version}"`,
    });
    expect(unlocked.statusCode).toBe(200);
    const approved = await approveProposal(ctx, session, proposal);
    // Approving would supersede the now-unlocked block without re-placing it.
    expect(approved.statusCode).toBe(422);
    expect(approved.json()).toMatchObject({ code: 'constraint_violation' });
    const live = await ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'status', 'locked'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', pinned.id)
      .where('status', '<>', 'superseded')
      .execute();
    expect(live).toEqual([{ id: pinnedBlock.id, status: 'planned', locked: false }]);
  });

  test('the next replan keeps a block locked through the API and may move it once unlocked', async () => {
    const { ownerId, session } = await newOwner('replan');
    const pinned = await seedPlanTask(ctx, ownerId, { title: 'Pinned' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Free' });
    const { plan, version } = await approvedPlan(ctx, session, [pinned.id, free.id]);
    const pinnedBlock = version.blocks.find((block) => block.taskId === pinned.id);
    const freeBlock = version.blocks.find((block) => block.taskId === free.id);
    if (pinnedBlock === undefined || freeBlock === undefined) throw new Error('blocks missing');

    const locked = await lockRequest(session, pinnedBlock.id, 'lock', { ifMatch: `W/"${pinnedBlock.version}"` });
    expect(locked.statusCode).toBe(200);
    const lockedVersion = (locked.json() as ScheduleBlockDto).version;

    const first = await requestReplan(ctx, session, { planId: plan.id });
    expect(first.statusCode).toBe(201);
    const proposal = first.json() as ReplanProposal;
    expect(proposal.candidate.blocks.filter((block) => block.taskId === pinned.id)).toEqual([]);
    expect(minutesOf(proposal.candidate.blocks, free.id)).toBe(60);
    expect(proposal.before?.blocks.find((block) => block.id === pinnedBlock.id)?.locked).toBe(true);
    const approved = await approveProposal(ctx, session, proposal);
    expect(approved.statusCode).toBe(201);
    expect(await blockRow(pinnedBlock.id)).toMatchObject({
      status: 'planned',
      locked: true,
      version: lockedVersion,
      start_at: new Date(pinnedBlock.startAt),
      end_at: new Date(pinnedBlock.endAt),
    });
    // The free task's old row is history now (superseded): not lockable.
    const supersededLock = await lockRequest(session, freeBlock.id, 'lock', {
      ifMatch: `W/"${(await blockRow(freeBlock.id)).version}"`,
    });
    expect(supersededLock.statusCode).toBe(409);

    const unlocked = await lockRequest(session, pinnedBlock.id, 'unlock', { ifMatch: `W/"${lockedVersion}"` });
    expect(unlocked.statusCode).toBe(200);
    const second = await requestReplan(ctx, session, { planId: plan.id });
    expect(second.statusCode).toBe(201);
    const next = second.json() as ReplanProposal;
    // Unlocked, the block is part of what the candidate replaces and re-places.
    expect(next.before?.blocks.find((block) => block.id === pinnedBlock.id)?.locked).toBe(false);
    expect(minutesOf(next.candidate.blocks, pinned.id)).toBe(60);
    const planAfter = (
      await ctx.app.inject({ method: 'GET', url: `/api/v1/plans/${plan.id}`, headers: authHeaders(session) })
    ).json() as Plan;
    expect(planAfter.status).toBe('active');
  });

  /** An approved one-task plan, a commitment over its block and a replan proposal that moves it. */
  async function proposalMovingBlock(label: string) {
    const { ownerId, session } = await newOwner(label);
    const task = await seedPlanTask(ctx, ownerId, { title: `FU-86 ${label}` });
    const { plan, version } = await approvedPlan(ctx, session, [task.id]);
    const block = version.blocks[0];
    if (block === undefined) throw new Error('block missing');
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Over the block', startAt: block.startAt, endAt: block.endAt, timeZone: 'UTC' },
    });
    expect(commitment.statusCode).toBe(201);
    const requested = await requestReplan(ctx, session, { planId: plan.id });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    expect(proposal.candidate.blocks.some((entry) => entry.startAt === block.startAt)).toBe(false);
    return { ownerId, session, task, plan, block, proposal };
  }

  async function liveBlocks(ownerId: Id, taskId: string) {
    return ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'status', 'locked', 'start_at', 'end_at'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId as Id)
      .where('status', '<>', 'superseded')
      .execute();
  }

  test('FU-86 race, lock first: :lock and a replan approval in flight together — the lock wins, the approval is 422, the block never moves', async () => {
    const { ownerId, session, task, plan, block, proposal } = await proposalMovingBlock('race-lock-first');
    const revision = await planVersion(plan.id);
    const [locked, approved] = await inOrder(
      plan.id,
      () => lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` }),
      () => approveProposal(ctx, session, proposal),
    );
    expect(locked.statusCode).toBe(200);
    expect(locked.json()).toMatchObject({ id: block.id, locked: true, version: block.version + 1 });
    // The approval re-read the block after the lock committed: moving it is a violation.
    expect(approved.statusCode).toBe(422);
    expect(approved.json()).toMatchObject({ code: 'constraint_violation' });
    expect(await blockRow(block.id)).toMatchObject({
      status: 'planned',
      locked: true,
      version: block.version + 1,
      start_at: new Date(block.startAt),
      end_at: new Date(block.endAt),
    });
    expect(await liveBlocks(ownerId, task.id)).toHaveLength(1);
    expect(await planVersion(plan.id)).toBe(revision + 1);
  });

  test('FU-86 race, approval first: the approval moves the block, the queued :lock is 412 and locks nothing', async () => {
    const { ownerId, session, task, plan, block, proposal } = await proposalMovingBlock('race-approve-first');
    const [approved, locked] = await inOrder(
      plan.id,
      () => approveProposal(ctx, session, proposal),
      () => lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` }),
    );
    expect(approved.statusCode).toBe(201);
    // The approval superseded the row (version +1) before the lock read it.
    expect(locked.statusCode).toBe(412);
    expect(locked.json()).toMatchObject({ code: 'version_conflict' });
    expect(await blockRow(block.id)).toMatchObject({ status: 'superseded', locked: false });
    const live = await liveBlocks(ownerId, task.id);
    expect(live.length).toBeGreaterThan(0);
    expect(live.every((row) => !row.locked && row.start_at.getTime() !== Date.parse(block.startAt))).toBe(true);
    expect(await auditActions(block.id)).toEqual([]);
  });

  test('FU-86: two locks of different blocks of one plan at once both land (200, 200; plan.version +2)', async () => {
    const owner = await newOwner('two-blocks');
    const first = await seedPlanTask(ctx, owner.ownerId, { title: 'FU-86 first' });
    const second = await seedPlanTask(ctx, owner.ownerId, { title: 'FU-86 second' });
    const { plan, version } = await approvedPlan(ctx, owner.session, [first.id, second.id]);
    const a = version.blocks.find((block) => block.taskId === first.id);
    const b = version.blocks.find((block) => block.taskId === second.id);
    if (a === undefined || b === undefined) throw new Error('blocks missing');
    const revision = await planVersion(plan.id);
    const updatedAt = (
      await ctx.db.selectFrom('plan').select(['updated_at']).where('id', '=', plan.id as Id).executeTakeFirstOrThrow()
    ).updated_at;

    const [left, right] = await inOrder(
      plan.id,
      () => lockRequest(owner.session, a.id, 'lock', { ifMatch: `W/"${a.version}"` }),
      () => lockRequest(owner.session, b.id, 'lock', { ifMatch: `W/"${b.version}"` }),
    );
    expect(left.statusCode).toBe(200);
    expect(right.statusCode).toBe(200);
    expect(await blockRow(a.id)).toMatchObject({ locked: true, version: a.version + 1 });
    expect(await blockRow(b.id)).toMatchObject({ locked: true, version: b.version + 1 });
    // Serialised on the plan row: no lost revision bump, updated_at untouched.
    expect(await planVersion(plan.id)).toBe(revision + 2);
    const after = await ctx.db.selectFrom('plan').select(['updated_at']).where('id', '=', plan.id as Id).executeTakeFirstOrThrow();
    expect(after.updated_at).toEqual(updatedAt);
    expect(await auditActions(a.id)).toEqual(['schedule_block.locked']);
    expect(await auditActions(b.id)).toEqual(['schedule_block.locked']);
  });

  test('FU-86: the same block locked twice at once (two keys) is 200 then 412, one change and one audit row', async () => {
    const { session, plan, block } = await onePlan('same-block');
    const revision = await planVersion(plan.id);
    const [winner, loser] = await inOrder(
      plan.id,
      () => lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` }),
      () => lockRequest(session, block.id, 'lock', { ifMatch: `W/"${block.version}"` }),
    );
    expect(winner.statusCode).toBe(200);
    expect(winner.json()).toMatchObject({ locked: true, version: block.version + 1 });
    expect(loser.statusCode).toBe(412);
    expect(loser.json()).toMatchObject({ code: 'version_conflict' });
    expect(await blockRow(block.id)).toMatchObject({ locked: true, version: block.version + 1 });
    expect(await planVersion(plan.id)).toBe(revision + 1);
    expect(await auditActions(block.id)).toEqual(['schedule_block.locked']);
  });
});
