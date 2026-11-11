import type { Plan, PlanVersionDto, ReplanProposal } from '@ohmydate/contracts';
import type { Id, Instant, Task } from '@ohmydate/domain';
import { generate } from '@ohmydate/scheduler';
import { sql } from 'kysely';
import { assembleScheduleInput } from '../src/application/plan-service.js';
import { beforeMetrics, buildBeforeSnapshot } from '../src/application/replan-before.js';
import type { ApprovedBlock } from '../src/application/planning-ports.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { putM5Availability, replanServiceFor, seedPlanTask } from './support/m5-fixtures.js';

/**
 * M5-03R-1 H1 / FU-70: a replan proposal carries its plan id, the base plan
 * revision and an authoritative `before` snapshot (every block the candidate
 * replaces or keeps, locked flag included, plus before metrics computed with
 * the candidate's metric rules), so clients never infer a diff from a
 * truncated calendar query.
 */

type BeforeSnapshot = NonNullable<ReplanProposal['before']>;

const START = '2026-11-11T08:00:00Z' as Instant;
const LONG_HORIZON = { start: '2026-11-11T00:00:00Z', end: '2027-01-31T00:00:00Z' };

describe.skipIf(!hasDatabase)('replan proposal before snapshot (M5-03R-1 H1)', () => {
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

  async function owner(label: string): Promise<{ ownerId: Id; session: TestSession }> {
    counter += 1;
    const email = `before-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    await putM5Availability(ctx, session);
    return { ownerId, session };
  }

  async function longPlan(
    session: TestSession,
    edited: readonly { taskId: string; startAt: string; endAt: string }[],
  ): Promise<{ plan: Plan; version: PlanVersionDto }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        scope: { taskIds: [...new Set(edited.map((block) => block.taskId))] },
        policies: ['front_loaded'],
        horizon: LONG_HORIZON,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const plan = created.json() as Plan;
    const candidate = plan.candidates[0];
    if (candidate === undefined) throw new Error('no candidate');
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${candidate.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${plan.availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { editedBlocks: edited },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    return { plan, version: approved.json() as PlanVersionDto };
  }

  async function planRevision(session: TestSession, planId: string): Promise<number> {
    const response = await ctx.app.inject({ method: 'GET', url: `/api/v1/plans/${planId}`, headers: authHeaders(session) });
    return (response.json() as Plan).version;
  }

  async function lock(blockId: string): Promise<void> {
    await ctx.db.updateTable('schedule_block').set({ locked: true }).where('id', '=', blockId as Id).execute();
  }

  async function request(session: TestSession, body: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/replan-proposals:request',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: body,
    });
  }

  function minutes(from: string, to: string): number {
    return Math.floor((Date.parse(to) - Date.parse(from)) / 60_000);
  }

  test('a requested proposal carries planId, basePlanVersion and every replaced/kept block far beyond +14 days', async () => {
    const { ownerId, session } = await owner('long');
    const a = await seedPlanTask(ctx, ownerId, { title: 'Far work', dueAt: '2027-01-20T18:00:00Z' });
    const b = await seedPlanTask(ctx, ownerId, { title: 'Near work', dueAt: '2026-11-20T18:00:00Z' });
    const l = await seedPlanTask(ctx, ownerId, { title: 'Locked work' });
    const { plan, version } = await longPlan(session, [
      { taskId: b.id, startAt: '2026-11-12T10:00:00Z', endAt: '2026-11-12T11:00:00Z' },
      { taskId: a.id, startAt: '2026-12-15T10:00:00Z', endAt: '2026-12-15T11:00:00Z' },
      { taskId: l.id, startAt: '2026-12-20T10:00:00Z', endAt: '2026-12-20T11:00:00Z' },
    ]);
    const lockedBlock = version.blocks.find((block) => block.taskId === l.id);
    if (lockedBlock === undefined) throw new Error('locked block missing');
    await lock(lockedBlock.id);
    const revision = await planRevision(session, plan.id);

    const created = await request(session, { planId: plan.id, affectedTaskIds: [b.id] });
    expect(created.statusCode, created.body).toBe(201);
    const proposal = created.json() as ReplanProposal;
    expect(proposal.planId).toBe(plan.id);
    expect(proposal.basePlanVersion).toBe(revision);
    const before = proposal.before as BeforeSnapshot;
    expect(before).toBeDefined();
    expect(before.capturedAt).toBe(proposal.trigger.detectedAt);
    const byTask = new Map(before.blocks.map((block) => [block.taskId, block]));
    expect(byTask.get(a.id)).toMatchObject({ startAt: '2026-12-15T10:00:00.000Z', endAt: '2026-12-15T11:00:00.000Z', locked: false });
    expect(byTask.get(b.id)).toMatchObject({ startAt: '2026-11-12T10:00:00.000Z', locked: false });
    expect(byTask.get(l.id)).toMatchObject({ id: lockedBlock.id, startAt: '2026-12-20T10:00:00.000Z', locked: true });
    expect(before.blocks).toHaveLength(3);
    // Locked blocks are kept, never part of the candidate.
    expect(proposal.candidate.blocks.some((block) => block.taskId === l.id)).toBe(false);

    // Before metrics follow the candidate's rules (06 §6): focus over every
    // occupied interval, slack = due − last end per deadline task.
    expect(before.metrics.totalFocusMin).toBe(180);
    const slackA = minutes('2026-12-15T11:00:00Z', '2027-01-20T18:00:00Z');
    const slackB = minutes('2026-11-12T11:00:00Z', '2026-11-20T18:00:00Z');
    expect(before.metrics.taskSlack).toEqual(
      expect.arrayContaining([
        { taskId: a.id, dueAt: '2027-01-20T18:00:00.000Z', slackMin: slackA },
        { taskId: b.id, dueAt: '2026-11-20T18:00:00.000Z', slackMin: slackB },
      ]),
    );
    expect(before.metrics.taskSlack).toHaveLength(2);
    expect(before.metrics.minSlackMin).toBe(Math.min(slackA, slackB));

    // GET and list serialize the same snapshot.
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/replan-proposals/${proposal.id}`,
      headers: authHeaders(session),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ planId: plan.id, basePlanVersion: revision, before });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/replan-proposals', headers: authHeaders(session) });
    expect((list.json() as { items: ReplanProposal[] }).items).toEqual([
      expect.objectContaining({ id: proposal.id, planId: plan.id, basePlanVersion: revision, before }),
    ]);
  });

  test('a detected proposal (commitment overlap) is persisted with its snapshot', async () => {
    const { ownerId, session } = await owner('detect');
    const a = await seedPlanTask(ctx, ownerId, { title: 'Overlapped', dueAt: '2027-01-20T18:00:00Z' });
    const c = await seedPlanTask(ctx, ownerId, { title: 'Far removed', dueAt: '2027-01-25T18:00:00Z' });
    const { plan } = await longPlan(session, [
      { taskId: a.id, startAt: '2026-11-12T10:00:00Z', endAt: '2026-11-12T11:00:00Z' },
      { taskId: c.id, startAt: '2027-01-10T10:00:00Z', endAt: '2027-01-10T11:00:00Z' },
    ]);
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Clash', startAt: '2026-11-12T10:30:00Z', endAt: '2026-11-12T11:30:00Z', timeZone: 'UTC' },
    });
    expect(commitment.statusCode, commitment.body).toBe(201);
    expect(await replanServiceFor(ctx).detectForOwner(ownerId, START)).toBe(1);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/replan-proposals', headers: authHeaders(session) });
    const [proposal] = (list.json() as { items: ReplanProposal[] }).items;
    expect(proposal?.trigger.reason).toBe('commitment_overlap');
    expect(proposal?.planId).toBe(plan.id);
    const before = proposal?.before as BeforeSnapshot;
    expect(before.blocks.map((block) => block.taskId).sort()).toEqual([a.id, c.id].sort());
    expect(before.blocks.find((block) => block.taskId === c.id)?.startAt).toBe('2027-01-10T10:00:00.000Z');
  });

  test('another owner can neither read nor list the proposal or its snapshot (negative)', async () => {
    const alice = await owner('alice');
    const task = await seedPlanTask(ctx, alice.ownerId, { title: 'Private' });
    const { plan } = await longPlan(alice.session, [
      { taskId: task.id, startAt: '2026-11-12T10:00:00Z', endAt: '2026-11-12T11:00:00Z' },
    ]);
    const created = await request(alice.session, { planId: plan.id });
    expect(created.statusCode, created.body).toBe(201);
    const proposal = created.json() as ReplanProposal;

    const mallory = await owner('mallory');
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/replan-proposals/${proposal.id}`,
      headers: authHeaders(mallory.session),
    });
    expect(read.statusCode).toBe(404);
    expect(read.body).not.toContain(task.id);
    expect(read.body).not.toContain(plan.id);
    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/replan-proposals', headers: authHeaders(mallory.session) });
    expect((list.json() as { items: unknown[] }).items).toEqual([]);
    const foreign = await request(mallory.session, { planId: plan.id });
    expect(foreign.statusCode).toBe(404);
  });

  test('FU-72: malformed persisted snapshots are dropped from GET and list (negative)', async () => {
    const { ownerId, session } = await owner('malformed');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Malformed' });
    const { plan } = await longPlan(session, [
      { taskId: task.id, startAt: '2026-11-12T10:00:00Z', endAt: '2026-11-12T11:00:00Z' },
    ]);
    const created = await request(session, { planId: plan.id });
    expect(created.statusCode, created.body).toBe(201);
    const proposal = created.json() as ReplanProposal;
    expect(proposal.before).toBeDefined();

    const stored = await ctx.db
      .selectFrom('replan_proposal')
      .select('payload')
      .where('id', '=', proposal.id as Id)
      .executeTakeFirstOrThrow();
    const original = stored.payload as { before: Record<string, unknown> } & Record<string, unknown>;

    const variants: Array<[string, (before: Record<string, unknown>) => void]> = [
      ['bad instant', (before) => { before['capturedAt'] = 'not-an-instant'; }],
      [
        'negative focus',
        (before) => {
          (before['metrics'] as Record<string, unknown>)['totalFocusMin'] = -1;
        },
      ],
      [
        'wrong id format',
        (before) => {
          ((before['blocks'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['id'] =
            'not-a-uuid';
        },
      ],
      [
        'version bounds',
        (before) => {
          ((before['blocks'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['version'] = 0;
        },
      ],
      [
        'unknown status',
        (before) => {
          ((before['blocks'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['status'] =
            'weird';
        },
      ],
    ];

    try {
      for (const [label, mutate] of variants) {
        const payload = structuredClone(original);
        mutate(payload.before);
        await ctx.db
          .updateTable('replan_proposal')
          .set({ payload: sql`${JSON.stringify(payload)}::jsonb` as never })
          .where('id', '=', proposal.id as Id)
          .execute();

        const read = await ctx.app.inject({
          method: 'GET',
          url: `/api/v1/replan-proposals/${proposal.id}`,
          headers: authHeaders(session),
        });
        expect(read.statusCode, label).toBe(200);
        expect('before' in (read.json() as ReplanProposal), label).toBe(false);

        const list = await ctx.app.inject({
          method: 'GET',
          url: '/api/v1/replan-proposals',
          headers: authHeaders(session),
        });
        const item = (list.json() as { items: ReplanProposal[] }).items.find(
          (entry) => entry.id === proposal.id,
        );
        expect(item, label).toBeDefined();
        expect(item !== undefined && 'before' in item, label).toBe(false);
      }
    } finally {
      await ctx.db
        .updateTable('replan_proposal')
        .set({ payload: sql`${JSON.stringify(original)}::jsonb` as never })
        .where('id', '=', proposal.id as Id)
        .execute();
    }
  });

  test('a legacy row without a snapshot serializes planId and basePlanVersion but no before (negative)', async () => {
    const { ownerId, session } = await owner('legacy');
    const task = await seedPlanTask(ctx, ownerId, { title: 'Legacy' });
    const { plan } = await longPlan(session, [
      { taskId: task.id, startAt: '2026-11-12T10:00:00Z', endAt: '2026-11-12T11:00:00Z' },
    ]);
    const created = await request(session, { planId: plan.id });
    const proposal = created.json() as ReplanProposal;
    await ctx.db
      .updateTable('replan_proposal')
      .set({ payload: sql`payload - 'before'` as never })
      .where('id', '=', proposal.id as Id)
      .execute();
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/replan-proposals/${proposal.id}`,
      headers: authHeaders(session),
    });
    const body = read.json() as ReplanProposal;
    expect(body.planId).toBe(plan.id);
    expect(typeof body.basePlanVersion).toBe('number');
    expect('before' in body).toBe(false);
  });
});

