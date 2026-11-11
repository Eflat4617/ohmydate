import type {
  Block,
  PlanCandidate,
  PolicyName,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate, validate } from '../src/index.js';

/**
 * FU-69: a replan was infeasible where a fresh plan was feasible. Neither
 * root cause is DST arithmetic; the DST weekends of the fast-check scenarios
 * only shape the horizon (one 480-minute Monday, or a short tail slot).
 *
 * 1. Rigid chunks: a grown task is an affected task, so its seeds were dropped
 *    and it was re-placed as `ceil(required / maxSession)` equal chunks.
 *    Between the frozen blocks of the unaffected tasks no gap held one such
 *    chunk, although the task is splittable and the gaps add up.
 * 2. Starved dependents: a released predecessor was placed with no regard for
 *    the room its dependents still need, so `balanced` (least-loaded day)
 *    parked it in the tail of the horizon and the dependent no longer fitted.
 */

const MINUTE_MS = 60_000;
const POLICIES: PolicyName[] = ['front_loaded', 'balanced', 'focus_blocked'];

function blockKey(block: Block): string {
  return `${block.taskId}|${block.start}|${block.end}`;
}

function taskBlocks(blocks: Block[], taskId: string): Block[] {
  return blocks.filter((block) => block.taskId === taskId);
}

function minutesOf(blocks: Block[]): number {
  return blocks.reduce(
    (sum, block) =>
      sum + (Date.parse(block.end) - Date.parse(block.start)) / MINUTE_MS,
    0,
  );
}

function symmetricDifference(a: Block[], b: Block[]): number {
  const keysA = new Set(a.map(blockKey));
  const keysB = new Set(b.map(blockKey));
  let changed = 0;
  for (const key of keysA) {
    if (!keysB.has(key)) {
      changed += 1;
    }
  }
  for (const key of keysB) {
    if (!keysA.has(key)) {
      changed += 1;
    }
  }
  return changed;
}

function only(input: ScheduleInput, policy: PolicyName): PlanCandidate {
  const [candidate] = generate(input, {
    policies: [policy],
    seed: input.seed,
  }).candidates;
  if (candidate === undefined) {
    throw new Error('generate returned no candidate');
  }
  return candidate;
}

function expectValid(input: ScheduleInput, candidate: PlanCandidate): void {
  // Independent validator, not the generator's own verdict.
  expect(
    validate(input, candidate.blocks, { riskLevel: input.prefs.riskLevel }),
  ).toEqual([]);
  expect(candidate.feasible).toBe(true);
  expect(candidate.deficitMin).toBe(0);
}

function expectSessionsInBounds(input: ScheduleInput, blocks: Block[]): void {
  for (const task of input.tasks) {
    for (const block of taskBlocks(blocks, task.id)) {
      const durationMin = minutesOf([block]);
      expect(durationMin).toBeGreaterThanOrEqual(task.minSessionMin);
      expect(durationMin).toBeLessThanOrEqual(task.maxSessionMin);
    }
  }
}

interface Weekend {
  name: string;
  timeZone: string;
  start: string;
  end: string;
  /** UTC instant of Monday 09:00 local, the only weekday window in range. */
  mondayStart: string;
}

/**
 * Weekday-only 09:00-17:00 windows over a DST weekend: only Monday has
 * capacity (480 min). Mirrors the fast-check counterexample builder in
 * `replan.property.test.ts` (seed -1548650610, path 99:11:15:19:19:19:19:20).
 */
const WEEKENDS: Weekend[] = [
  {
    name: 'Europe/Berlin DST end (2026-10-25), the reported counterexample',
    timeZone: 'Europe/Berlin',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-27T00:00:00Z',
    mondayStart: '2026-10-26T08:00:00Z',
  },
  {
    name: 'Europe/Berlin DST start (2026-03-29)',
    timeZone: 'Europe/Berlin',
    start: '2026-03-29T00:00:00Z',
    end: '2026-03-31T00:00:00Z',
    mondayStart: '2026-03-30T07:00:00Z',
  },
  {
    name: 'America/New_York DST end (2026-11-01), negative offset',
    timeZone: 'America/New_York',
    start: '2026-11-01T04:00:00Z',
    end: '2026-11-03T00:00:00Z',
    mondayStart: '2026-11-02T14:00:00Z',
  },
];

