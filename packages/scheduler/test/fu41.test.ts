import fc from 'fast-check';
import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate } from '../src/index.js';

const MINUTE_MS = 60_000;

function blockKey(block: Block): string {
  return `${block.taskId}|${block.start}|${block.end}`;
}

function taskKeys(blocks: Block[], taskId: string): string[] {
  return blocks
    .filter((block) => block.taskId === taskId)
    .map(blockKey)
    .sort();
}

function affectedTasks(tasks: Task[], hit: Set<string>): Set<string> {
  const affected = new Set(hit);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const task of tasks) {
      if (affected.has(task.id)) {
        continue;
      }
      if (task.dependsOn.some((dependency) => affected.has(dependency))) {
        affected.add(task.id);
        expanded = true;
      }
    }
  }
  return affected;
}

/**
 * 06 §7 maximum replan scope: the trigger set plus successors, with direct
 * predecessors released one stage at a time and their successors re-added,
 * until the set stops growing.
 */
function expandedScope(tasks: Task[], start: Set<string>): Set<string> {
  let scope = affectedTasks(tasks, start);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (!scope.has(task.id)) {
        continue;
      }
      for (const dependency of task.dependsOn) {
        if (!scope.has(dependency)) {
          scope.add(dependency);
          changed = true;
        }
      }
    }
    const propagated = affectedTasks(tasks, scope);
    if (propagated.size !== scope.size) {
      scope = propagated;
      changed = true;
    }
  }
  return scope;
}

function hitTasks(blocks: Block[], commitment: { start: string; end: string }): Set<string> {
  const startMs = Date.parse(commitment.start);
  const endMs = Date.parse(commitment.end);
  const hit = new Set<string>();
  for (const block of blocks) {
    if (Date.parse(block.start) < endMs && Date.parse(block.end) > startMs) {
      hit.add(block.taskId);
    }
  }
  return hit;
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

const LORD_HOWE_TASKS: Task[] = [
  {
    id: 'T0',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 155, p90Min: 155 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 60,
    priority: 2,
    dependsOn: [],
  },
  {
    id: 'T1',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 165, p90Min: 165 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 60,
    priority: 1,
    dependsOn: ['T0'],
  },
  {
    id: 'T2',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 55, p90Min: 55 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 60,
    priority: 2,
    dependsOn: [],
  },
  {
    id: 'T3',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 40, p90Min: 40 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 40,
    priority: 2,
    dependsOn: [],
  },
  {
    id: 'T4',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 40, p90Min: 40 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 90,
    priority: 4,
    dependsOn: [],
  },
  {
    id: 'T5',
    dueAt: '2026-11-12T00:00:00Z',
    earliestStartAt: '2026-11-09T00:00:00Z',
    estimate: { p50Min: 55, p90Min: 55 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 55,
    priority: 4,
    dependsOn: [],
  },
];

function lordHoweInput(): ScheduleInput {
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'Australia/Lord_Howe',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-12T00:00:00Z',
    },
    tasks: LORD_HOWE_TASKS,
    availability: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '08:00',
      endLocal: '18:00',
      kind: 'work',
    })),
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 180,
      breakAfterMin: 240,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 5037,
  };
}

interface DependencyChangeFixture {
  timeZone: string;
  horizonStart: string;
  horizonEnd: string;
  window: [string, string];
  durations: number[];
}

const BERLIN_DEPENDENCY_CHANGE: DependencyChangeFixture = {
  timeZone: 'Europe/Berlin',
  horizonStart: '2026-10-25T00:00:00Z',
  horizonEnd: '2026-10-27T00:00:00Z',
  window: ['00:00', '24:00'],
  durations: [30, 35],
};

const SEOUL_DEPENDENCY_CHANGE: DependencyChangeFixture = {
  timeZone: 'Asia/Seoul',
  horizonStart: '2026-11-09T00:00:00Z',
  horizonEnd: '2026-11-11T00:00:00Z',
  window: ['08:00', '18:00'],
  durations: [30, 35, 35],
};

