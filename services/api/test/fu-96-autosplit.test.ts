import { randomUUID } from 'node:crypto';
import type {
  Availability,
  Plan,
  PlanVersionDto,
  ReplanProposal,
  Today,
  TodayProposal,
} from '@ohmydate/contracts';
import type { Id, Instant, Task } from '@ohmydate/domain';
import { generate, validate, type ScheduleInput } from '@ohmydate/scheduler';
import {
  candidateExplanationJson,
  parseCandidateExplanation,
} from '../src/adapters/explanation-json.js';
import { assembleScheduleInput } from '../src/application/plan-service.js';
import {
  DEFAULT_MAX_SESSION_MIN,
  DEFAULT_MIN_SESSION_MIN,
  schedulingSessionBounds,
} from '../src/application/session-bounds.js';
import { approveProposal, requestReplan } from './support/m5-fixtures.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

/**
 * FU-96 (GU-1): a non-splittable task longer than one H6-legal session used
 * to make plan generation place 0 blocks (it and every successor stayed
 * unplaced). Every scheduler-input path now auto-splits it with the same
 * bounds, explains it, and leaves the stored task untouched.
 */

const MINUTE_MS = 60_000;

function minutes(block: { startAt?: string; endAt?: string; start?: string; end?: string }): number {
  const start = block.startAt ?? block.start ?? '';
  const end = block.endAt ?? block.end ?? '';
  return (Date.parse(end) - Date.parse(start)) / MINUTE_MS;
}

// --- the shared bounds helper ------------------------------------------------

describe('schedulingSessionBounds (FU-96)', () => {
  const prefs = { breakAfterMin: 60, maxDailyFocusMin: 240 };

  it('keeps splittable bounds: the task session window, else the 30-90 defaults', () => {
    expect(schedulingSessionBounds({ splittable: true }, 500, prefs)).toEqual({
      splittable: true,
      minSessionMin: DEFAULT_MIN_SESSION_MIN,
      maxSessionMin: DEFAULT_MAX_SESSION_MIN,
    });
    expect(
      schedulingSessionBounds({ splittable: true, session: { minMinutes: 45, maxMinutes: 120 } }, 500, prefs),
    ).toEqual({ splittable: true, minSessionMin: 45, maxSessionMin: 120 });
    // A vanished task (today path) is treated as splittable with defaults.
    expect(schedulingSessionBounds(undefined, 500, prefs)).toMatchObject({ splittable: true, minSessionMin: 30 });
  });

  it('leaves a non-splittable task that fits one legal session as one exact block', () => {
    expect(schedulingSessionBounds({ splittable: false }, 45, prefs)).toEqual({
      splittable: false,
      minSessionMin: 45,
      maxSessionMin: 45,
    });
    expect(schedulingSessionBounds({ splittable: false }, 60, prefs)).toEqual({
      splittable: false,
      minSessionMin: 60,
      maxSessionMin: 60,
    });
    expect(schedulingSessionBounds({ splittable: false }, 0, prefs)).toEqual({
      splittable: false,
      minSessionMin: 0,
      maxSessionMin: 0,
    });
  });

  it('auto-splits a longer non-splittable task at the binding H6 limit', () => {
    expect(schedulingSessionBounds({ splittable: false }, 160, prefs)).toEqual({
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 60,
      autoSplit: 'break_after',
    });
    // The daily cap binds: the 90-minute splittable default does not shorten it.
    expect(schedulingSessionBounds({ splittable: false }, 300, { breakAfterMin: 240, maxDailyFocusMin: 150 })).toEqual({
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 150,
      autoSplit: 'daily_cap',
    });
    // A short cap keeps the minimum at half the cap so any length can split.
    expect(schedulingSessionBounds({ splittable: false }, 50, { breakAfterMin: 45, maxDailyFocusMin: 480 })).toEqual({
      splittable: true,
      minSessionMin: 20,
      maxSessionMin: 45,
      autoSplit: 'break_after',
    });
    // The task's own session window does not apply to non-splittable work.
    expect(
      schedulingSessionBounds({ splittable: false, session: { minMinutes: 100, maxMinutes: 200 } }, 160, prefs),
    ).toMatchObject({ minSessionMin: 30, maxSessionMin: 60 });
  });

  it('does not split when no legal session exists at all (negative)', () => {
    expect(schedulingSessionBounds({ splittable: false }, 160, { breakAfterMin: 60, maxDailyFocusMin: 0 })).toEqual({
      splittable: false,
      minSessionMin: 160,
      maxSessionMin: 160,
    });
  });
});

