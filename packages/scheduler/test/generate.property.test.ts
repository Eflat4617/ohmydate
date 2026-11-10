import fc from 'fast-check';
import type {
  AvailabilityRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate, validate } from '../src/index.js';
import { dailyLoadsByMinute } from './minuteOracle.js';

interface Scenario {
  timeZone: string;
  start: string;
  end: string;
}

const SCENARIOS: Scenario[] = [
  {
    timeZone: 'Asia/Seoul',
    start: '2026-11-09T00:00:00Z',
    end: '2026-11-10T00:00:00Z',
  },
  {
    timeZone: 'America/New_York',
    start: '2026-11-01T04:00:00Z',
    end: '2026-11-02T00:00:00Z',
  },
  {
    timeZone: 'Europe/Berlin',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-26T00:00:00Z',
  },
  {
    timeZone: 'America/St_Johns',
    start: '2026-11-01T00:00:00Z',
    end: '2026-11-02T00:00:00Z',
  },
  {
    timeZone: 'Australia/Lord_Howe',
    start: '2026-04-04T13:00:00Z',
    end: '2026-04-05T13:00:00Z',
  },
  {
    timeZone: 'America/Santiago',
    start: '2026-09-06T04:00:00Z',
    end: '2026-09-07T04:00:00Z',
  },
];

const WINDOWS: Array<[string, string]> = [
  ['00:00', '24:00'],
  ['08:00', '18:00'],
  ['01:00', '04:00'],
  ['09:00', '12:00'],
];

function configuredRuns(): number {
  const raw = process.env.SCHED_PROPERTY_RUNS;
  if (raw === undefined) {
    return 300;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 300;
}

const NUM_RUNS = configuredRuns();

interface TaskSpec {
  durationUnits: number;
  minUnits: number;
  maxUnits: number;
  splittable: boolean;
  priority: number;
}

const taskSpec = fc.record({
  durationUnits: fc.integer({ min: 6, max: 24 }),
  minUnits: fc.constantFrom(3, 6, 12),
  maxUnits: fc.constantFrom(12, 18, 24),
  splittable: fc.boolean(),
  priority: fc.integer({ min: 1, max: 4 }),
});

const rawSpec = fc.record({
  scenario: fc.constantFrom(...SCENARIOS),
  window: fc.constantFrom(...WINDOWS),
  tasks: fc.array(taskSpec, { maxLength: 2 }),
  maxDailyFocusMin: fc.constantFrom(120, 240, 480),
  seed: fc.integer({ min: 0, max: 100000 }),
});

function buildInput(spec: {
  scenario: Scenario;
  window: [string, string];
  tasks: TaskSpec[];
  maxDailyFocusMin: number;
  seed: number;
}): ScheduleInput {
  const availability: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
    (weekday) => ({
      weekday: weekday as Weekday,
      startLocal: spec.window[0],
      endLocal: spec.window[1],
      kind: 'work' as const,
    }),
  );
  const tasks: Task[] = spec.tasks.map((entry, index) => {
    const maxUnits = Math.max(entry.minUnits, entry.maxUnits);
    const minUnits = Math.min(entry.minUnits, maxUnits);
    const durationUnits = Math.max(
      minUnits,
      Math.min(maxUnits, entry.durationUnits),
    );
    return {
      id: `T${index}`,
      dueAt: spec.scenario.end,
      earliestStartAt: spec.scenario.start,
      estimate: {
        p50Min: durationUnits * 5,
        p90Min: durationUnits * 5,
      },
      splittable: entry.splittable,
      minSessionMin: entry.splittable ? minUnits * 5 : durationUnits * 5,
      maxSessionMin: entry.splittable ? maxUnits * 5 : durationUnits * 5,
      priority: entry.priority as 1 | 2 | 3 | 4,
      dependsOn: [],
    };
  });

  return {
    now: spec.scenario.start,
    timeZone: spec.scenario.timeZone,
    horizon: { start: spec.scenario.start, end: spec.scenario.end },
    tasks,
    availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: spec.maxDailyFocusMin,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: spec.seed,
  };
}

describe('generator properties', () => {
  it('every feasible candidate validates and at most three candidates return', () => {
    fc.assert(
      fc.property(rawSpec, (spec) => {
        const input = buildInput(spec);
        const result = generate(input, {
          policies: ['front_loaded', 'balanced', 'focus_blocked'],
          seed: spec.seed,
        });

        expect(result.candidates.length).toBeLessThanOrEqual(3);
        for (const candidate of result.candidates) {
          if (!candidate.feasible) {
            expect(candidate.explanation.length).toBeGreaterThan(0);
            continue;
          }
          expect(
            validate(input, candidate.blocks, {
              riskLevel: input.prefs.riskLevel,
            }),
          ).toEqual([]);
          expect(candidate.deficitMin).toBe(0);

          const loads = dailyLoadsByMinute(
            [...input.lockedBlocks, ...candidate.blocks],
            input.timeZone,
          );
          const maxLoad = Math.max(0, ...loads.values());
          expect(candidate.metrics.maxDailyLoadMin).toBe(maxLoad);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120000);
});