function dependencyChangeInput(
  fixture: DependencyChangeFixture,
  dependency = false,
): ScheduleInput {
  const tasks: Task[] = fixture.durations.map((durationMin, index) => ({
    id: `T${index}`,
    dueAt: fixture.horizonEnd,
    earliestStartAt: fixture.horizonStart,
    estimate: { p50Min: durationMin, p90Min: durationMin },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 60,
    priority: 1,
    dependsOn: dependency && index === 1 ? ['T0'] : [],
  }));
  return {
    now: fixture.horizonStart,
    timeZone: fixture.timeZone,
    horizon: { start: fixture.horizonStart, end: fixture.horizonEnd },
    tasks,
    availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: fixture.window[0],
      endLocal: fixture.window[1],
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

function expectDependencyChangeReplan(fixture: DependencyChangeFixture): void {
  const baseInput = dependencyChangeInput(fixture);
  const [baseCandidate] = generate(baseInput, {
    policies: ['balanced'],
    seed: 0,
  }).candidates;
  expect(baseCandidate?.feasible).toBe(true);
  const existing = baseCandidate?.blocks ?? [];
  expect(existing.length).toBeGreaterThanOrEqual(fixture.durations.length);

  const replanInput: ScheduleInput = {
    ...dependencyChangeInput(fixture, true),
    existingBlocks: existing,
  };
  const [candidate] = generate(replanInput, {
    policies: ['balanced'],
    seed: 0,
  }).candidates;
  expect(candidate).toBeDefined();
  if (candidate === undefined) {
    return;
  }
  expect(candidate.feasible).toBe(true);
  expect(candidate.deficitMin).toBe(0);

  const affectedExisting = existing.filter(
    (block) => block.taskId === 'T0' || block.taskId === 'T1',
  ).length;
  expect(affectedExisting).toBe(2);
  expect(candidate.metrics.changedBlocks).toBe(
    symmetricDifference(existing, candidate.blocks),
  );
  expect(candidate.metrics.changedBlocks).toBeLessThanOrEqual(
    affectedExisting * 2 + 2,
  );

  const t0 = candidate.blocks.filter((block) => block.taskId === 'T0');
  const t1 = candidate.blocks.filter((block) => block.taskId === 'T1');
  expect(t0.length).toBeGreaterThan(0);
  expect(t1.length).toBeGreaterThan(0);
  for (const successor of t1) {
    for (const dependency of t0) {
      expect(Date.parse(successor.start)).toBeGreaterThanOrEqual(
        Date.parse(dependency.end),
      );
    }
  }
}

describe('FU-41 replan change bound and preservation', () => {
  it('releases BOTH endpoints of an added dependency edge (Berlin counterexample)', () => {
    expectDependencyChangeReplan(BERLIN_DEPENDENCY_CHANGE);
  });

  it('restores dependency-change feasibility for the Seoul three-task case (fast-check seed 2035140076)', () => {
    expectDependencyChangeReplan(SEOUL_DEPENDENCY_CHANGE);
  });

  it('preserves unaffected blocks and meets the bound in the Lord_Howe six-task repro (seed 5037, focus_blocked)', () => {
    const base = lordHoweInput();
    const [baseCandidate] = generate(base, {
      policies: ['focus_blocked'],
      seed: 5037,
    }).candidates;
    expect(baseCandidate?.feasible).toBe(true);
    const existing = baseCandidate?.blocks ?? [];
    expect(existing.length).toBeGreaterThanOrEqual(6);

    const commitment = {
      start: '2026-11-09T23:00:00Z',
      end: '2026-11-09T23:15:00Z',
    };
    const hit = hitTasks(existing, commitment);
    expect([...hit].sort()).toEqual(['T0']);
    const affected = affectedTasks(LORD_HOWE_TASKS, hit);
    expect([...affected].sort()).toEqual(['T0', 'T1']);

    const result = generate(
      { ...base, commitments: [commitment], existingBlocks: existing },
      { policies: ['focus_blocked'], seed: 5037 },
    );
    const [candidate] = result.candidates;
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }

    for (const task of LORD_HOWE_TASKS) {
      if (affected.has(task.id)) {
        continue;
      }
      expect(taskKeys(candidate.blocks, task.id)).toEqual(
        taskKeys(existing, task.id),
      );
    }

    const affectedExisting = existing.filter((block) =>
      affected.has(block.taskId),
    ).length;
    expect(symmetricDifference(existing, candidate.blocks)).toBe(
      candidate.metrics.changedBlocks,
    );
    expect(candidate.metrics.changedBlocks).toBeLessThanOrEqual(
      affectedExisting * 2 + 2,
    );
  });

  it('flags a candidate that cannot meet the change bound instead of silently exceeding it', () => {
    const input = lordHoweInput();
    const tasks: Task[] = [
      ...LORD_HOWE_TASKS,
      {
        id: 'T6',
        dueAt: '2026-11-12T00:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
        estimate: { p50Min: 150, p90Min: 150 },
        splittable: true,
        minSessionMin: 30,
        maxSessionMin: 30,
        priority: 1,
        dependsOn: [],
      },
    ];
    const result = generate(
      {
        ...input,
        tasks,
        existingBlocks: [
          {
            taskId: 'T6',
            start: '2026-11-09T00:00:00Z',
            end: '2026-11-09T02:00:00Z',
          },
        ],
      },
      { policies: ['front_loaded'], seed: 5037 },
    );
    const [candidate] = result.candidates;
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }
    expect(candidate.metrics.changedBlocks).toBeGreaterThan(4);
    expect(
      candidate.explanation.some((line) =>
        line.startsWith('Replan change bound exceeded:'),
      ),
    ).toBe(true);
    expect(result.diversityNote).toContain('Replan change bound exceeded:');
  });

  it('preserves unaffected blocks even when the affected remainder is infeasible', () => {
    const base = lordHoweInput();
    const [baseCandidate] = generate(base, {
      policies: ['focus_blocked'],
      seed: 5037,
    }).candidates;
    const existing = baseCandidate?.blocks ?? [];
    const commitment = {
      start: '2026-11-09T23:00:00Z',
      end: '2026-11-09T23:15:00Z',
    };
    const hit = hitTasks(existing, commitment);
    const affected = affectedTasks(LORD_HOWE_TASKS, hit);
    const result = generate(
      { ...base, commitments: [commitment], existingBlocks: existing },
      { policies: ['focus_blocked'], seed: 5037 },
    );
    const [candidate] = result.candidates;
    if (candidate === undefined) {
      return;
    }
    for (const task of LORD_HOWE_TASKS) {
      if (affected.has(task.id)) {
        continue;
      }
      expect(taskKeys(candidate.blocks, task.id)).toEqual(
        taskKeys(existing, task.id),
      );
    }
    if (!candidate.feasible) {
      expect(
        candidate.explanation.some((line) => line.includes('H7')),
      ).toBe(true);
    }
  });

  it('returns an explained infeasible candidate unconditionally when frozen blocks leave no room', () => {
    const existing: Block[] = [
      { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T11:00:00Z' },
      { taskId: 'P', start: '2026-11-09T10:30:00Z', end: '2026-11-09T11:00:00Z' },
      { taskId: 'B', start: '2026-11-09T11:30:00Z', end: '2026-11-09T12:00:00Z' },
    ];
    const tasks: Task[] = [
      {
        id: 'P',
        dueAt: '2026-11-09T12:00:00Z',
        earliestStartAt: '2026-11-09T09:00:00Z',
        estimate: { p50Min: 30, p90Min: 30 },
        splittable: true,
        minSessionMin: 30,
        maxSessionMin: 30,
        priority: 1,
        dependsOn: [],
      },
      {
        id: 'A',
        dueAt: '2026-11-09T12:00:00Z',
        earliestStartAt: '2026-11-09T09:00:00Z',
        estimate: { p50Min: 120, p90Min: 120 },
        splittable: false,
        minSessionMin: 120,
        maxSessionMin: 120,
        priority: 1,
        dependsOn: ['P'],
      },
      {
        id: 'B',
        dueAt: '2026-11-09T12:00:00Z',
        earliestStartAt: '2026-11-09T09:00:00Z',
        estimate: { p50Min: 30, p90Min: 30 },
        splittable: true,
        minSessionMin: 30,
        maxSessionMin: 30,
        priority: 2,
        dependsOn: [],
      },
    ];
    const input: ScheduleInput = {
      now: '2026-11-09T09:00:00Z',
      timeZone: 'UTC',
      horizon: {
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T12:00:00Z',
      },
      tasks,
      availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday: weekday as Weekday,
        startLocal: '09:00',
        endLocal: '12:00',
        kind: 'work',
      })),
      exceptions: [],
      commitments: [
        { start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:30:00Z' },
      ],
      lockedBlocks: [],
      existingBlocks: existing,
      prefs: {
        maxDailyFocusMin: 480,
        breakAfterMin: 480,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
      seed: 41,
    };
    const [candidate] = generate(input, {
      policies: ['balanced'],
      seed: 41,
    }).candidates;
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }
    expect(candidate.feasible).toBe(false);
    expect(candidate.deficitMin).toBeGreaterThan(0);
    expect(
      candidate.explanation.some((line) => line.includes('H7')),
    ).toBe(true);
    expect(taskKeys(candidate.blocks, 'B')).toEqual(
      taskKeys(existing, 'B'),
    );
  });
});