function weekendInput(weekend: Weekend, t0Min: number): ScheduleInput {
  const durations = [t0Min, 95, 100];
  const maxSessions = [180, 95, 100];
  const tasks: Task[] = durations.map((durationMin, index) => ({
    id: `T${index}`,
    dueAt: weekend.end,
    earliestStartAt: weekend.start,
    estimate: { p50Min: durationMin, p90Min: durationMin },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: maxSessions[index] ?? durationMin,
    priority: 1,
    dependsOn: [],
  }));
  return {
    now: weekend.start,
    timeZone: weekend.timeZone,
    horizon: { start: weekend.start, end: weekend.end },
    tasks,
    availability: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '09:00',
      endLocal: '17:00',
      kind: 'work',
    })),
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 0,
  };
}

function at(base: string, offsetMin: number): string {
  return new Date(Date.parse(base) + offsetMin * MINUTE_MS)
    .toISOString()
    .replace('.000Z', 'Z');
}

describe('FU-69 grown task between frozen blocks on a DST weekend', () => {
  for (const weekend of WEEKENDS) {
    it(`front_loaded keeps every existing block and adds one session: ${weekend.name}`, () => {
      const baseInput = weekendInput(weekend, 115);
      const base = only(baseInput, 'front_loaded');
      expectValid(baseInput, base);
      // T0 115 | T1 95 | T2 100 back to back from Monday 09:00 local; the
      // free tail is 170 min and T0's own slot is 115 min.
      expect(base.blocks).toEqual([
        { taskId: 'T0', start: weekend.mondayStart, end: at(weekend.mondayStart, 115) },
        { taskId: 'T1', start: at(weekend.mondayStart, 115), end: at(weekend.mondayStart, 210) },
        { taskId: 'T2', start: at(weekend.mondayStart, 210), end: at(weekend.mondayStart, 310) },
      ]);

      // T0 grows by 60 min to 175: one 175-min chunk fits neither gap.
      const mutated = weekendInput(weekend, 175);
      const fresh = only(mutated, 'front_loaded');
      expectValid(mutated, fresh);

      const replanInput: ScheduleInput = {
        ...mutated,
        existingBlocks: base.blocks,
      };
      const replan = only(replanInput, 'front_loaded');
      expectValid(replanInput, replan);
      expect(replan.blocks).toEqual([
        ...base.blocks,
        { taskId: 'T0', start: at(weekend.mondayStart, 310), end: at(weekend.mondayStart, 370) },
      ]);
      expect(replan.metrics.changedBlocks).toBe(1);
      expect(replan.explanation.join('\n')).toContain(
        'Placed 370 of 370 required minutes in 4 movable block(s), retaining 3 existing block(s).',
      );
      expect(
        replan.explanation.some((line) =>
          line.startsWith('Replan change bound exceeded:'),
        ),
      ).toBe(false);
    });

    it(`every policy stays feasible with unaffected blocks frozen: ${weekend.name}`, () => {
      for (const policy of POLICIES) {
        const baseInput = weekendInput(weekend, 115);
        const base = only(baseInput, policy);
        expectValid(baseInput, base);

        const mutated = weekendInput(weekend, 175);
        expectValid(mutated, only(mutated, policy));

        const replanInput: ScheduleInput = {
          ...mutated,
          existingBlocks: base.blocks,
        };
        const replan = only(replanInput, policy);
        expectValid(replanInput, replan);
        expectSessionsInBounds(replanInput, replan.blocks);
        expect(minutesOf(taskBlocks(replan.blocks, 'T0'))).toBe(175);
        for (const frozen of ['T1', 'T2']) {
          expect(taskBlocks(replan.blocks, frozen)).toEqual(
            taskBlocks(base.blocks, frozen),
          );
        }
        expect(replan.metrics.changedBlocks).toBe(
          symmetricDifference(base.blocks, replan.blocks),
        );
        // 06 §7.1 bound: 2 x (affected existing blocks = T0's one) + 2.
        expect(replan.metrics.changedBlocks).toBeLessThanOrEqual(4);
      }
    });
  }

  it('is deterministic: the same replan input gives byte-identical output', () => {
    const [weekend] = WEEKENDS;
    if (weekend === undefined) {
      throw new Error('missing fixture');
    }
    const base = only(weekendInput(weekend, 115), 'front_loaded');
    const replanInput: ScheduleInput = {
      ...weekendInput(weekend, 175),
      existingBlocks: base.blocks,
    };
    const options = { policies: POLICIES, seed: 0 };
    expect(JSON.stringify(generate(replanInput, options))).toBe(
      JSON.stringify(generate(replanInput, options)),
    );
  });
});