// --- the live GU-1 shape through assembleScheduleInput + generate -----------

const LIVE_P50 = [160, 235, 195, 315, 315, 120, 315, 315, 160, 315, 235, 315];
const LIVE_SPLITTABLE = [false, false, false, true, true, false, true, true, false, true, false, true];
const LIVE_DEPENDS = [[], [0], [1], [2], [3], [4], [5], [6], [5], [7, 8], [9], [10]];

function liveId(index: number): Id {
  return `0193a8f2-6c1e-7b41-9a2e-${String(index).padStart(12, '0')}` as Id;
}

function domainTask(index: number): Task {
  return {
    id: liveId(index),
    ownerId: liveId(99),
    projectId: liveId(98),
    title: `Step ${index}`,
    status: 'todo',
    dueAt: '2026-12-25T03:00:00Z' as Instant,
    splittable: LIVE_SPLITTABLE[index] ?? true,
    priority: 3,
    dependsOn: (LIVE_DEPENDS[index] ?? []).map(liveId),
    version: 1 as Task['version'],
    createdAt: '2026-11-01T00:00:00Z' as Instant,
    updatedAt: '2026-11-01T00:00:00Z' as Instant,
    external: [],
  };
}

const LIVE_AVAILABILITY = {
  version: 3,
  timeZone: 'Asia/Seoul',
  rules: [
    { weekday: 1, startLocal: '10:00', endLocal: '17:00', kind: 'work' },
    { weekday: 2, startLocal: '13:00', endLocal: '17:00', kind: 'work' },
    { weekday: 3, startLocal: '10:00', endLocal: '17:00', kind: 'work' },
    { weekday: 4, startLocal: '13:00', endLocal: '17:00', kind: 'work' },
    { weekday: 5, startLocal: '11:00', endLocal: '17:00', kind: 'work' },
  ],
  exceptions: [
    { date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' },
    { date: '2026-11-15', kind: 'off', startLocal: '10:00', endLocal: '18:00' },
  ],
  prefs: {
    maxDailyFocusMin: 180,
    breakAfterMin: 60,
    breakMin: 15,
    riskLevel: 'p50',
    dayStartLocal: '09:00',
    dayEndLocal: '23:59',
  },
} as unknown as Availability;

function liveAssembly(tasks: readonly Task[], availability: Availability = LIVE_AVAILABILITY) {
  return assembleScheduleInput({
    now: '2026-11-12T11:34:00Z',
    timeZone: availability.timeZone,
    horizon: { start: '2026-11-11T15:00:00Z', end: '2026-12-29T15:00:00Z' },
    availability,
    commitments: [],
    planningTasks: tasks,
    extraTasks: [],
    estimates: new Map(
      tasks.map((task, index) => [
        task.id,
        { taskId: task.id, p50Min: LIVE_P50[index] ?? 60, p90Min: (LIVE_P50[index] ?? 60) + 100 },
      ]),
    ),
    activeBlocks: [],
    seed: 1,
  });
}

describe('GU-1 live shape: assembleScheduleInput + generate (FU-96)', () => {
  const tasks = LIVE_P50.map((_, index) => domainTask(index));

  it('places the chain feasibly; every auto-split task keeps legal, separated sessions', () => {
    const assembled = liveAssembly(tasks);
    const autoSplitIds = assembled.input.tasks.filter((task) => task.autoSplit !== undefined).map((task) => task.id);
    // The non-splittable steps longer than 60 minutes; the stored tasks stay non-splittable.
    expect(autoSplitIds).toEqual([0, 1, 2, 5, 8, 10].map(liveId));
    expect(tasks.filter((task) => !task.splittable)).toHaveLength(6);

    const result = generate(assembled.input);
    const feasible = result.candidates.filter((candidate) => candidate.feasible);
    expect(feasible.length).toBeGreaterThan(0);
    for (const candidate of feasible) {
      expect(candidate.blocks.length).toBeGreaterThan(0);
      expect(candidate.deficitMin).toBe(0);
      // H6 (and every other hard rule) holds for the whole candidate.
      expect(validate(assembled.input, candidate.blocks, { riskLevel: 'p50' })).toEqual([]);
      for (const taskId of autoSplitIds) {
        const sessions = candidate.blocks
          .filter((block) => block.taskId === taskId)
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        expect(sessions.length).toBeGreaterThan(1);
        for (const session of sessions) expect(minutes(session)).toBeLessThanOrEqual(60);
        for (let index = 1; index < sessions.length; index += 1) {
          const gap = (Date.parse(sessions[index]!.start) - Date.parse(sessions[index - 1]!.end)) / MINUTE_MS;
          expect(gap).toBeGreaterThanOrEqual(15);
        }
      }
      const items = candidate.explanationItems.filter((item) => item.code === 'auto_split_long_task');
      expect(items.map((item) => item.params)).toEqual(
        autoSplitIds.map((taskId) => ({ taskId, sessionMaxMin: 60, reason: 'break_after' })),
      );
      expect(candidate.explanation).toHaveLength(candidate.explanationItems.length);
    }
  });

  it('a non-splittable step that fits one session stays one exact block', () => {
    const fitting = [{ ...domainTask(0), dependsOn: [] }];
    const assembled = assembleScheduleInput({
      ...liveInputSource(fitting),
      estimates: new Map([[fitting[0]!.id, { taskId: fitting[0]!.id, p50Min: 45, p90Min: 90 }]]),
    });
    expect(assembled.input.tasks[0]).toMatchObject({ splittable: false, minSessionMin: 45, maxSessionMin: 45 });
    expect(assembled.input.tasks[0]?.autoSplit).toBeUndefined();
    for (const candidate of generate(assembled.input).candidates) {
      expect(candidate.feasible).toBe(true);
      expect(candidate.blocks.map(minutes)).toEqual([45]);
      expect(candidate.explanationItems.map((item) => item.code)).not.toContain('auto_split_long_task');
    }
  });

  it('without the auto-split the same chain places nothing (negative control)', () => {
    const assembled = liveAssembly(tasks);
    const legacy: ScheduleInput = {
      ...assembled.input,
      tasks: assembled.input.tasks.map((task) => {
        if (task.autoSplit === undefined) return task;
        const required = task.remainingMin ?? task.estimate.p50Min;
        const unsplit = { ...task, splittable: false, minSessionMin: required, maxSessionMin: required };
        delete unsplit.autoSplit;
        return unsplit;
      }),
    };
    for (const candidate of generate(legacy).candidates) {
      expect(candidate.blocks).toEqual([]);
      const codes = candidate.explanationItems.map((item) => item.code);
      expect(codes).toContain('heuristic_blocked_by_predecessor');
      expect(codes).not.toContain('heuristic_insufficient_available_time');
    }
  });

  it('keeps locked out-of-scope tasks permissive and un-annotated', () => {
    const outside = { ...domainTask(1), dependsOn: [] };
    const assembled = assembleScheduleInput({
      ...liveInputSource([]),
      extraTasks: [outside],
      estimates: new Map([[outside.id, { taskId: outside.id, p50Min: 235, p90Min: 335 }]]),
      activeBlocks: [
        {
          id: liveId(50),
          planId: liveId(51),
          planVersionId: liveId(52),
          taskId: outside.id,
          startAt: '2026-11-16T01:00:00Z' as Instant,
          endAt: '2026-11-16T05:00:00Z' as Instant,
          locked: true,
          status: 'planned',
          version: 1,
        } as never,
      ],
    });
    expect(assembled.input.tasks[0]).toMatchObject({ splittable: true, minSessionMin: 1, maxSessionMin: 100_000 });
    expect(assembled.input.tasks[0]?.autoSplit).toBeUndefined();
  });

  it('round-trips the new coded items through the stored explanation JSON', () => {
    const blocked = generate({
      ...liveAssembly(tasks).input,
      tasks: liveAssembly(tasks).input.tasks.map((task) =>
        task.id === liveId(0) ? { ...task, dueAt: '2026-11-12T12:00:00Z' } : task,
      ),
    }).candidates[0]!;
    const candidate = generate(liveAssembly(tasks).input).candidates[0]!;
    for (const source of [candidate, blocked]) {
      const stored = JSON.parse(JSON.stringify(candidateExplanationJson(source.explanation, source.explanationItems)));
      const parsed = parseCandidateExplanation(stored);
      expect(parsed.explanation).toEqual(source.explanation);
      expect(parsed.explanationItems).toEqual(source.explanationItems);
    }
    expect(candidate.explanationItems.map((item) => item.code)).toContain('auto_split_long_task');
    expect(blocked.explanationItems.map((item) => item.code)).toContain('heuristic_blocked_by_predecessor');

    // A tampered reason is not an opaque token: all items drop (all-or-nothing).
    const stored = candidateExplanationJson(candidate.explanation, candidate.explanationItems) as unknown[];
    const envelope = stored[stored.length - 1] as { items: { code: string; params: Record<string, unknown> }[] };
    const index = envelope.items.findIndex((item) => item.code === 'auto_split_long_task');
    envelope.items[index]!.params['reason'] = 'break after';
    expect(parseCandidateExplanation(stored).explanationItems).toEqual([]);
  });
});

function liveInputSource(tasks: readonly Task[]) {
  return {
    now: '2026-11-12T11:34:00Z',
    timeZone: LIVE_AVAILABILITY.timeZone,
    horizon: { start: '2026-11-11T15:00:00Z', end: '2026-12-29T15:00:00Z' },
    availability: LIVE_AVAILABILITY,
    commitments: [],
    planningTasks: tasks,
    extraTasks: [] as Task[],
    estimates: new Map<string, { taskId: Id; p50Min: number; p90Min: number }>(),
    activeBlocks: [],
    seed: 1,
  };
}

// --- database: create -> approve -> replan -> today --------------------------

const START = '2026-11-11T08:00:00Z' as Instant;
const HORIZON = { start: '2026-11-11T00:00:00Z', end: '2026-11-14T00:00:00Z' };
const AVAILABILITY_BODY = {
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '18:00',
    kind: 'work',
  })),
  exceptions: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 60,
    breakMin: 15,
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
    riskLevel: 'p50',
  },
};

