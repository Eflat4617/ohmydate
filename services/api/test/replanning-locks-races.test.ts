import type {
  Plan,
  PlanVersionDto,
  ReplanProposal,
  TodayProposal,
} from '@ohmydate/contracts';
import { epochMsToInstant, type Id, type Instant } from '@ohmydate/domain';
import { sql } from 'kysely';
import { PgPlanningStore } from '../src/adapters/pg-planning-store.js';
import { PgReplanStore } from '../src/adapters/pg-replan-store.js';
import {
  ReplanService,
  policyWindow,
  type ReplanStore,
} from '../src/application/replan-service.js';
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
  listProposals,
  minutesOf,
  putM5Availability,
  rejectProposal,
  replanServiceFor,
  requestReplan,
  seedPlanTask,
} from './support/m5-fixtures.js';

/**
 * M5-02R-1 regressions: H1 locked blocks are immutable through replan,
 * regenerate, Today and approval; H2 reject vs request suppression race;
 * M1 replan_suppressed is a stored idempotent result; in-flight approval vs
 * commitment races.
 */

const START = '2026-11-11T08:00:00Z' as Instant;

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!hasDatabase)('M5-02R-1 locked blocks, suppression race, idempotent suppression', () => {
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
    const email = `m5r-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function lockBlock(
    blockId: string,
    times?: { readonly startAt: string; readonly endAt: string },
  ): Promise<void> {
    await ctx.db
      .updateTable('schedule_block')
      .set({
        locked: true,
        ...(times === undefined
          ? {}
          : { start_at: new Date(times.startAt), end_at: new Date(times.endAt) }),
      })
      .where('id', '=', blockId as Id)
      .execute();
  }

  async function blockRow(blockId: string) {
    return ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'status', 'locked', 'start_at', 'end_at'])
      .where('id', '=', blockId as Id)
      .executeTakeFirstOrThrow();
  }

  async function liveBlocks(ownerId: Id, taskId: Id) {
    return ctx.db
      .selectFrom('schedule_block')
      .select(['id', 'locked', 'start_at', 'end_at'])
      .where('owner_id', '=', ownerId)
      .where('task_id', '=', taskId)
      .where('status', '<>', 'superseded')
      .execute();
  }

  async function plan(session: TestSession, id: string): Promise<Plan> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/plans/${id}`,
      headers: authHeaders(session),
    });
    return response.json() as Plan;
  }

  // ---------------------------------------------------------------- H1 ----

  test('H1 reviewer repro: a locked 15:00-16:00 block under a new commitment is kept; the candidate is explained infeasible', async () => {
    const { ownerId, session } = await newOwner('lock-repro');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Locked' });
    const { plan: created, version } = await approvedPlan(ctx, session, [task.id]);
    const original = version.blocks[0];
    if (original === undefined) throw new Error('block missing');
    await lockBlock(original.id, {
      startAt: '2026-11-11T15:00:00Z',
      endAt: '2026-11-11T16:00:00Z',
    });
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: 'Overlaps the lock',
        startAt: '2026-11-11T15:30:00Z',
        endAt: '2026-11-11T16:30:00Z',
        timeZone: 'UTC',
      },
    });
    expect(commitment.statusCode).toBe(201);

    const requested = await requestReplan(ctx, session, { planId: created.id });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    // The locked block is immutable: nothing re-places the task elsewhere.
    expect(proposal.candidate.blocks.filter((block) => block.taskId === task.id)).toEqual([]);
    expect(proposal.candidate.flags).toContain('infeasible');
    expect(proposal.candidate.explanation.join(' ')).toMatch(/H1/);

    const approved = await approveProposal(ctx, session, proposal);
    expect(approved.statusCode).toBe(422);
    expect(approved.json()).toMatchObject({ code: 'constraint_violation' });
    expect(await blockRow(original.id)).toMatchObject({
      status: 'planned',
      locked: true,
      start_at: new Date('2026-11-11T15:00:00Z'),
    });
  });

  test('H1 replan approval keeps the persisted locked=true block (same row, same times)', async () => {
    const { ownerId, session } = await newOwner('lock-approve');
    const locked = await seedPlanTask(ctx, ownerId, { title: 'Locked' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Free' });
    const { plan: created, version } = await approvedPlan(ctx, session, [locked.id, free.id]);
    const lockedBlock = version.blocks.find((block) => block.taskId === locked.id);
    if (lockedBlock === undefined) throw new Error('block missing');
    await lockBlock(lockedBlock.id);

    const proposal = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;
    expect(proposal.candidate.blocks.filter((block) => block.taskId === locked.id)).toEqual([]);
    expect(minutesOf(proposal.candidate.blocks, free.id)).toBe(60);
    const approved = await approveProposal(ctx, session, proposal);
    expect(approved.statusCode).toBe(201);

    expect(await blockRow(lockedBlock.id)).toMatchObject({ status: 'planned', locked: true });
    expect(await liveBlocks(ownerId, locked.id)).toEqual([
      expect.objectContaining({ id: lockedBlock.id, locked: true }),
    ]);
    const calendar = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/schedule-blocks?from=2026-11-11T00:00:00Z&to=2026-11-14T00:00:00Z',
      headers: authHeaders(session),
    });
    expect((calendar.json() as { items: { id: string; locked: boolean }[] }).items).toContainEqual(
      expect.objectContaining({ id: lockedBlock.id, locked: true }),
    );
  });

  test('H1 edited candidates that move a locked block are 422 constraint_violation; an unchanged copy is accepted', async () => {
    const { ownerId, session } = await newOwner('lock-edit');
    const locked = await seedPlanTask(ctx, ownerId, { title: 'Locked' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Free' });
    const { plan: created, version } = await approvedPlan(ctx, session, [locked.id, free.id]);
    const lockedBlock = version.blocks.find((block) => block.taskId === locked.id);
    if (lockedBlock === undefined) throw new Error('block missing');
    await lockBlock(lockedBlock.id);
    const proposal = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;

    const moved = await approveProposal(ctx, session, proposal, {
      body: {
        editedBlocks: [
          ...proposal.candidate.blocks.filter((block) => block.taskId !== locked.id),
          { taskId: locked.id, startAt: '2026-11-12T13:00:00Z', endAt: '2026-11-12T14:00:00Z' },
        ],
      },
    });
    expect(moved.statusCode).toBe(422);
    expect(moved.json()).toMatchObject({ code: 'constraint_violation' });
    expect(await blockRow(lockedBlock.id)).toMatchObject({ status: 'planned', locked: true });

    // Echoing the locked block unchanged is not a move.
    const echoed = await approveProposal(ctx, session, proposal, {
      body: {
        editedBlocks: [
          ...proposal.candidate.blocks,
          { taskId: locked.id, startAt: lockedBlock.startAt, endAt: lockedBlock.endAt },
        ],
      },
    });
    expect(echoed.statusCode).toBe(201);
    expect(await liveBlocks(ownerId, locked.id)).toEqual([
      expect.objectContaining({ id: lockedBlock.id, locked: true }),
    ]);
  });

  test('H1 plan regenerate keeps locks and its approval preserves locked=true', async () => {
    const { ownerId, session } = await newOwner('lock-regen');
    const locked = await seedPlanTask(ctx, ownerId, { title: 'Locked' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Free' });
    const { plan: created, version } = await approvedPlan(ctx, session, [locked.id, free.id]);
    const lockedBlock = version.blocks.find((block) => block.taskId === locked.id);
    if (lockedBlock === undefined) throw new Error('block missing');
    await lockBlock(lockedBlock.id);

    const current = await plan(session, created.id);
    const regenerated = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${created.id}:regenerate`,
      headers: authHeaders(session, {
        'if-match': `W/"${current.version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(regenerated.statusCode).toBe(201);
    const next = regenerated.json() as Plan;
    for (const candidate of next.candidates) {
      expect(candidate.blocks.filter((block) => block.taskId === locked.id)).toEqual([]);
    }
    const candidate = next.candidates[0];
    if (candidate === undefined) throw new Error('candidate missing');
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${created.id}/candidates/${candidate.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${next.availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: {},
    });
    expect(approved.statusCode).toBe(201);
    expect(await liveBlocks(ownerId, locked.id)).toEqual([
      expect.objectContaining({ id: lockedBlock.id, locked: true }),
    ]);
  });

  test('H1 Today: shrinking a locked block is rejected; approving another shrink keeps the lock', async () => {
    const { ownerId, session } = await newOwner('lock-today');
    const locked = await seedPlanTask(ctx, ownerId, { title: 'Locked' });
    const free = await seedPlanTask(ctx, ownerId, { title: 'Free' });
    const { plan: created, version } = await approvedPlan(ctx, session, [locked.id, free.id]);
    const lockedBlock = version.blocks.find((block) => block.taskId === locked.id);
    const freeBlock = version.blocks.find((block) => block.taskId === free.id);
    if (lockedBlock === undefined || freeBlock === undefined) throw new Error('blocks missing');
    await lockBlock(lockedBlock.id);
    const revision = (await plan(session, created.id)).version;

    const shrinkLocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(session, { 'if-match': `W/"${revision}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11', blockId: lockedBlock.id, targetMin: 30 },
    });
    expect(shrinkLocked.statusCode).toBe(422);
    expect(shrinkLocked.json()).toMatchObject({ code: 'validation_failed' });

    const shrink = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(session, { 'if-match': `W/"${revision}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11', blockId: freeBlock.id, targetMin: 30 },
    });
    expect(shrink.statusCode).toBe(201);
    const proposal = shrink.json() as TodayProposal;
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/today/proposals/${proposal.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${proposal.availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(approved.statusCode).toBe(201);
    expect(await liveBlocks(ownerId, locked.id)).toEqual([
      expect.objectContaining({ id: lockedBlock.id, locked: true }),
    ]);
  });

  // ---------------------------------------------------------------- H2 ----

  test('H2 reviewer interleaving: a request queued behind a rejection sees the suppression', async () => {
    const { ownerId, session } = await newOwner('race-reject');
    const task = await seedPlanTask(ctx, ownerId);
    const { plan: created } = await approvedPlan(ctx, session, [task.id]);
    const proposal = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;
    const store = new PgReplanStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids });
    const now = ctx.clock.now();

    // T0 holds the proposal row lock, as a concurrent writer would.
    let releaseRow!: () => void;
    const rowHeld = new Promise<void>((resolve) => {
      releaseRow = resolve;
    });
    let xidReady!: (xid: string) => void;
    const xidPromise = new Promise<string>((resolve) => {
      xidReady = resolve;
    });
    const holder = ctx.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('replan_proposal')
        .select('id')
        .where('id', '=', proposal.id as Id)
        .forUpdate()
        .execute();
      const row = await sql<{ xid: string }>`select pg_current_xact_id()::text as xid`.execute(trx);
      xidReady(row.rows[0]?.xid ?? '');
      await rowHeld;
    });
    const xid = await xidPromise;
    try {
    const reject = store.reject(ownerId, proposal.id as Id, 1, {
      now,
      suppressUntil: epochMsToInstant(Date.parse(now) + 24 * 60 * 60 * 1000),
    });
    await waitFor(async () => {
      const result = await sql<{ n: number }>`
        select count(*)::int as n from pg_locks
        where locktype = 'transactionid' and not granted and transactionid::text = ${xid}`.execute(ctx.db);
      return (result.rows[0]?.n ?? 0) > 0;
    }, 'reject to wait on the proposal row');

    const insert = store.insert(
      {
        id: ctx.ids.next(),
        ownerId,
        planId: created.id as Id,
        basePlanVersionId: proposal.basePlanVersionId as Id,
        basePlanRevision: 2,
        availabilityVersion: proposal.availabilityVersion,
        trigger: { ...proposal.trigger, detectedAt: now },
        candidate: proposal.candidate,
        policy: 'front_loaded',
        now,
        expiresAt: epochMsToInstant(Date.parse(now) + 24 * 60 * 60 * 1000),
      },
      policyWindow(now, 'UTC'),
      'requested',
    );
    let insertSettled = false;
    void insert.finally(() => {
      insertSettled = true;
    });
    // The request has made its move once it is queued on the owner policy
    // lock (fixed ordering), on the proposal row behind T0 (a policy read that
    // already ran), or has finished outright.
    await waitFor(async () => {
      if (insertSettled) return true;
      const advisory = await sql<{ n: number }>`
        select count(*)::int as n from pg_locks l,
          (select hashtextextended(${`ohmydate.replan:${ownerId}`}, 0) as k) key
        where l.locktype = 'advisory' and not l.granted and l.objsubid = 1
          and l.classid = ((key.k >> 32) & 4294967295)::oid
          and l.objid = (key.k & 4294967295)::oid`.execute(ctx.db);
      const rowWaiters = await sql<{ n: number }>`
        select count(*)::int as n from pg_locks
        where locktype = 'transactionid' and not granted and transactionid::text = ${xid}`.execute(ctx.db);
      return (advisory.rows[0]?.n ?? 0) > 0 || (rowWaiters.rows[0]?.n ?? 0) > 1;
    }, 'request to queue behind the rejection');

    releaseRow();
    await holder;
    expect((await reject).state).toBe('rejected');
    expect(await insert).toMatchObject({ kind: 'blocked', block: { kind: 'suppressed' } });
    expect(await listProposals(ctx, session, 'pending')).toEqual([]);
    } finally {
      releaseRow();
      await holder.catch(() => undefined);
    }
  });

  test('H2 three concurrent distinct requests against the 2/day cap: exactly two are created', async () => {
    const { ownerId, session } = await newOwner('race-cap');
    const task = await seedPlanTask(ctx, ownerId);
    const { plan: created } = await approvedPlan(ctx, session, [task.id]);
    const responses = await Promise.all(
      (['user_request', 'dependency_change', 'deadline_slack_negative'] as const).map((reason) =>
        requestReplan(ctx, session, { planId: created.id, reason }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 201, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: 'replan_suppressed',
    });
    const rows = await ctx.db
      .selectFrom('replan_proposal')
      .select('id')
      .where('owner_id', '=', ownerId)
      .execute();
    expect(rows).toHaveLength(2);
  });

  // ---------------------------------------------------------------- M1 ----

  test('M1 replan_suppressed is stored: same key replays 409 + Retry-After after expiry; changed body is 422', async () => {
    const { ownerId, session } = await newOwner('idem');
    const task = await seedPlanTask(ctx, ownerId);
    const { plan: created } = await approvedPlan(ctx, session, [task.id]);
    const first = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;
    expect((await rejectProposal(ctx, session, first)).statusCode).toBe(200);

    ctx.clock.set('2026-11-11T09:00:00Z' as Instant);
    const key = newIdempotencyKey();
    const send = (body: Record<string, unknown>) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/v1/replan-proposals:request',
        headers: authHeaders(session, { 'idempotency-key': key }),
        payload: body,
      });
    const suppressed = await send({ planId: created.id });
    expect(suppressed.statusCode).toBe(409);
    expect(suppressed.json()).toMatchObject({ code: 'replan_suppressed' });
    expect(Number(suppressed.headers['retry-after'])).toBe(23 * 60 * 60);

    const mismatch = await send({ planId: created.id, reason: 'dependency_change' });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json()).toMatchObject({ code: 'idempotency_mismatch' });

    // Suppression is over, but the key's stored result is replayed verbatim.
    ctx.clock.set('2026-11-12T08:01:00Z' as Instant);
    const replay = await send({ planId: created.id });
    expect(replay.statusCode).toBe(409);
    expect(replay.json()).toMatchObject({ code: 'replan_suppressed' });
    expect(replay.headers['retry-after']).toBe(suppressed.headers['retry-after']);
    expect(await listProposals(ctx, session, 'pending')).toEqual([]);
    // A fresh key is evaluated against the current policy again.
    expect((await requestReplan(ctx, session, { planId: created.id })).statusCode).toBe(201);
  });

  // ------------------------------------------------------- in-flight races ----

  test('approval in flight vs a new commitment: the commitment waits, lands afterwards and is detected', async () => {
    const { ownerId, session } = await newOwner('inflight-a');
    const a = await seedPlanTask(ctx, ownerId, { title: 'A' });
    const b = await seedPlanTask(ctx, ownerId, { title: 'B' });
    const { plan: created } = await approvedPlan(ctx, session, [a.id, b.id]);
    const proposal = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;
    const target = proposal.candidate.blocks[0];
    if (target === undefined) throw new Error('candidate block missing');

    const base = new PgReplanStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const gated: ReplanStore = {
      listOwnersWithActivePlan: () => base.listOwnersWithActivePlan(),
      expireStale: (now, owner) => base.expireStale(now, owner),
      checkPolicy: (...args) => base.checkPolicy(...args),
      insert: (...args) => base.insert(...args),
      list: (...args) => base.list(...args),
      get: (...args) => base.get(...args),
      reject: (...args) => base.reject(...args),
      approve: (request) =>
        base.approve({
          ...request,
          prepare: async (snapshot) => {
            entered();
            await gate;
            return request.prepare(snapshot);
          },
        }),
    };
    const service = new ReplanService({
      tasks: ctx.repos.tasks,
      planning: new PgPlanningStore({ db: ctx.db, clock: ctx.clock, ids: ctx.ids }),
      store: gated,
      clock: ctx.clock,
      ids: ctx.ids,
    });
    const approval = service.approve(
      ownerId,
      proposal.id as Id,
      proposal.availabilityVersion,
      newIdempotencyKey(),
      undefined,
    );
    await inside;
    const commitment = ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Late call', startAt: target.startAt, endAt: target.endAt, timeZone: 'UTC' },
    });
    // The approval holds the availability row lock: the commitment cannot land.
    expect(await settledWithin(commitment, 300)).toBe(false);
    open();
    const version: PlanVersionDto = await approval;
    expect(version.createdBy).toBe('replan');
    expect((await commitment).statusCode).toBe(201);

    // The new commitment overlaps the freshly approved block -> detected.
    expect(await replanServiceFor(ctx).detectForOwner(ownerId, ctx.clock.now())).toBe(1);
    const pending = await listProposals(ctx, session, 'pending');
    expect(pending.map((entry) => entry.trigger.kind)).toEqual(['commitment_conflict']);
  });

  test('a commitment write in flight before approval locks availability makes the approval 412', async () => {
    const { ownerId, session } = await newOwner('inflight-b');
    const a = await seedPlanTask(ctx, ownerId, { title: 'A' });
    const { plan: created } = await approvedPlan(ctx, session, [a.id]);
    const proposal = (await requestReplan(ctx, session, { planId: created.id })).json() as ReplanProposal;

    let commit!: () => void;
    const held = new Promise<void>((resolve) => {
      commit = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // Same writes as POST /commitments: insert + availability_version bump.
    const writer = ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('commitment_event')
        .values({
          id: ctx.ids.next(),
          owner_id: ownerId,
          title: 'In-flight commitment',
          start_at: new Date('2026-11-11T09:00:00Z'),
          end_at: new Date('2026-11-11T10:00:00Z'),
          time_zone: 'UTC',
          source: 'manual',
        })
        .execute();
      await trx
        .updateTable('user_availability_version')
        .set({ version: sql<number>`version + 1` })
        .where('owner_id', '=', ownerId)
        .execute();
      locked();
      await held;
    });
    await lockTaken;
    const approval = approveProposal(ctx, session, proposal);
    expect(await settledWithin(approval, 300)).toBe(false);
    commit();
    await writer;
    const response = await approval;
    expect(response.statusCode).toBe(412);
    expect(response.json()).toMatchObject({ code: 'availability_changed' });
  });
});