interface DayOptions {
  tasks: Task[];
  dayEndLocal?: string;
  commitments?: ScheduleInput['commitments'];
  existingBlocks?: Block[];
  prefs?: Partial<ScheduleInput['prefs']>;
  days?: number;
}

/** UTC days from Monday 2026-11-09, availability 09:00 to `dayEndLocal`. */
function dayInput(options: DayOptions): ScheduleInput {
  const days = options.days ?? 1;
  const end = `2026-11-${String(9 + days).padStart(2, '0')}T00:00:00Z`;
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: { start: '2026-11-09T00:00:00Z', end },
    tasks: options.tasks,
    availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '09:00',
      endLocal: options.dayEndLocal ?? '12:00',
      kind: 'work',
    })),
    exceptions: [],
    commitments: options.commitments ?? [],
    lockedBlocks: [],
    ...(options.existingBlocks === undefined
      ? {}
      : { existingBlocks: options.existingBlocks }),
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
      ...options.prefs,
    },
    seed: 69,
  };
}

function task(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function utc(clock: string, day = 9): string {
  return `2026-11-${String(day).padStart(2, '0')}T${clock}:00Z`;
}

describe('FU-69 shrunk counterexample (two tasks, UTC, no DST)', () => {
  const existing: Block[] = [
    { taskId: 'T0', start: utc('09:00'), end: utc('10:00') },
    { taskId: 'T1', start: utc('10:00'), end: utc('11:00') },
  ];
  const grown = (overrides: Partial<Task> = {}): Task[] => [
    task({ id: 'T0', estimate: { p50Min: 90, p90Min: 90 }, ...overrides }),
    task({ id: 'T1' }),
  ];

  it('generates the existing plan from scratch in every policy', () => {
    for (const policy of POLICIES) {
      const input = dayInput({ tasks: [task({ id: 'T0' }), task({ id: 'T1' })] });
      expect(only(input, policy).blocks).toEqual(existing);
    }
  });

  it('keeps T0 09:00-10:00, freezes T1 and adds the 30-minute remainder', () => {
    for (const policy of POLICIES) {
      const fresh = dayInput({ tasks: grown() });
      expectValid(fresh, only(fresh, policy));

      const replanInput = dayInput({ tasks: grown(), existingBlocks: existing });
      const replan = only(replanInput, policy);
      expectValid(replanInput, replan);
      expect(replan.blocks).toEqual([
        ...existing,
        { taskId: 'T0', start: utc('11:00'), end: utc('11:30') },
      ]);
      expect(replan.metrics.changedBlocks).toBe(1);
    }
  });

  it('re-splits the whole task when its own block cannot be kept', () => {
    // minSession 45: keeping the 60-minute block would leave a 30-minute
    // remainder below the minimum, so both sessions are fitted afresh.
    for (const policy of POLICIES) {
      const tasks = grown({ minSessionMin: 45 });
      const replanInput = dayInput({ tasks, existingBlocks: existing });
      const replan = only(replanInput, policy);
      expectValid(replanInput, replan);
      expectSessionsInBounds(replanInput, replan.blocks);
      expect(taskBlocks(replan.blocks, 'T0')).toHaveLength(2);
      expect(minutesOf(taskBlocks(replan.blocks, 'T0'))).toBe(90);
      expect(taskBlocks(replan.blocks, 'T1')).toEqual(taskBlocks(existing, 'T1'));
      // 1 removed + 2 added <= 2 x 1 + 2.
      expect(replan.metrics.changedBlocks).toBe(3);
    }
  });

  it('still returns an explained infeasible candidate for a non-splittable task (negative)', () => {
    // 06 §7.1: unaffected blocks stay frozen; when no placement exists under
    // that freeze the candidate is infeasible and explained, even though a
    // fresh plan is feasible. The gap-fitted split never splits such a task.
    for (const policy of POLICIES) {
      const tasks = grown({ splittable: false });
      const fresh = dayInput({ tasks });
      expectValid(fresh, only(fresh, policy));

      const replan = only(dayInput({ tasks, existingBlocks: existing }), policy);
      expect(replan.feasible).toBe(false);
      expect(replan.deficitMin).toBe(90);
      expect(replan.blocks).toEqual(taskBlocks(existing, 'T1'));
      expect(replan.explanation.join('\n')).toContain('H7');
      expect(replan.explanation.join('\n')).toContain('no_contiguous_window');
    }
  });

  it('does not use gaps shorter than minSessionMin (negative)', () => {
    // Free time is 60 + 60 min but every session must be at least 90 min.
    for (const policy of POLICIES) {
      const tasks = grown({ minSessionMin: 90 });
      const replan = only(dayInput({ tasks, existingBlocks: existing }), policy);
      expect(replan.feasible).toBe(false);
      expect(replan.deficitMin).toBe(90);
      expect(replan.blocks).toEqual(taskBlocks(existing, 'T1'));
    }
  });
});

describe('FU-69 gap-fitted sessions', () => {
  it('splits a fresh task around a commitment instead of reporting a shortfall', () => {
    // 09:00-17:00 with a commitment 10:55-14:10 leaves 115 + 170 min; the
    // 175-minute task needs one 175-minute chunk by the equal-chunk rule.
    const input = dayInput({
      tasks: [
        task({
          id: 'A',
          estimate: { p50Min: 175, p90Min: 175 },
          maxSessionMin: 180,
        }),
      ],
      dayEndLocal: '17:00',
      commitments: [{ start: utc('10:55'), end: utc('14:10') }],
    });
    for (const policy of POLICIES) {
      const candidate = only(input, policy);
      expectValid(input, candidate);
      expectSessionsInBounds(input, candidate.blocks);
      expect(minutesOf(candidate.blocks)).toBe(175);
      expect(candidate.blocks).toHaveLength(2);
    }
    // front_loaded fills the earliest gap first.
    expect(only(input, 'front_loaded').blocks).toEqual([
      { taskId: 'A', start: utc('09:00'), end: utc('10:55') },
      { taskId: 'A', start: utc('14:10'), end: utc('15:10') },
    ]);
    // focus_blocked takes the longest gap first; the 30-minute rest must stay
    // a valid session, so the long session is 145 min, not the full 170.
    expect(only(input, 'focus_blocked').blocks).toEqual([
      { taskId: 'A', start: utc('09:00'), end: utc('09:30') },
      { taskId: 'A', start: utc('14:10'), end: utc('16:35') },
    ]);
  });

  it('keeps the equal-chunk shortfall when the gaps cannot cover the task (negative)', () => {
    // 60 free minutes for a 90-minute task: no complete split exists, so the
    // partial equal-chunk result (one 45-minute chunk) is reported unchanged.
    const input = dayInput({
      tasks: [
        task({
          id: 'A',
          estimate: { p50Min: 90, p90Min: 90 },
          maxSessionMin: 60,
        }),
      ],
      dayEndLocal: '10:00',
    });
    const candidate = only(input, 'front_loaded');
    expect(candidate.feasible).toBe(false);
    expect(candidate.deficitMin).toBe(45);
    expect(candidate.blocks).toEqual([
      { taskId: 'A', start: utc('09:00'), end: utc('09:45') },
    ]);
  });

  it('leaves the H6 break after a frozen run before continuing', () => {
    // breakAfter 120: T0 09:00-10:00 + frozen T1 10:00-11:00 is a full run,
    // so the 90-minute remainder may only start at 11:15.
    const existing: Block[] = [
      { taskId: 'T0', start: utc('09:00'), end: utc('10:00') },
      { taskId: 'T1', start: utc('10:00'), end: utc('11:00') },
    ];
    const tasks = [
      task({ id: 'T0', estimate: { p50Min: 150, p90Min: 150 }, maxSessionMin: 180 }),
      task({ id: 'T1' }),
    ];
    const replanInput = dayInput({
      tasks,
      dayEndLocal: '13:00',
      existingBlocks: existing,
      prefs: { breakAfterMin: 120 },
    });
    for (const policy of POLICIES) {
      const replan = only(replanInput, policy);
      expectValid(replanInput, replan);
      expect(replan.blocks).toEqual([
        ...existing,
        { taskId: 'T0', start: utc('11:15'), end: utc('12:45') },
      ]);
    }
  });

  it('respects the daily focus cap across days and fails when it cannot (negative)', () => {
    // Two days, 60 frozen minutes each, cap 120/day: T0 grows to 120 and can
    // only take 60 more minutes per day.
    const existing: Block[] = [
      { taskId: 'T0', start: utc('09:00'), end: utc('10:00') },
      { taskId: 'T1', start: utc('10:00'), end: utc('11:00') },
      { taskId: 'T2', start: utc('09:00', 10), end: utc('10:00', 10) },
    ];
    const tasks = (t0Min: number): Task[] => [
      task({ id: 'T0', estimate: { p50Min: t0Min, p90Min: t0Min }, maxSessionMin: 240 }),
      task({ id: 'T1' }),
      task({ id: 'T2' }),
    ];
    const build = (t0Min: number): ScheduleInput =>
      dayInput({
        tasks: tasks(t0Min),
        days: 2,
        existingBlocks: existing,
        prefs: { maxDailyFocusMin: 120 },
      });

    for (const policy of POLICIES) {
      const replanInput = build(120);
      const replan = only(replanInput, policy);
      expectValid(replanInput, replan);
      expect(replan.metrics.maxDailyLoadMin).toBe(120);
      expect(replan.blocks).toEqual([
        existing[0],
        existing[1],
        existing[2],
        { taskId: 'T0', start: utc('10:00', 10), end: utc('11:00', 10) },
      ]);

      // 150 minutes exceed what the cap leaves (60 + 60): no complete split.
      const tooMuch = only(build(150), policy);
      expect(tooMuch.feasible).toBe(false);
      expect(tooMuch.deficitMin).toBeGreaterThan(0);
      for (const frozen of ['T1', 'T2']) {
        expect(taskBlocks(tooMuch.blocks, frozen)).toEqual(
          taskBlocks(existing, frozen),
        );
      }
    }
  });

  it('flags a split that exceeds the change bound instead of exceeding it silently', () => {
    // T0 09:00-10:00, then five frozen 30-minute tasks with 30-minute gaps.
    // T0 grows by 150 min: five extra sessions > 2 x 1 + 2.
    const existing: Block[] = [
      { taskId: 'T0', start: utc('09:00'), end: utc('10:00') },
    ];
    const tasks: Task[] = [
      task({ id: 'T0', estimate: { p50Min: 210, p90Min: 210 }, maxSessionMin: 240 }),
    ];
    for (let index = 0; index < 5; index += 1) {
      const startMin = 60 + index * 60;
      const start = at(utc('09:00'), startMin);
      existing.push({ taskId: `F${index}`, start, end: at(start, 30) });
      tasks.push(
        task({ id: `F${index}`, estimate: { p50Min: 30, p90Min: 30 }, maxSessionMin: 30 }),
      );
    }
    const replanInput = dayInput({
      tasks,
      dayEndLocal: '15:00',
      existingBlocks: existing,
    });
    const result = generate(replanInput, { policies: ['front_loaded'], seed: 69 });
    const [replan] = result.candidates;
    if (replan === undefined) {
      throw new Error('generate returned no candidate');
    }
    expectValid(replanInput, replan);
    for (const block of existing) {
      expect(replan.blocks).toContainEqual(block);
    }
    expect(taskBlocks(replan.blocks, 'T0')).toHaveLength(6);
    expect(replan.metrics.changedBlocks).toBe(5);
    expect(
      replan.explanation.some((line) =>
        line.startsWith('Replan change bound exceeded: 5 changed block(s) > 4'),
      ),
    ).toBe(true);
    expect(result.diversityNote).toContain('Replan change bound exceeded:');
  });
});

interface PropertyTask {
  durationUnits: number;
  maxUnits: number;
  priority: 1 | 2 | 3 | 4;
}

interface PropertyCase {
  name: string;
  timeZone: string;
  start: string;
  end: string;
  weekdays: number[];
  tasks: PropertyTask[];
  /** `[dependent, dependency]` edge added by the mutation. */
  edge: [number, number];
}

/** Same construction as `buildInput`/`mutate` in `replan.property.test.ts`. */
function propertyInput(spec: PropertyCase, withEdge: boolean): ScheduleInput {
  const tasks: Task[] = spec.tasks.map((entry, index) => {
    const durationMin = entry.durationUnits * 5;
    return {
      id: `T${index}`,
      dueAt: spec.end,
      earliestStartAt: spec.start,
      estimate: { p50Min: durationMin, p90Min: durationMin },
      splittable: true,
      minSessionMin: Math.min(30, durationMin),
      maxSessionMin: Math.max(entry.durationUnits, entry.maxUnits) * 5,
      priority: entry.priority,
      dependsOn:
        withEdge && index === spec.edge[0] ? [`T${spec.edge[1]}`] : [],
    };
  });
  return {
    now: spec.start,
    timeZone: spec.timeZone,
    horizon: { start: spec.start, end: spec.end },
    tasks,
    availability: spec.weekdays.map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '00:00',
      endLocal: '24:00',
      kind: 'work',
    })),
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 0,
  };
}