interface ReplanSpec {
  timeZone: string;
  window: [string, string];
  tasks: Array<{
    durationUnits: number;
    maxUnits: number;
    priority: number;
    dependency: boolean;
  }>;
  policy: 'front_loaded' | 'balanced' | 'focus_blocked';
  seed: number;
  blockIndex: number;
  offsetUnits: number;
  commitmentUnits: number;
}

const ODD_OFFSET_ZONES = [
  'Asia/Kathmandu',
  'Australia/Lord_Howe',
  'Australia/Chatham',
  'Pacific/Marquesas',
  'America/St_Johns',
  'Asia/Kolkata',
] as const;

const WINDOWS: Array<[string, string]> = [
  ['00:00', '24:00'],
  ['08:00', '18:00'],
  ['09:00', '17:00'],
];

const replanSpec = fc.record({
  timeZone: fc.constantFrom(...ODD_OFFSET_ZONES),
  window: fc.constantFrom(...WINDOWS),
  tasks: fc.array(
    fc.record({
      durationUnits: fc.integer({ min: 6, max: 18 }),
      maxUnits: fc.constantFrom(12, 18, 24, 36),
      priority: fc.integer({ min: 1, max: 4 }),
      dependency: fc.boolean(),
    }),
    { minLength: 2, maxLength: 5 },
  ),
  policy: fc.constantFrom<'front_loaded' | 'balanced' | 'focus_blocked'>(
    'front_loaded',
    'balanced',
    'focus_blocked',
  ),
  seed: fc.integer({ min: 0, max: 100000 }),
  blockIndex: fc.integer({ min: 0, max: 99 }),
  offsetUnits: fc.integer({ min: 0, max: 10 }),
  commitmentUnits: fc.constantFrom(3, 6, 9, 12),
});