describe.skipIf(!hasDatabase)('auto-split through the planning API (FU-96)', () => {
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

  async function newOwner(label: string): Promise<{ ownerId: Id; session: TestSession; availabilityVersion: number }> {
    counter += 1;
    const email = `fu96-${label}-${counter}@example.com`;
    const ownerId = await ctx.seedUser({ email, password: 'correct-horse' });
    const session = await login(ctx, email, 'correct-horse');
    const current = await ctx.app.inject({ method: 'GET', url: '/api/v1/availability', headers: authHeaders(session) });
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/availability',
      headers: authHeaders(session, {
        'if-match': `W/"availability:${(current.json() as { version: number }).version}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: AVAILABILITY_BODY,
    });
    expect(put.statusCode).toBe(200);
    return { ownerId, session, availabilityVersion: (put.json() as { version: number }).version };
  }

  async function seedTask(
    ownerId: Id,
    options: { title: string; minutes: number; splittable: boolean; dependsOn?: readonly Id[] },
  ): Promise<Task> {
    const project = await ctx.repos.projects.create(ownerId, { title: 'FU-96 project' }, randomUUID());
    await ctx.db
      .insertInto('project')
      .values({ id: project.id, owner_id: ownerId, title: project.title, kind: 'normal' })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
    const task = await ctx.repos.tasks.create(
      ownerId,
      {
        projectId: project.id,
        title: options.title,
        splittable: options.splittable,
        dueAt: '2026-11-13T18:00:00Z' as Instant,
        ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
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
        due_at: new Date(Date.parse('2026-11-13T18:00:00Z')),
        splittable: options.splittable,
        min_session_min: 30,
        max_session_min: 90,
        priority: 2,
      })
      .execute();
    await ctx.db
      .insertInto('estimate')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerId,
        task_id: task.id,
        p50_min: options.minutes,
        p90_min: options.minutes,
        method: 'template',
        confidence: 0.6,
        is_current: true,
        created_at: new Date(Date.parse(ctx.clock.now())),
      })
      .execute();
    return task;
  }

  async function createPlan(session: TestSession, taskIds: readonly Id[]): Promise<Plan> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { scope: { taskIds }, policies: ['front_loaded'], horizon: HORIZON },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as Plan;
  }

  async function approve(
    session: TestSession,
    plan: Plan,
    availabilityVersion: number,
    body: Record<string, unknown> = {},
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan.id}/candidates/${plan.candidates[0]?.id}:approve`,
      headers: authHeaders(session, {
        'if-match': `W/"availability:${availabilityVersion}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: body,
    });
  }

  test('createPlan auto-splits, explains, stores the items, and approve succeeds', async () => {
    const { ownerId, session, availabilityVersion } = await newOwner('approve');
    const long = await seedTask(ownerId, { title: 'Long research', minutes: 160, splittable: false });
    const fits = await seedTask(ownerId, { title: 'Short review', minutes: 45, splittable: false, dependsOn: [long.id] });
    const plan = await createPlan(session, [long.id, fits.id]);
    const candidate = plan.candidates[0];
    if (candidate === undefined) throw new Error('no candidate');
    expect(candidate.feasible).toBe(true);
    const longBlocks = candidate.blocks.filter((block) => block.taskId === long.id);
    expect(longBlocks.length).toBeGreaterThanOrEqual(3);
    expect(longBlocks.every((block) => minutes(block) <= 60)).toBe(true);
    expect(longBlocks.reduce((sum, block) => sum + minutes(block), 0)).toBe(160);
    expect(candidate.blocks.filter((block) => block.taskId === fits.id).map(minutes)).toEqual([45]);
    expect(candidate.explanationItems).toContainEqual({
      code: 'auto_split_long_task',
      params: { taskId: long.id, sessionMaxMin: 60, reason: 'break_after' },
    });
    expect(candidate.explanation).toHaveLength(candidate.explanationItems?.length ?? -1);

    // The pg row round-trips the coded items unchanged.
    const read = await ctx.app.inject({ method: 'GET', url: `/api/v1/plans/${plan.id}`, headers: authHeaders(session) });
    expect(read.statusCode).toBe(200);
    expect((read.json() as Plan).candidates[0]?.explanationItems).toEqual(candidate.explanationItems);

    // Negative: one 160-minute block breaks the auto-split bounds (and H6).
    const merged = await approve(session, plan, availabilityVersion, {
      editedBlocks: [
        { taskId: long.id, startAt: '2026-11-11T09:00:00Z', endAt: '2026-11-11T11:40:00Z' },
        ...candidate.blocks.filter((block) => block.taskId === fits.id),
      ],
    });
    expect(merged.statusCode).toBe(422);
    const problem = merged.json() as { code: string; violations: { code: string; taskId?: string }[] };
    expect(problem.code).toBe('constraint_violation');
    expect(problem.violations).toContainEqual(expect.objectContaining({ code: 'H5', taskId: long.id }));

    const approved = await approve(session, plan, availabilityVersion);
    expect(approved.statusCode).toBe(201);
    const version = approved.json() as PlanVersionDto;
    expect(version.blocks.filter((block) => block.taskId === long.id)).toHaveLength(longBlocks.length);

    // Scheduling-only: the stored task keeps splittable=false.
    expect((await ctx.repos.tasks.get(ownerId, long.id))?.splittable).toBe(false);
  });

  test('the replan path re-places the remainder with the same bounds and approves', async () => {
    const { ownerId, session, availabilityVersion } = await newOwner('replan');
    const long = await seedTask(ownerId, { title: 'Long draft', minutes: 160, splittable: false });
    const plan = await createPlan(session, [long.id]);
    expect((await approve(session, plan, availabilityVersion)).statusCode).toBe(201);
    const first = [...(plan.candidates[0]?.blocks ?? [])].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt))[0];
    if (first === undefined) throw new Error('no block');
    // The first session is history now; 160 - its minutes remain (> 60).
    ctx.clock.set(first.endAt as Instant);

    const requested = await requestReplan(ctx, session, { planId: plan.id, affectedTaskIds: [long.id] });
    expect(requested.statusCode).toBe(201);
    const proposal = requested.json() as ReplanProposal;
    expect(proposal.candidate.flags).not.toContain('infeasible');
    const future = proposal.candidate.blocks.filter((block) => block.taskId === long.id);
    expect(future.reduce((sum, block) => sum + minutes(block), 0)).toBe(160 - minutes(first));
    expect(future.length).toBeGreaterThan(1);
    expect(future.every((block) => minutes(block) <= 60)).toBe(true);
    expect(proposal.candidate.explanationItems).toContainEqual({
      code: 'auto_split_long_task',
      params: { taskId: long.id, sessionMaxMin: 60, reason: 'break_after' },
    });

    // Negative: the replan approval validates against the same bounds.
    const start = Date.parse(future[0]!.startAt);
    const merged = await approveProposal(ctx, session, proposal, {
      body: {
        editedBlocks: [
          {
            taskId: long.id,
            startAt: future[0]!.startAt,
            endAt: new Date(start + (160 - minutes(first)) * MINUTE_MS).toISOString(),
          },
        ],
      },
    });
    expect(merged.statusCode).toBe(422);
    expect((merged.json() as { code: string }).code).toBe('constraint_violation');

    const approved = await approveProposal(ctx, session, proposal);
    expect(approved.statusCode).toBe(201);
  });

  test('the today path validates the same bounds: reschedule works, an undersized shrink does not', async () => {
    const { ownerId, session, availabilityVersion } = await newOwner('today');
    const long = await seedTask(ownerId, { title: 'Long writing', minutes: 160, splittable: false });
    const plan = await createPlan(session, [long.id]);
    expect((await approve(session, plan, availabilityVersion)).statusCode).toBe(201);
    const todayResponse = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/today?date=2026-11-11',
      headers: authHeaders(session),
    });
    expect(todayResponse.statusCode).toBe(200);
    const today = todayResponse.json() as Today;
    const sessions = [...today.blocks]
      .filter((block) => block.taskId === long.id)
      .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    const last = sessions[sessions.length - 1]!;

    // Every today action re-validates all future blocks of the plan; with the
    // pre-FU-96 bounds the three sessions were an H5 "single block" finding.
    const rescheduled = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:reschedule',
      headers: authHeaders(session, { 'if-match': `W/"${today.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11', blockIds: [last.id], toDate: '2026-11-12' },
    });
    expect(rescheduled.statusCode).toBe(201);
    const proposal = rescheduled.json() as TodayProposal;
    expect(proposal.blocks[0]?.startAt.startsWith('2026-11-12')).toBe(true);

    // Negative: shrinking a session below the 30-minute auto-split minimum is H5.
    const shrunk = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/today:shrink',
      headers: authHeaders(session, { 'if-match': `W/"${today.version}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { date: '2026-11-11', blockId: last.id, targetMin: 20 },
    });
    expect(shrunk.statusCode).toBe(422);
    const problem = shrunk.json() as { code: string; violations: { code: string; messageCode?: string }[] };
    expect(problem.code).toBe('constraint_violation');
    expect(problem.violations).toContainEqual(
      expect.objectContaining({ code: 'H5', messageCode: 'h5_session_out_of_bounds' }),
    );
  });
});