function expectDependencyOrder(
  blocks: Block[],
  dependentId: string,
  dependencyId: string,
): void {
  const dependencyEnd = Math.max(
    ...taskBlocks(blocks, dependencyId).map((block) => Date.parse(block.end)),
  );
  const dependentStart = Math.min(
    ...taskBlocks(blocks, dependentId).map((block) => Date.parse(block.start)),
  );
  expect(dependentStart).toBeGreaterThanOrEqual(dependencyEnd);
}

/**
 * Counterexamples found by raising the replan property to 2000 runs: with
 * all-day windows the horizon ends one or two hours into Tuesday, and
 * `balanced` re-placed the predecessor into (or right before) that tail.
 */
const DEPENDENCY_CASES: PropertyCase[] = [
  {
    name: 'Europe/Berlin DST end, seed 5037 path 542:3:2:3:3:7:4:5:6:2:7:6:6:7:9:12:15:15',
    timeZone: 'Europe/Berlin',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-27T00:00:00Z',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    tasks: [
      { durationUnits: 6, maxUnits: 12, priority: 2 },
      { durationUnits: 18, maxUnits: 12, priority: 2 },
      { durationUnits: 7, maxUnits: 12, priority: 1 },
    ],
    edge: [2, 1],
  },
  {
    name: 'Europe/Berlin DST end, seed 2035140076 path 1063:7:10:9:10:10:7:9:9:9:10:11:11:11:12',
    timeZone: 'Europe/Berlin',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-27T00:00:00Z',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    tasks: [
      { durationUnits: 18, maxUnits: 12, priority: 2 },
      { durationUnits: 7, maxUnits: 12, priority: 1 },
      { durationUnits: 6, maxUnits: 12, priority: 2 },
    ],
    edge: [1, 0],
  },
  {
    name: 'Europe/Berlin DST start, weekdays only, seed 2035140076 path 1835:5:4:9:11:10:10:11:11:12',
    timeZone: 'Europe/Berlin',
    start: '2026-03-29T00:00:00Z',
    end: '2026-03-31T00:00:00Z',
    weekdays: [1, 2, 3, 4, 5],
    tasks: [
      { durationUnits: 10, maxUnits: 12, priority: 1 },
      { durationUnits: 15, maxUnits: 12, priority: 1 },
      { durationUnits: 12, maxUnits: 12, priority: 1 },
    ],
    edge: [1, 0],
  },
];