function replanInput(spec: ReplanSpec): ScheduleInput {
  const availability: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
    (weekday) => ({
      weekday: weekday as Weekday,
      startLocal: spec.window[0],
      endLocal: spec.window[1],
      kind: 'work',
    }),
  );
  const tasks: Task[] = spec.tasks.map((entry, index) => {
    const durationMin = entry.durationUnits * 5;
    return {
      id: `T${index}`,
      dueAt: '2026-11-12T00:00:00Z',
      earliestStartAt: '2026-11-09T00:00:00Z',
      estimate: { p50Min: durationMin, p90Min: durationMin },
      splittable: true,
      minSessionMin: Math.min(30, durationMin),
      maxSessionMin: Math.max(entry.durationUnits, entry.maxUnits) * 5,
      priority: entry.priority as 1 | 2 | 3 | 4,
      dependsOn:
        entry.dependency && index > 0 ? [`T${index - 1}`] : [],
    };
  });
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: spec.timeZone,
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-12T00:00:00Z',
    },
    tasks,
    availability,
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
    seed: spec.seed,
  };
}

describe('FU-41 replan preservation property', () => {
  it('preserves unaffected blocks and the change bound over random commitment conflicts in odd-offset zones', () => {
    let comparisons = 0;
    fc.assert(
      fc.property(replanSpec, (spec) => {
        const base = replanInput(spec);
        const [baseCandidate] = generate(base, {
          policies: [spec.policy],
          seed: spec.seed,
        }).candidates;
        if (
          baseCandidate === undefined ||
          !baseCandidate.feasible ||
          baseCandidate.blocks.length === 0
        ) {
          fc.pre(false);
          return;
        }
        const existing = baseCandidate.blocks;
        const pivot =
          existing[spec.blockIndex % existing.length];
        if (pivot === undefined) {
          fc.pre(false);
          return;
        }
        const pivotStart = Date.parse(pivot.start);
        const pivotEnd = Date.parse(pivot.end);
        const maxOffsetUnits = Math.max(
          0,
          Math.floor((pivotEnd - pivotStart) / MINUTE_MS / 5),
        );
        const offsetUnits = Math.min(
          spec.offsetUnits,
          Math.max(0, maxOffsetUnits - 1),
        );
        const commitmentStartMs = pivotStart + offsetUnits * 5 * MINUTE_MS;
        const commitmentEndMs = Math.min(
          commitmentStartMs + spec.commitmentUnits * 5 * MINUTE_MS,
          Date.parse(base.horizon.end),
        );
        const commitment = {
          start: new Date(commitmentStartMs).toISOString(),
          end: new Date(commitmentEndMs).toISOString(),
        };
        const hit = hitTasks(existing, commitment);
        if (hit.size === 0) {
          fc.pre(false);
          return;
        }
        const triggerAffected = affectedTasks(base.tasks, hit);
        const affected = expandedScope(base.tasks, triggerAffected);
        const affectedExisting = existing.filter((block) =>
          affected.has(block.taskId),
        ).length;

        comparisons += 1;
        const result = generate(
          { ...base, commitments: [commitment], existingBlocks: existing },
          { policies: [spec.policy], seed: spec.seed },
        );
        const [candidate] = result.candidates;
        expect(candidate).toBeDefined();
        if (candidate === undefined) {
          return;
        }

        for (const task of base.tasks) {
          if (affected.has(task.id)) {
            continue;
          }
          expect(taskKeys(candidate.blocks, task.id)).toEqual(
            taskKeys(existing, task.id),
          );
        }

        expect(symmetricDifference(existing, candidate.blocks)).toBe(
          candidate.metrics.changedBlocks,
        );
        const bound = affectedExisting * 2 + 2;
        expect(candidate.metrics.changedBlocks).toBeLessThanOrEqual(bound);
      }),
      { numRuns: 1600 },
    );
    expect(comparisons).toBeGreaterThanOrEqual(1000);
  }, 180000);
});