describe('before metrics use the candidate metric rules (parity with the scheduler)', () => {
  const NOW = '2026-11-11T08:00:00Z';
  const availability = {
    version: 1,
    timeZone: 'UTC',
    rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '18:00', kind: 'work' as const })),
    exceptions: [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      dayStartLocal: '08:00',
      dayEndLocal: '18:00',
      riskLevel: 'p50' as const,
    },
  };
  function task(id: string, dueAt?: string): Task {
    return {
      id: id as Id,
      ownerId: 'owner' as Id,
      projectId: 'project' as Id,
      title: id,
      status: 'todo',
      splittable: true,
      session: { minMinutes: 30, maxMinutes: 120 },
      priority: 2,
      dependsOn: [],
      version: 1 as never,
      createdAt: NOW as Instant,
      updatedAt: NOW as Instant,
      external: [],
      ...(dueAt === undefined ? {} : { dueAt: dueAt as Instant }),
    };
  }
  function block(id: string, taskId: string, start: string, end: string, locked = false): ApprovedBlock {
    return {
      id: id as Id,
      planId: 'plan' as Id,
      planVersionId: 'v1' as Id,
      taskId: taskId as Id,
      startAt: start as Instant,
      endAt: end as Instant,
      status: 'planned',
      locked,
      version: 1,
    };
  }

  it('reproduces the scheduler candidate totalFocusMin and minSlackMin from the same intervals', () => {
    const tasks = [task('t-a', '2026-11-13T17:00:00Z'), task('t-b', '2026-11-12T17:00:00Z'), task('t-l')];
    const blocks = [
      block('h', 't-a', '2026-11-11T07:00:00Z', '2026-11-11T07:30:00Z'),
      block('a', 't-a', '2026-11-12T09:00:00Z', '2026-11-12T10:00:00Z'),
      block('b', 't-b', '2026-11-12T11:00:00Z', '2026-11-12T12:00:00Z'),
      block('l', 't-l', '2026-11-13T09:00:00Z', '2026-11-13T10:00:00Z', true),
    ];
    const assembled = assembleScheduleInput({
      now: NOW,
      timeZone: 'UTC',
      horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-14T00:00:00Z' },
      availability,
      commitments: [],
      planningTasks: tasks,
      extraTasks: [],
      estimates: new Map([
        ['t-a', { taskId: 't-a' as Id, p50Min: 90, p90Min: 90 }],
        ['t-b', { taskId: 't-b' as Id, p50Min: 60, p90Min: 60 }],
        ['t-l', { taskId: 't-l' as Id, p50Min: 60, p90Min: 60 }],
      ]),
      activeBlocks: blocks,
      currentPlanId: 'plan' as Id,
      seed: 3,
    });
    const input = { ...assembled.input, affectedTaskIds: ['t-b'] };
    for (const candidate of generate(input).candidates) {
      const intervals = [
        ...(input.lockedBlocks ?? []),
        ...assembled.historyBlocks,
        ...candidate.blocks,
      ].map((entry) => ({ taskId: entry.taskId, startAt: entry.start, endAt: entry.end }));
      const metrics = beforeMetrics(input, intervals);
      expect(metrics.totalFocusMin, candidate.policy).toBe(candidate.metrics.totalFocusMin);
      expect(metrics.minSlackMin, candidate.policy).toBe(candidate.metrics.minSlackMin);
    }
    // Negative: a block missing from the interval set changes the metrics.
    const partial = beforeMetrics(input, [{ taskId: 't-b', startAt: '2026-11-12T11:00:00Z', endAt: '2026-11-12T12:00:00Z' }]);
    expect(partial.totalFocusMin).toBe(60);
  });
});