describe('FU-69 added dependency: the predecessor leaves room for its dependent', () => {
  for (const spec of DEPENDENCY_CASES) {
    it(`balanced replan is feasible with the unaffected task frozen: ${spec.name}`, () => {
      const baseInput = propertyInput(spec, false);
      const base = only(baseInput, 'balanced');
      expectValid(baseInput, base);

      const mutated = propertyInput(spec, true);
      expectValid(mutated, only(mutated, 'balanced'));

      const replanInput: ScheduleInput = {
        ...mutated,
        existingBlocks: base.blocks,
      };
      const replan = only(replanInput, 'balanced');
      expectValid(replanInput, replan);
      const [dependent, dependency] = spec.edge;
      expectDependencyOrder(replan.blocks, `T${dependent}`, `T${dependency}`);

      const frozen = [0, 1, 2].find((index) => !spec.edge.includes(index));
      expect(taskBlocks(replan.blocks, `T${frozen}`)).toEqual(
        taskBlocks(base.blocks, `T${frozen}`),
      );
      expect(replan.metrics.changedBlocks).toBe(
        symmetricDifference(base.blocks, replan.blocks),
      );
      // Both edge endpoints are affected (one existing block each).
      expect(replan.metrics.changedBlocks).toBeLessThanOrEqual(2 * 2 + 2);
    });
  }
});