interface MultiSessionSpec {
  timeZone: string;
  window: [string, string];
  tasks: Array<{
    durationUnits: number;
    maxUnits: number;
    priority: number;
    dependency: boolean;
  }>;
  policy: 'front_loaded' | 'balanced' | 'focus_blocked';
  seed: number;
  blockIndex: number;
  offsetUnits: number;
  commitmentUnits: number;
}

const multiSessionSpecArb = fc.record({
  timeZone: fc.constantFrom(...ODD_OFFSET_ZONES),
  window: fc.constantFrom(...WINDOWS),
  tasks: fc.array(
    fc.record({
      durationUnits: fc.integer({ min: 12, max: 18 }),
      maxUnits: fc.constantFrom(6, 9),
      priority: fc.integer({ min: 1, max: 4 }),
      dependency: fc.boolean(),
    }),
    { minLength: 2, maxLength: 4 },
  ),
  policy: fc.constantFrom<'front_loaded' | 'balanced' | 'focus_blocked'>(
    'front_loaded',
    'balanced',
    'focus_blocked',
  ),
  seed: fc.integer({ min: 0, max: 100000 }),
  blockIndex: fc.integer({ min: 0, max: 99 }),
  offsetUnits: fc.integer({ min: 0, max: 10 }),
  commitmentUnits: fc.constantFrom(3, 6, 9, 12),
});

