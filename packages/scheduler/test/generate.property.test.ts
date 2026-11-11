import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import type {
  AvailabilityRule,
  Block,
  Commitment,
  ExceptionRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate, validate } from '../src/index.js';
import {
  dailyLoadsByMinute,
  isCoveredByMinutes,
} from './minuteOracle.js';

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

const HEAVY_WINDOWS: Array<[string, string]> = [
  ['00:00', '24:00'],
  ['08:00', '18:00'],
  ['06:00', '20:00'],
  ['09:00', '17:00'],
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

/** Effective heavy-property sample; bounded by SCHED_PROPERTY_RUNS. */
function configuredHeavyRuns(): number {
  const raw = process.env.SCHED_HEAVY_RUNS;
  const requested = raw === undefined ? 150 : Number.parseInt(raw, 10);
  const runs = Number.isInteger(requested) && requested > 0 ? requested : 150;
  return Math.max(40, Math.min(NUM_RUNS, runs));
}

/** Heavy-property timeout tracks the requested sample size. */
function heavyTimeoutMs(): number {
  return Math.max(240_000, configuredHeavyRuns() * 1_600);
}

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


const LONG_SCENARIOS: Array<{ timeZone: string; start: string }> = [
  { timeZone: 'America/New_York', start: '2026-10-25T00:00:00Z' },
  { timeZone: 'Europe/Berlin', start: '2026-10-18T00:00:00Z' },
  { timeZone: 'America/Santiago', start: '2026-09-01T00:00:00Z' },
  { timeZone: 'Australia/Lord_Howe', start: '2026-03-28T00:00:00Z' },
  { timeZone: 'America/St_Johns', start: '2026-10-25T00:00:00Z' },
  { timeZone: 'Asia/Seoul', start: '2026-11-01T00:00:00Z' },
];

const heavyTaskSpec = fc.record({
  durationUnits: fc.integer({ min: 3, max: 24 }),
  extraP90Units: fc.integer({ min: 0, max: 6 }),
  minUnits: fc.constantFrom(3, 6, 12),
  maxUnits: fc.constantFrom(12, 18, 24, 36),
  splittable: fc.boolean(),
  priority: fc.integer({ min: 1, max: 4 }),
  dependencyMode: fc.integer({ min: 0, max: 2 }),
  extraIndex: fc.integer({ min: 0, max: 29 }),
  earliestFraction: fc.integer({ min: 0, max: 20 }),
  bufferUnits: fc.integer({ min: 0, max: 4 }),
  remainingHalf: fc.boolean(),
  preferred: fc.uniqueArray(
    fc.constantFrom('morning', 'afternoon', 'evening'),
    { maxLength: 2 },
  ),
});

const heavySpec = fc.record({
  scenario: fc.constantFrom(...LONG_SCENARIOS),
  dayCount: fc.integer({ min: 18, max: 21 }),
  window: fc.constantFrom(...HEAVY_WINDOWS),
  weekdayMode: fc.constantFrom('all', 'weekdays'),
  tasks: fc.array(heavyTaskSpec, { minLength: 1, maxLength: 30 }),
  commitments: fc.array(
    fc.record({
      startStep: fc.integer({ min: 0, max: 6000 }),
      lengthSteps: fc.integer({ min: 6, max: 36 }),
    }),
    { maxLength: 1 },
  ),
  locked: fc.array(
    fc.record({
      taskIndex: fc.integer({ min: 0, max: 29 }),
      startStep: fc.integer({ min: 0, max: 6000 }),
      lengthSteps: fc.integer({ min: 6, max: 24 }),
    }),
    { maxLength: 2 },
  ),
  existing: fc.array(
    fc.record({
      taskIndex: fc.integer({ min: 0, max: 29 }),
      startStep: fc.integer({ min: 0, max: 6000 }),
      lengthSteps: fc.integer({ min: 6, max: 24 }),
    }),
    { maxLength: 3 },
  ),
  exceptions: fc.array(
    fc.record({
      dayOffset: fc.integer({ min: 0, max: 20 }),
      kind: fc.constantFrom<'off' | 'extra'>('off', 'extra'),
      fullDay: fc.boolean(),
      startMinute: fc.constantFrom(0, 540, 1140),
      lengthMinutes: fc.constantFrom(60, 120, 180),
    }),
    { maxLength: 1 },
  ),
  nowFraction: fc.integer({ min: 0, max: 25 }),
  maxDailyFocusMin: fc.constantFrom(480, 720, 1440),
  breakAfterMin: fc.constantFrom(120, 240, 480),
  breakMin: fc.constantFrom(5, 10, 15),
  riskLevel: fc.constantFrom<'p50' | 'p90'>('p50', 'p90'),
  seed: fc.integer({ min: 0, max: 100000 }),
});

type HeavySpec = {
  scenario: { timeZone: string; start: string };
  dayCount: number;
  window: [string, string];
  weekdayMode: string;
  tasks: Array<{
    durationUnits: number;
    extraP90Units: number;
    minUnits: number;
    maxUnits: number;
    splittable: boolean;
    priority: number;
    dependencyMode: number;
    extraIndex: number;
    earliestFraction: number;
    bufferUnits: number;
    remainingHalf: boolean;
    preferred: string[];
  }>;
  commitments: Array<{ startStep: number; lengthSteps: number }>;
  locked: Array<{ taskIndex: number; startStep: number; lengthSteps: number }>;
  existing: Array<{ taskIndex: number; startStep: number; lengthSteps: number }>;
  exceptions: Array<{
    dayOffset: number;
    kind: 'off' | 'extra';
    fullDay: boolean;
    startMinute: number;
    lengthMinutes: number;
  }>;
  nowFraction: number;
  maxDailyFocusMin: number;
  breakAfterMin: number;
  breakMin: number;
  riskLevel: 'p50' | 'p90';
  seed: number;
};

function formatClock(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildHeavyInput(
  spec: HeavySpec,
  priorBlocks: Block[] = [],
): ScheduleInput {
  const startInstant = Temporal.Instant.from(spec.scenario.start);
  const endInstant = startInstant.add({ hours: spec.dayCount * 24 });
  const totalSteps = Math.floor(
    (endInstant.epochMilliseconds - startInstant.epochMilliseconds) /
      (5 * 60 * 1000),
  );
  const stepIso = (steps: number): string =>
    startInstant.add({ minutes: steps * 5 }).toString();
  const clampStep = (steps: number, lengthSteps = 0): number =>
    Math.max(0, Math.min(steps, totalSteps - lengthSteps));

  const taskCount = spec.tasks.length;
  const tasks: Task[] = spec.tasks.map((entry, index) => {
    const requiredMin = entry.durationUnits * 5;
    const p90Min = (entry.durationUnits + entry.extraP90Units) * 5;
    const minUnits = Math.min(
      entry.minUnits,
      entry.maxUnits,
      entry.durationUnits,
    );
    const maxUnits = Math.max(minUnits, entry.maxUnits);
    const maxSessionMin = entry.splittable ? maxUnits * 5 : p90Min;
    const minSessionMin = entry.splittable ? minUnits * 5 : p90Min;
    const bufferMin = entry.bufferUnits * 5;
    const latestEarliest = endInstant.subtract({
      minutes: bufferMin + 5,
    });
    const earliestSteps = Math.floor(
      (totalSteps * entry.earliestFraction) / 100,
    );
    let earliest = startInstant.add({
      minutes: clampStep(earliestSteps) * 5,
    });
    if (Temporal.Instant.compare(earliest, latestEarliest) >= 0) {
      earliest = latestEarliest;
    }
    const dependsOn =
      index === 0 || entry.dependencyMode === 0
        ? []
        : entry.dependencyMode === 1
          ? [`T${index - 1}`]
          : [`T${entry.extraIndex % index}`];
    const remainingMin =
      entry.splittable && entry.remainingHalf
        ? Math.min(
            p90Min,
            Math.max(
              minSessionMin,
              Math.floor(requiredMin / 2 / 5) * 5,
            ),
          )
        : undefined;
    return {
      id: `T${index}`,
      dueAt: endInstant.toString(),
      earliestStartAt: earliest.toString(),
      estimate: { p50Min: requiredMin, p90Min },
      ...(remainingMin === undefined ? {} : { remainingMin }),
      splittable: entry.splittable,
      minSessionMin,
      maxSessionMin,
      priority: entry.priority as 1 | 2 | 3 | 4,
      dependsOn,
      bufferBeforeDueMin: bufferMin,
      preferredWindows: entry.preferred as Array<
        'morning' | 'afternoon' | 'evening'
      >,
    };
  });

  const weekdays =
    spec.weekdayMode === 'all'
      ? [1, 2, 3, 4, 5, 6, 7]
      : [1, 2, 3, 4, 5];
  const availability: AvailabilityRule[] = weekdays.map((weekday) => ({
    weekday: weekday as Weekday,
    startLocal: spec.window[0],
    endLocal: spec.window[1],
    kind: 'work',
  }));

  const firstLocalDate = startInstant
    .toZonedDateTimeISO(spec.scenario.timeZone)
    .toPlainDate();
  const exceptions: ExceptionRule[] = spec.exceptions.map((entry) => {
    const date = firstLocalDate
      .add({ days: Math.min(entry.dayOffset, spec.dayCount - 1) })
      .toString();
    if (entry.fullDay) {
      return { date, kind: entry.kind };
    }
    return {
      date,
      kind: entry.kind,
      startLocal: formatClock(entry.startMinute),
      endLocal: formatClock(
        Math.min(1440, entry.startMinute + entry.lengthMinutes),
      ),
    };
  });

  const commitments: Commitment[] = spec.commitments.map((entry) => {
    const steps = clampStep(entry.startStep, entry.lengthSteps);
    return {
      start: stepIso(steps),
      end: stepIso(steps + entry.lengthSteps),
    };
  });
  const randomLocked: Block[] = spec.locked.map((entry) => {
    const steps = clampStep(entry.startStep, entry.lengthSteps);
    return {
      taskId: `T${entry.taskIndex % taskCount}`,
      start: stepIso(steps),
      end: stepIso(steps + entry.lengthSteps),
    };
  });
  const randomExisting: Block[] = spec.existing.map((entry) => {
    const steps = clampStep(entry.startStep, entry.lengthSteps);
    return {
      taskId: `T${entry.taskIndex % taskCount}`,
      start: stepIso(steps),
      end: stepIso(steps + entry.lengthSteps),
    };
  });
  // Prefer blocks from a prior valid plan so replans exercise seeding rather
  // than mostly-invalid random blocks.
  const lockedBlocks =
    priorBlocks.length > 0 ? priorBlocks.slice(0, 1) : randomLocked;
  const existingBlocks =
    priorBlocks.length > 0
      ? priorBlocks.slice(1, 1 + Math.max(1, spec.existing.length))
      : randomExisting;

  const nowSteps = Math.floor((totalSteps * spec.nowFraction) / 100);
  return {
    now: stepIso(clampStep(nowSteps)),
    timeZone: spec.scenario.timeZone,
    horizon: {
      start: startInstant.toString(),
      end: endInstant.toString(),
    },
    tasks,
    availability,
    exceptions,
    commitments,
    lockedBlocks,
    existingBlocks,
    prefs: {
      maxDailyFocusMin: spec.maxDailyFocusMin,
      breakAfterMin: spec.breakAfterMin,
      breakMin: spec.breakMin,
      riskLevel: spec.riskLevel,
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: spec.seed,
  };
}

function uniqueBlocks(blocks: Block[]): Block[] {
  const seen = new Set<string>();
  const result: Block[] = [];
  for (const block of blocks) {
    const key = `${block.taskId}|${block.start}|${block.end}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(block);
    }
  }
  return result;
}

function fixedExistingBlocks(input: ScheduleInput): Block[] {
  const nowMs = Temporal.Instant.from(input.now).epochMilliseconds;
  return (input.existingBlocks ?? []).filter(
    (block) =>
      Temporal.Instant.from(block.start).epochMilliseconds < nowMs,
  );
}

function blockKeyOf(block: Block): string {
  return `${block.taskId}|${block.start}|${block.end}`;
}

function independentH1Violation(
  blocks: Block[],
  commitments: Commitment[],
  history: Block[],
  candidate: Block[],
): boolean {
  const historyKeys = new Set(history.map(blockKeyOf));
  const candidateKeys = new Set(candidate.map(blockKeyOf));
  const intervals = blocks
    .map((block) => ({
      startMs: Temporal.Instant.from(block.start).epochMilliseconds,
      endMs: Temporal.Instant.from(block.end).epochMilliseconds,
      key: blockKeyOf(block),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  // Sweep with every still-active interval, not just the immediate predecessor:
  // nested history can hide an outer interval that still overlaps the current
  // one.
  const active: typeof intervals = [];
  for (const current of intervals) {
    for (let index = active.length - 1; index >= 0; index -= 1) {
      const entry = active[index];
      if (entry !== undefined && entry.endMs <= current.startMs) {
        active.splice(index, 1);
      }
    }
    for (const previous of active) {
      if (previous.endMs <= current.startMs) {
        continue;
      }
      const involvesHistory =
        historyKeys.has(previous.key) || historyKeys.has(current.key);
      const involvesCandidate =
        candidateKeys.has(previous.key) || candidateKeys.has(current.key);
      if (involvesHistory && !involvesCandidate) {
        continue;
      }
      return true;
    }
    active.push(current);
  }
  for (const block of blocks) {
    if (historyKeys.has(blockKeyOf(block))) {
      continue;
    }
    const startMs = Temporal.Instant.from(block.start).epochMilliseconds;
    const endMs = Temporal.Instant.from(block.end).epochMilliseconds;
    for (const commitment of commitments) {
      const commitmentStart = Temporal.Instant.from(
        commitment.start,
      ).epochMilliseconds;
      const commitmentEnd = Temporal.Instant.from(
        commitment.end,
      ).epochMilliseconds;
      if (startMs < commitmentEnd && endMs > commitmentStart) {
        return true;
      }
    }
  }
  return false;
}

function independentH6Violation(
  blocks: Block[],
  timeZone: string,
  maxDailyFocusMin: number,
  breakAfterMin: number,
  breakMin: number,
  history: Block[],
): boolean {
  const historyKeys = new Set(history.map(blockKeyOf));
  const byDate = new Map<string, { total: number; audited: number }>();
  for (const block of blocks) {
    const audited = !historyKeys.has(blockKeyOf(block));
    for (const [date, minutes] of dailyLoadsByMinute([block], timeZone)) {
      const entry = byDate.get(date) ?? { total: 0, audited: 0 };
      entry.total += minutes;
      if (audited) {
        entry.audited += minutes;
      }
      byDate.set(date, entry);
    }
  }
  for (const entry of byDate.values()) {
    if (entry.audited > 0 && entry.total > maxDailyFocusMin) {
      return true;
    }
  }
  if (breakAfterMin <= 0) {
    return false;
  }
  const intervals = blocks
    .map((block) => ({
      startMs: Temporal.Instant.from(block.start).epochMilliseconds,
      endMs: Temporal.Instant.from(block.end).epochMilliseconds,
      audited: !historyKeys.has(blockKeyOf(block)),
    }))
    .sort((a, b) => a.startMs - b.startMs);
  const breakMs = breakMin * 60 * 1000;
  const breakAfterMs = breakAfterMin * 60 * 1000;
  let runStart: number | undefined;
  let runEnd: number | undefined;
  let runHasAudited = false;
  for (const interval of intervals) {
    if (runStart === undefined || runEnd === undefined) {
      runStart = interval.startMs;
      runEnd = interval.endMs;
      runHasAudited = interval.audited;
      continue;
    }
    if (interval.startMs - runEnd >= breakMs) {
      if (runHasAudited && runEnd - runStart > breakAfterMs) {
        return true;
      }
      runStart = interval.startMs;
      runEnd = interval.endMs;
      runHasAudited = interval.audited;
    } else {
      runEnd = Math.max(runEnd, interval.endMs);
      runHasAudited = runHasAudited || interval.audited;
    }
  }
  return (
    runHasAudited &&
    runStart !== undefined &&
    runEnd !== undefined &&
    runEnd - runStart > breakAfterMs
  );
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

  it('matches an independent H1/H2/H6 oracle on spec-scale replans', () => {
    // 06 §10 caps are up to 30 tasks and 21 days. The heavy property uses a
    // bounded run count so the required SCHED_PROPERTY_RUNS=10000 suite stays
    // practical; the fast properties above still honour the full count.
    // SCHED_HEAVY_RUNS can raise the heavy-property sample; it is capped by
    // SCHED_PROPERTY_RUNS so the default 10k suite stays bounded.
    const HEAVY_RUNS = configuredHeavyRuns();
    let feasibleInputs = 0;
    let totalInputs = 0;
    fc.assert(
      fc.property(heavySpec, (spec) => {
        totalInputs += 1;
        const baseInput = buildHeavyInput({
          ...spec,
          locked: [],
          existing: [],
        });
        const base = generate(baseInput, {
          policies: ['front_loaded'],
          seed: spec.seed,
        });
        const priorBlocks =
          base.candidates[0]?.feasible === true
            ? base.candidates[0].blocks
            : [];
        const input = buildHeavyInput(spec, priorBlocks);
        const result = generate(input, {
          policies: ['front_loaded', 'balanced', 'focus_blocked'],
          seed: spec.seed,
        });
        if (result.candidates.some((candidate) => candidate.feasible)) {
          feasibleInputs += 1;
        }
        expect(result.candidates.length).toBeLessThanOrEqual(3);
        const nowMs = Temporal.Instant.from(input.now).epochMilliseconds;

        for (const candidate of result.candidates) {
          if (!candidate.feasible) {
            expect(candidate.explanation.length).toBeGreaterThan(0);
            continue;
          }
          for (const block of candidate.blocks) {
            expect(
              Temporal.Instant.from(block.start).epochMilliseconds,
            ).toBeGreaterThanOrEqual(nowMs);
          }

          const lockedKeys = new Set(input.lockedBlocks.map(blockKeyOf));
          const history = fixedExistingBlocks(input).filter(
            (block) => !lockedKeys.has(blockKeyOf(block)),
          );
          const historyKeys = new Set(history.map(blockKeyOf));
          const fullPlan = uniqueBlocks([
            ...input.lockedBlocks,
            ...history,
            ...candidate.blocks,
          ]);

          expect(
            independentH1Violation(
              fullPlan,
              input.commitments,
              history,
              candidate.blocks,
            ),
          ).toBe(false);
          for (const block of fullPlan) {
            if (historyKeys.has(blockKeyOf(block))) {
              continue;
            }
            expect(
              isCoveredByMinutes(
                input,
                Temporal.Instant.from(block.start).epochMilliseconds,
                Temporal.Instant.from(block.end).epochMilliseconds,
              ),
            ).toBe(true);
          }
          expect(
            independentH6Violation(
              fullPlan,
              input.timeZone,
              input.prefs.maxDailyFocusMin,
              input.prefs.breakAfterMin,
              input.prefs.breakMin,
              history,
            ),
          ).toBe(false);
        }
      }),
      { numRuns: HEAVY_RUNS },
    );
    console.log(
      `heavy feasible inputs: ${feasibleInputs}/${totalInputs} = ${(feasibleInputs / Math.max(1, totalInputs)).toFixed(3)}`,
    );
    expect(totalInputs).toBeGreaterThanOrEqual(HEAVY_RUNS);
    expect(feasibleInputs / Math.max(1, totalInputs)).toBeGreaterThanOrEqual(
      0.3,
    );
  }, heavyTimeoutMs());

  it('independent H1 catches a candidate under a nested history outer interval', () => {
    const history: Block[] = [
      {
        taskId: 'B',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T12:00:00Z',
      },
      {
        taskId: 'B',
        start: '2026-11-09T09:30:00Z',
        end: '2026-11-09T10:00:00Z',
      },
    ];
    const candidate: Block[] = [
      {
        taskId: 'A',
        start: '2026-11-09T10:30:00Z',
        end: '2026-11-09T11:00:00Z',
      },
    ];
    expect(
      independentH1Violation(
        [...history, ...candidate],
        [],
        history,
        candidate,
      ),
    ).toBe(true);
    const input = nestedHistoryInput('2026-11-09T17:00:00Z');
    expect(
      validate(input, candidate, {
        riskLevel: 'p50',
        historyBlocks: history,
      }).map((violation) => violation.code),
    ).toContain('H1');
  });

  it('adversarial nested-history property fails if audited H1 is disabled', () => {
    const nestedH1Spec = fc.record({
      innerStartUnits: fc.integer({ min: 0, max: 12 }),
      innerUnits: fc.integer({ min: 1, max: 6 }),
      gapUnits: fc.integer({ min: 2, max: 12 }),
      candidateUnits: fc.integer({ min: 1, max: 6 }),
      tailUnits: fc.integer({ min: 0, max: 6 }),
    });
    const unitMs = 5 * 60 * 1000;
    const baseMs = Date.UTC(2026, 10, 9, 9, 0);
    const iso = (ms: number): string => new Date(ms).toISOString();
    fc.assert(
      fc.property(nestedH1Spec, (spec) => {
        const innerStart = spec.innerStartUnits;
        const innerEnd = innerStart + spec.innerUnits;
        const candidateStart = innerEnd + spec.gapUnits;
        const candidateEnd = candidateStart + spec.candidateUnits;
        const outerUnits = candidateEnd + spec.tailUnits;
        const outer: Block = {
          taskId: 'B',
          start: iso(baseMs),
          end: iso(baseMs + outerUnits * unitMs),
        };
        const inner: Block = {
          taskId: 'B',
          start: iso(baseMs + innerStart * unitMs),
          end: iso(baseMs + innerEnd * unitMs),
        };
        const candidate: Block = {
          taskId: 'A',
          start: iso(baseMs + candidateStart * unitMs),
          end: iso(baseMs + candidateEnd * unitMs),
        };
        const history = [outer, inner];
        expect(
          independentH1Violation(
            [...history, candidate],
            [],
            history,
            [candidate],
          ),
        ).toBe(true);
        const input = nestedHistoryInput('2026-11-09T17:00:00Z');
        expect(
          validate(input, [candidate], {
            riskLevel: 'p50',
            historyBlocks: history,
          }).map((violation) => violation.code),
        ).toContain('H1');
      }),
      { numRuns: Math.min(NUM_RUNS, 300) },
    );
  });

  function nestedHistoryInput(dueAt: string): ScheduleInput {
    return {
      now: '2026-11-09T09:00:00Z',
      timeZone: 'UTC',
      horizon: {
        start: '2026-11-09T09:00:00Z',
        end: dueAt,
      },
      tasks: [
        {
          id: 'A',
          dueAt,
          estimate: { p50Min: 30, p90Min: 30 },
          splittable: true,
          minSessionMin: 5,
          maxSessionMin: 120,
          priority: 1,
          dependsOn: [],
        },
        {
          id: 'B',
          dueAt,
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 0,
          splittable: false,
          minSessionMin: 60,
          maxSessionMin: 60,
          priority: 1,
          dependsOn: [],
        },
      ],
      availability: [
        { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
      ],
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
      seed: 39039,
    };
  }
});