/**
 * Hand-made UTC version (no DST): Monday and Tuesday 09:00-17:00 plus a
 * 60-minute tail on Wednesday. F and G hold 240 minutes of Monday and Tuesday,
 * so Wednesday is the least-loaded day and exactly fits the predecessor P.
 */
function tailInput(options: {
  dependent: Partial<Task>;
  existingBlocks?: Block[];
  end?: string;
}): ScheduleInput {
  const start = '2026-11-09T09:00:00Z';
  const end = options.end ?? '2026-11-11T10:00:00Z';
  const base = { dueAt: end, earliestStartAt: start };
  return {
    now: start,
    timeZone: 'UTC',
    horizon: { start, end },
    tasks: [
      task({ id: 'F', ...base, estimate: { p50Min: 240, p90Min: 240 }, maxSessionMin: 240 }),
      task({ id: 'G', ...base, estimate: { p50Min: 240, p90Min: 240 }, maxSessionMin: 240 }),
      task({ id: 'P', ...base }),
      task({ id: 'S', ...base, dependsOn: ['P'], ...options.dependent }),
    ],
    availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '09:00',
      endLocal: '17:00',
      kind: 'work',
    })),
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    ...(options.existingBlocks === undefined
      ? {}
      : { existingBlocks: options.existingBlocks }),
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 69,
  };
}

