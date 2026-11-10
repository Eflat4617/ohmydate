import fc from 'fast-check';
import type {
  AvailabilityRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate } from '../src/index.js';

interface Scenario {
  timeZone: string;
  start: string;
  end: string;
}

const SCENARIOS: Scenario[] = [
  {
    timeZone: 'Asia/Seoul',
    start: '2026-11-09T00:00:00Z',
    end: '2026-11-11T00:00:00Z',
  },
  {
    timeZone: 'America/New_York',
    start: '2026-11-01T04:00:00Z',
    end: '2026-11-03T00:00:00Z',
  },
  {
    timeZone: 'Europe/Berlin',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-27T00:00:00Z',
  },
];

const WINDOWS: Array<[string, string]> = [
  ['00:00', '24:00'],
  ['08:00', '18:00'],
  ['09:00', '17:00'],
];

function configuredRuns(): number {
  const raw = process.env.SCHED_PROPERTY_RUNS;
  if (raw === undefined) {
    return 200;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 200;
}

const NUM_RUNS = Math.min(configuredRuns(), 400);

const baseTaskSpec = fc.record({
  durationUnits: fc.integer({ min: 6, max: 24 }),
  maxUnits: fc.constantFrom(12, 18, 24, 36),
  priority: fc.integer({ min: 1, max: 4 }),
});

const spec = fc.record({
  scenario: fc.constantFrom(...SCENARIOS),
  window: fc.constantFrom(...WINDOWS),
  windowKind: fc.constantFrom<'all' | 'weekdays'>('all', 'weekdays'),
  tasks: fc.array(baseTaskSpec, { minLength: 1, maxLength: 3 }),
  mutation: fc.constantFrom<'grow' | 'dependency' | 'none'>(
    'grow',
    'dependency',
    'none',
  ),
  mutationIndex: fc.integer({ min: 0, max: 29 }),
  dependencyIndex: fc.integer({ min: 0, max: 29 }),
  growUnits: fc.constantFrom(6, 12),
  policy: fc.constantFrom<'front_loaded' | 'balanced' | 'focus_blocked'>(
    'front_loaded',
    'balanced',
    'focus_blocked',
  ),
  seed: fc.integer({ min: 0, max: 100000 }),
});

type Spec = {
  scenario: Scenario;
  window: [string, string];
  windowKind: 'all' | 'weekdays';
  tasks: Array<{ durationUnits: number; maxUnits: number; priority: number }>;
  mutation: 'grow' | 'dependency' | 'none';
  mutationIndex: number;
  dependencyIndex: number;
  growUnits: number;
  policy: 'front_loaded' | 'balanced' | 'focus_blocked';
  seed: number;
};

function buildInput(
  specValue: Spec,
  existingBlocks: ScheduleInput['existingBlocks'] = undefined,
): ScheduleInput {
  const weekdays =
    specValue.windowKind === 'all' ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  const availability: AvailabilityRule[] = weekdays.map((weekday) => ({
    weekday: weekday as Weekday,
    startLocal: specValue.window[0],
    endLocal: specValue.window[1],
    kind: 'work',
  }));
  const tasks: Task[] = specValue.tasks.map((entry, index) => {
    const durationMin = entry.durationUnits * 5;
    const maxSessionMin = Math.max(entry.durationUnits, entry.maxUnits) * 5;
    const minSessionMin = Math.min(30, durationMin);
    return {
      id: `T${index}`,
      dueAt: specValue.scenario.end,
      earliestStartAt: specValue.scenario.start,
      estimate: { p50Min: durationMin, p90Min: durationMin },
      splittable: true,
      minSessionMin,
      maxSessionMin,
      priority: entry.priority as 1 | 2 | 3 | 4,
      dependsOn: [],
    };
  });
  return {
    now: specValue.scenario.start,
    timeZone: specValue.scenario.timeZone,
    horizon: {
      start: specValue.scenario.start,
      end: specValue.scenario.end,
    },
    tasks,
    availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    ...(existingBlocks === undefined ? {} : { existingBlocks }),
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: specValue.seed,
  };
}

function mutate(input: ScheduleInput, specValue: Spec): ScheduleInput {
  const tasks = input.tasks.map((task) => ({
    ...task,
    estimate: { ...task.estimate },
    dependsOn: [...task.dependsOn],
  }));
  if (specValue.mutation === 'grow') {
    const index = specValue.mutationIndex % tasks.length;
    const task = tasks[index];
    if (task !== undefined) {
      const grow = specValue.growUnits * 5;
      task.estimate.p50Min += grow;
      task.estimate.p90Min += grow;
    }
  } else if (specValue.mutation === 'dependency' && tasks.length > 1) {
    const index = 1 + (specValue.mutationIndex % (tasks.length - 1));
    const dependencyIndex = specValue.dependencyIndex % index;
    const task = tasks[index];
    const dependency = tasks[dependencyIndex];
    if (task !== undefined && dependency !== undefined) {
      if (!task.dependsOn.includes(dependency.id)) {
        task.dependsOn.push(dependency.id);
      }
    }
  }
  return { ...input, tasks };
}

describe('replan feasibility property', () => {
  it('a replan is feasible whenever the same policy is feasible without existingBlocks', () => {
    let comparisons = 0;
    fc.assert(
      fc.property(spec, (specValue) => {
        const baseInput = buildInput(specValue);
        const base = generate(baseInput, {
          policies: [specValue.policy],
          seed: specValue.seed,
        });
        const baseCandidate = base.candidates[0];
        if (baseCandidate === undefined || !baseCandidate.feasible) {
          fc.pre(false);
          return;
        }

        const mutated = mutate(baseInput, specValue);
        const fresh = generate(mutated, {
          policies: [specValue.policy],
          seed: specValue.seed,
        });
        if (fresh.candidates[0]?.feasible !== true) {
          fc.pre(false);
          return;
        }

        comparisons += 1;
        const replanInput: ScheduleInput = {
          ...mutated,
          existingBlocks: baseCandidate.blocks,
        };
        const replan = generate(replanInput, {
          policies: [specValue.policy],
          seed: specValue.seed,
        });
        expect(replan.candidates[0]?.feasible).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
    expect(comparisons).toBeGreaterThan(20);
  }, 180000);
});