describe('buildBeforeSnapshot keeps exactly what approval replaces or keeps', () => {
  const NOW = '2026-11-14T09:30:00.000Z';
  const base = { planId: 'plan' as Id, planVersionId: 'v1' as Id, version: 1 };
  const row = (id: string, start: string, end: string, extra: Partial<ApprovedBlock> = {}): ApprovedBlock => ({
    ...base,
    id: id as Id,
    taskId: 't-a' as Id,
    startAt: start as Instant,
    endAt: end as Instant,
    status: 'planned',
    locked: false,
    ...extra,
  });

  it('includes future unlocked and locked blocks over the whole horizon and drops history, done and superseded (negative)', () => {
    const snapshot = buildBeforeSnapshot({
      now: NOW,
      planBlocks: [
        row('past', '2026-11-14T08:00:00Z', '2026-11-14T09:00:00Z'),
        row('started', '2026-11-14T09:00:00Z', '2026-11-14T10:00:00Z'),
        row('done', '2026-11-15T08:00:00Z', '2026-11-15T09:00:00Z', { status: 'done' }),
        row('old', '2026-11-15T10:00:00Z', '2026-11-15T11:00:00Z', { status: 'superseded' }),
        row('far', '2027-03-01T10:00:00Z', '2027-03-01T11:00:00Z'),
        row('lock', '2027-02-01T10:00:00Z', '2027-02-01T11:00:00Z', { locked: true }),
        row('next', '2026-11-14T09:30:00Z', '2026-11-14T10:30:00Z', { taskId: 't-b' as Id }),
      ],
      scheduleInput: {
        tasks: [{ id: 't-a', dueAt: '2027-03-02T00:00:00Z', estimate: { p50Min: 60, p90Min: 60 }, splittable: true, minSessionMin: 30, maxSessionMin: 120, priority: 2, dependsOn: [] }],
        horizon: { start: '2026-11-11T00:00:00Z', end: '2027-04-01T00:00:00Z' },
        lockedBlocks: [{ taskId: 'other', start: '2026-11-20T10:00:00Z', end: '2026-11-20T10:30:00Z' }],
      },
      historyBlocks: [{ taskId: 't-a', start: '2026-11-14T08:00:00Z', end: '2026-11-14T09:00:00Z' }],
    });
    expect(snapshot.capturedAt).toBe(NOW);
    expect(snapshot.blocks.map((block) => [block.id, block.locked])).toEqual([
      ['next', false],
      ['lock', true],
      ['far', false],
    ]);
    // other live 30 + history 60 + snapshot 180; the deadline task ends on 2027-03-01 11:00.
    expect(snapshot.metrics.totalFocusMin).toBe(270);
    expect(snapshot.metrics.taskSlack).toEqual([
      { taskId: 't-a', dueAt: '2027-03-02T00:00:00.000Z', slackMin: 13 * 60 },
    ]);
  });
});