describe('FU-69 successor bound (UTC, no DST)', () => {
  const frozen: Block[] = [
    { taskId: 'F', start: utc('09:00'), end: utc('13:00') },
    { taskId: 'G', start: utc('09:00', 10), end: utc('13:00', 10) },
  ];
  // S was planned before P; the new edge S -> P releases both.
  const outOfOrder: Block[] = [
    ...frozen,
    { taskId: 'S', start: utc('13:00'), end: utc('14:00') },
    { taskId: 'P', start: utc('13:00', 10), end: utc('14:00', 10) },
  ];

  it('balanced keeps the predecessor out of the tail slot in a replan', () => {
    const replanInput = tailInput({ dependent: {}, existingBlocks: outOfOrder });
    const replan = only(replanInput, 'balanced');
    expectValid(replanInput, replan);
    expectDependencyOrder(replan.blocks, 'S', 'P');
    for (const block of frozen) {
      expect(replan.blocks).toContainEqual(block);
    }
    // The dependent, not the predecessor, takes the Wednesday tail.
    expect(taskBlocks(replan.blocks, 'S')).toEqual([
      { taskId: 'S', start: utc('09:00', 11), end: utc('10:00', 11) },
    ]);
  });

  it('balanced keeps the predecessor out of the tail slot in a fresh plan', () => {
    const input = tailInput({ dependent: {} });
    const candidate = only(input, 'balanced');
    expectValid(input, candidate);
    expectDependencyOrder(candidate.blocks, 'S', 'P');
  });

  it('every policy plans the chain, fresh and replanned', () => {
    for (const policy of POLICIES) {
      const fresh = tailInput({ dependent: {} });
      expectValid(fresh, only(fresh, policy));
      const replanInput = tailInput({ dependent: {}, existingBlocks: outOfOrder });
      const replan = only(replanInput, policy);
      expectValid(replanInput, replan);
      for (const block of frozen) {
        expect(replan.blocks).toContainEqual(block);
      }
    }
  });

  it('a dependent that can never fit does not move its predecessor (negative)', () => {
    // S needs one 600-minute block; no slot is that long. P keeps the
    // least-loaded Wednesday tail exactly as without the bound.
    const input = tailInput({
      dependent: {
        estimate: { p50Min: 600, p90Min: 600 },
        splittable: false,
        minSessionMin: 600,
        maxSessionMin: 600,
      },
    });
    const candidate = only(input, 'balanced');
    expect(candidate.feasible).toBe(false);
    expect(candidate.deficitMin).toBe(600);
    expect(taskBlocks(candidate.blocks, 'P')).toEqual([
      { taskId: 'P', start: utc('09:00', 11), end: utc('10:00', 11) },
    ]);
    expect(candidate.explanation.join('\n')).toContain(
      'Task "S" is short by 600 minutes (deficit).',
    );
  });

  it('keeps the plain plan when the repair pass is not strictly better (negative)', () => {
    // Two 90-minute days, so the work is not over capacity and the repair
    // pass runs; but both tasks are due at the end of Monday. Plain: P
    // 09:00-10:00, S cannot follow (short by 60). The successor bound would
    // leave P only 09:00-09:30 and place neither (short by 120), so the plain
    // plan is the one reported.
    const start = '2026-11-09T09:00:00Z';
    const mondayEnd = '2026-11-09T10:30:00Z';
    const input: ScheduleInput = {
      ...tailInput({ dependent: {}, end: '2026-11-10T10:30:00Z' }),
      tasks: [
        task({ id: 'P', dueAt: mondayEnd, earliestStartAt: start }),
        task({
          id: 'S',
          dueAt: mondayEnd,
          earliestStartAt: start,
          dependsOn: ['P'],
        }),
      ],
      availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday: weekday as Weekday,
        startLocal: '09:00',
        endLocal: '10:30',
        kind: 'work',
      })),
    };
    for (const policy of POLICIES) {
      const candidate = only(input, policy);
      expect(candidate.feasible).toBe(false);
      expect(candidate.deficitMin).toBe(60);
      expect(candidate.blocks).toEqual([
        { taskId: 'P', start: utc('09:00'), end: utc('10:00') },
      ]);
    }
  });
});