function multiSessionInput(spec: MultiSessionSpec): ScheduleInput {
  const tasks: Task[] = spec.tasks.map((entry, index) => {
    const durationMin = entry.durationUnits * 5;
    const maxSessionMin = entry.maxUnits * 5;
    return {
      id: `T${index}`,
      dueAt: '2026-11-12T00:00:00Z',
      earliestStartAt: '2026-11-09T00:00:00Z',
      estimate: { p50Min: durationMin, p90Min: durationMin },
      splittable: true,
      minSessionMin: 30,
      maxSessionMin,
      priority: entry.priority as 1 | 2 | 3 | 4,
      dependsOn:
        entry.dependency && index > 0 ? [`T${index - 1}`] : [],
    };
  });
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: spec.timeZone,
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-12T00:00:00Z',
    },
    tasks,
    availability: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      weekday: weekday as Weekday,
      startLocal: spec.window[0],
      endLocal: spec.window[1],
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
    seed: spec.seed,
  };
}

describe('FU-41 forced multi-session replans', () => {
  it('preserves unaffected blocks and the bound when every task needs several sessions', () => {
    let comparisons = 0;
    fc.assert(
      fc.property(multiSessionSpecArb, (spec) => {
        const base = multiSessionInput(spec);
        const [baseCandidate] = generate(base, {
          policies: [spec.policy],
          seed: spec.seed,
        }).candidates;
        if (
          baseCandidate === undefined ||
          !baseCandidate.feasible ||
          baseCandidate.blocks.length < base.tasks.length * 2
        ) {
          fc.pre(false);
          return;
        }
        const existing = baseCandidate.blocks;
        const pivot = existing[spec.blockIndex % existing.length];
        if (pivot === undefined) {
          fc.pre(false);
          return;
        }
        const pivotStart = Date.parse(pivot.start);
        const pivotEnd = Date.parse(pivot.end);
        const maxOffsetUnits = Math.max(
          0,
          Math.floor((pivotEnd - pivotStart) / MINUTE_MS / 5),
        );
        const offsetUnits = Math.min(
          spec.offsetUnits,
          Math.max(0, maxOffsetUnits - 1),
        );
        const commitmentStartMs = pivotStart + offsetUnits * 5 * MINUTE_MS;
        const commitmentEndMs = Math.min(
          commitmentStartMs + spec.commitmentUnits * 5 * MINUTE_MS,
          Date.parse(base.horizon.end),
        );
        const commitment = {
          start: new Date(commitmentStartMs).toISOString(),
          end: new Date(commitmentEndMs).toISOString(),
        };
        const hit = hitTasks(existing, commitment);
        if (hit.size === 0) {
          fc.pre(false);
          return;
        }
        const triggerAffected = affectedTasks(base.tasks, hit);
        const affected = expandedScope(base.tasks, triggerAffected);
        const affectedExisting = existing.filter((block) =>
          affected.has(block.taskId),
        ).length;

        comparisons += 1;
        const result = generate(
          { ...base, commitments: [commitment], existingBlocks: existing },
          { policies: [spec.policy], seed: spec.seed },
        );
        const [candidate] = result.candidates;
        expect(candidate).toBeDefined();
        if (candidate === undefined) {
          return;
        }

        for (const task of base.tasks) {
          if (affected.has(task.id)) {
            continue;
          }
          expect(taskKeys(candidate.blocks, task.id)).toEqual(
            taskKeys(existing, task.id),
          );
        }

        expect(symmetricDifference(existing, candidate.blocks)).toBe(
          candidate.metrics.changedBlocks,
        );
        expect(candidate.metrics.changedBlocks).toBeLessThanOrEqual(
          affectedExisting * 2 + 2,
        );
      }),
      { numRuns: 600 },
    );
    expect(comparisons).toBeGreaterThanOrEqual(300);
  }, 180000);
});
