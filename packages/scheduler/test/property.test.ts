import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import type {
  AvailabilityRule,
  Block,
  ExceptionRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { computeAvailableSlots, slotTotalMin, validate } from '../src/index.js';
import {
  alignedAvailableSlotMinutes,
  alignedAvailableSlots,
  dailyLoadsByMinute,
  hasDailyCapViolationByMinute,
  isCoveredByMinutes,
} from './minuteOracle.js';

const MINUTE_MS = 60 * 1000;

interface Scenario {
  timeZone: string;
  start: string;
  end: string;
}

const SCENARIOS: Scenario[] = [
  {
    timeZone: 'America/New_York',
    start: '2026-03-06T00:00:00Z',
    end: '2026-03-10T00:00:00Z',
  },
  {
    timeZone: 'America/New_York',
    start: '2026-10-30T00:00:00Z',
    end: '2026-11-03T00:00:00Z',
  },
  {
    timeZone: 'Europe/Berlin',
    start: '2026-10-23T00:00:00Z',
    end: '2026-10-28T00:00:00Z',
  },
  {
    timeZone: 'Australia/Sydney',
    start: '2026-04-03T00:00:00Z',
    end: '2026-04-07T00:00:00Z',
  },
  {
    timeZone: 'Asia/Seoul',
    start: '2026-11-08T00:00:00Z',
    end: '2026-11-13T00:00:00Z',
  },
  {
    timeZone: 'America/Santiago',
    start: '2026-09-03T00:00:00Z',
    end: '2026-09-09T00:00:00Z',
  },
  {
    timeZone: 'Asia/Beirut',
    start: '2026-03-26T00:00:00Z',
    end: '2026-04-01T00:00:00Z',
  },
  {
    timeZone: 'America/Havana',
    start: '2026-03-05T00:00:00Z',
    end: '2026-03-11T00:00:00Z',
  },
  {
    timeZone: 'UTC',
    start: '2026-11-08T00:00:00Z',
    end: '2026-11-13T00:00:00Z',
  },
  {
    timeZone: 'America/Goose_Bay',
    start: '2009-10-31T22:00:00Z',
    end: '2009-11-01T06:00:00Z',
  },
  {
    timeZone: 'America/Goose_Bay',
    start: '2009-03-08T02:00:00Z',
    end: '2009-03-08T07:00:00Z',
  },
  {
    timeZone: 'America/St_Johns',
    start: '2026-03-08T01:00:00Z',
    end: '2026-03-08T06:00:00Z',
  },
  {
    timeZone: 'America/St_Johns',
    start: '2026-11-01T00:00:00Z',
    end: '2026-11-01T05:00:00Z',
  },
  {
    timeZone: 'Australia/Lord_Howe',
    start: '2026-04-04T13:00:00Z',
    end: '2026-04-04T17:00:00Z',
  },
  {
    timeZone: 'Australia/Lord_Howe',
    start: '2026-10-03T13:00:00Z',
    end: '2026-10-03T17:00:00Z',
  },
  {
    timeZone: 'Europe/London',
    start: '2026-03-29T00:00:00Z',
    end: '2026-03-29T04:00:00Z',
  },
  {
    timeZone: 'Europe/London',
    start: '2026-10-25T00:00:00Z',
    end: '2026-10-25T04:00:00Z',
  },
];

/**
 * Short horizons (under ten hours) chosen around real transitions, so the
 * one-minute UTC oracle stays cheap even at SCHED_PROPERTY_RUNS=10000.
 */
const MINUTE_SCENARIOS: Scenario[] = [
  { timeZone: 'America/Goose_Bay', start: '2009-10-31T22:00:00Z', end: '2009-11-01T06:00:00Z' },
  { timeZone: 'America/Goose_Bay', start: '2009-03-08T02:00:00Z', end: '2009-03-08T07:00:00Z' },
  { timeZone: 'America/St_Johns', start: '2026-03-08T01:00:00Z', end: '2026-03-08T06:00:00Z' },
  { timeZone: 'America/St_Johns', start: '2026-11-01T00:00:00Z', end: '2026-11-01T05:00:00Z' },
  { timeZone: 'America/Santiago', start: '2026-09-06T01:00:00Z', end: '2026-09-06T07:00:00Z' },
  { timeZone: 'Australia/Lord_Howe', start: '2026-04-04T13:00:00Z', end: '2026-04-04T17:00:00Z' },
  { timeZone: 'Australia/Lord_Howe', start: '2026-10-03T13:00:00Z', end: '2026-10-03T17:00:00Z' },
  { timeZone: 'Asia/Seoul', start: '2026-11-08T00:00:00Z', end: '2026-11-08T08:00:00Z' },
  { timeZone: 'America/New_York', start: '2026-03-08T05:00:00Z', end: '2026-03-08T10:00:00Z' },
  { timeZone: 'America/New_York', start: '2026-11-01T04:00:00Z', end: '2026-11-01T09:00:00Z' },
  { timeZone: 'Europe/London', start: '2026-03-29T00:00:00Z', end: '2026-03-29T04:00:00Z' },
  { timeZone: 'Europe/London', start: '2026-10-25T00:00:00Z', end: '2026-10-25T04:00:00Z' },
];

const MINUTE_WINDOWS: Array<[string, string]> = [
  ['00:00', '24:00'],
  ['00:00', '02:00'],
  ['01:00', '04:00'],
  ['01:30', '02:30'],
  ['02:00', '03:30'],
  ['22:00', '24:00'],
  ['23:00', '24:00'],
];

function buildMinuteScenarioInput(
  scenario: Scenario,
  availability: AvailabilityRule[],
  exceptions: ExceptionRule[],
): ScheduleInput {
  return {
    now: scenario.start,
    timeZone: scenario.timeZone,
    horizon: { start: scenario.start, end: scenario.end },
    tasks: [],
    availability,
    exceptions,
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 1440,
      breakAfterMin: 1440,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 424242,
  };
}

function minuteTask(scenario: Scenario, requiredMin: number): Task {
  return {
    id: 'A',
    dueAt: scenario.end,
    earliestStartAt: scenario.start,
    estimate: { p50Min: requiredMin, p90Min: requiredMin },
    splittable: true,
    minSessionMin: 5,
    maxSessionMin: 1440,
    priority: 1,
    dependsOn: [],
  };
}

function gridBlock(
  scenario: Scenario,
  startStep: number,
  durationSteps: number,
): Block {
  const horizonStartMs = instantMs(scenario.start);
  const startMs =
    horizonStartMs +
    (startStep %
      Math.max(
        1,
        Math.floor(
          (instantMs(scenario.end) - horizonStartMs) / (5 * MINUTE_MS),
        ) - durationSteps + 1,
      )) *
      5 *
      MINUTE_MS;
  const endMs = startMs + durationSteps * 5 * MINUTE_MS;
  return {
    taskId: 'A',
    start: instantIso(startMs),
    end: instantIso(endMs),
  };
}

function allWeekRules(window: [string, string]): AvailabilityRule[] {
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday: weekday as Weekday,
    startLocal: window[0],
    endLocal: window[1],
    kind: 'work' as const,
  }));
}

function buildExceptionRule(
  scenario: Scenario,
  kind: 'off' | 'extra',
  dayOffset: number,
  fullDay: boolean,
  startStepInDay: number,
  durationSteps: number,
): ExceptionRule {
  const firstDate = Temporal.Instant.from(scenario.start)
    .toZonedDateTimeISO(scenario.timeZone)
    .toPlainDate();
  const date = firstDate.add({ days: dayOffset }).toString();
  if (fullDay) {
    return { date, kind };
  }
  const startMin = startStepInDay * 5;
  const endMin = Math.min(1440, startMin + durationSteps * 5);
  return {
    date,
    kind,
    startLocal: formatClock(startMin),
    endLocal: formatClock(endMin),
  };
}

const COMMIT_SCENARIO: Scenario = {
  timeZone: 'UTC',
  start: '2026-11-09T00:00:00Z',
  end: '2026-11-10T00:00:00Z',
};

const WEEKDAY_SETS: Record<string, Weekday[]> = {
  all: [1, 2, 3, 4, 5, 6, 7],
  weekdays: [1, 2, 3, 4, 5],
  most: [1, 2, 3, 4, 5, 6],
};

interface RawSpec {
  daySet: string;
  baseStart: string;
  baseEnd: string;
  includeEarly: boolean;
  exceptions: Array<{
    kind: string;
    dayOffset: number;
    fullDay: boolean;
    startOffset: number;
    duration: number;
  }>;
  riskLevel: string;
  withLocked: boolean;
  hasDependent: boolean;
  sessionASteps: number;
  sessionBSteps: number;
  lockedSlotIndex: number;
  lockedDurationSteps: number;
  earliestASteps: number;
  earliestBSteps: number;
  bufferASteps: number;
  bufferBSteps: number;
}

const rawSpec = fc.record({
  daySet: fc.constantFrom('all', 'weekdays', 'most'),
  baseStart: fc.constantFrom('08:57', '09:02', '07:58'),
  baseEnd: fc.constantFrom('17:03', '16:58', '17:07'),
  includeEarly: fc.boolean(),
  exceptions: fc.array(
    fc.record({
      kind: fc.constantFrom('off', 'extra'),
      dayOffset: fc.integer({ min: 0, max: 3 }),
      fullDay: fc.boolean(),
      startOffset: fc.integer({ min: 0, max: 9 }),
      duration: fc.integer({ min: 2, max: 9 }),
    }),
    { maxLength: 2 },
  ),
  riskLevel: fc.constantFrom('p50', 'p90'),
  withLocked: fc.boolean(),
  hasDependent: fc.boolean(),
  sessionASteps: fc.integer({ min: 6, max: 24 }),
  sessionBSteps: fc.integer({ min: 6, max: 24 }),
  lockedSlotIndex: fc.integer({ min: 0, max: 49 }),
  lockedDurationSteps: fc.integer({ min: 6, max: 12 }),
  earliestASteps: fc.integer({ min: 0, max: 24 }),
  earliestBSteps: fc.integer({ min: 0, max: 24 }),
  bufferASteps: fc.integer({ min: 0, max: 12 }),
  bufferBSteps: fc.integer({ min: 0, max: 12 }),
});

function configuredRuns(): number {
  const raw = process.env.SCHED_PROPERTY_RUNS;
  if (raw === undefined) {
    return 1000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
}

const NUM_RUNS = configuredRuns();

function instantMs(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

function formatClock(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function buildAvailability(spec: RawSpec): AvailabilityRule[] {
  const weekdays = WEEKDAY_SETS[spec.daySet] ?? WEEKDAY_SETS['all'] ?? [1];
  const rules: AvailabilityRule[] = weekdays.map((weekday) => ({
    weekday,
    startLocal: spec.baseStart,
    endLocal: spec.baseEnd,
    kind: 'work',
  }));
  if (spec.includeEarly) {
    rules.push({
      weekday: 7,
      startLocal: '01:17',
      endLocal: '02:43',
      kind: 'focus',
    });
  }
  return rules;
}

function buildExceptions(scenario: Scenario, spec: RawSpec): ExceptionRule[] {
  const firstDate = Temporal.Instant.from(scenario.start)
    .toZonedDateTimeISO(scenario.timeZone)
    .toPlainDate();
  return spec.exceptions.map((exception) => {
    const date = firstDate.add({ days: exception.dayOffset }).toString();
    if (exception.kind === 'off') {
      if (exception.fullDay) {
        return { date, kind: 'off' };
      }
      const start = 12 * 60 + exception.startOffset;
      return {
        date,
        kind: 'off',
        startLocal: formatClock(start),
        endLocal: formatClock(start + exception.duration),
      };
    }
    const start = 18 * 60 + exception.startOffset;
    return {
      date,
      kind: 'extra',
      startLocal: formatClock(start),
      endLocal: formatClock(start + 30 + exception.duration * 3),
    };
  });
}

function buildInput(
  scenario: Scenario,
  spec: RawSpec,
  tasks: Task[],
  lockedBlocks: Block[],
): ScheduleInput {
  return {
    now: scenario.start,
    timeZone: scenario.timeZone,
    horizon: { start: scenario.start, end: scenario.end },
    tasks,
    availability: buildAvailability(spec),
    exceptions: buildExceptions(scenario, spec),
    commitments: [],
    lockedBlocks,
    prefs: {
      maxDailyFocusMin: 720,
      breakAfterMin: 720,
      breakMin: 15,
      riskLevel: spec.riskLevel === 'p90' ? 'p90' : 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 20261109,
  };
}

interface TaskOptions {
  riskLevel?: string;
  earliestMs?: number;
  dueMs?: number;
  bufferBeforeDueMin?: number;
}

function instantIso(epochMs: number): string {
  return Temporal.Instant.fromEpochMilliseconds(epochMs).toString();
}

function makeTask(
  id: string,
  requiredMin: number,
  scenario: Scenario,
  dependsOn: string[] = [],
  options: TaskOptions = {},
): Task {
  const estimate =
    options.riskLevel === 'p90'
      ? { p50Min: Math.max(0, requiredMin - 30), p90Min: requiredMin }
      : { p50Min: requiredMin, p90Min: requiredMin + 30 };
  return {
    id,
    dueAt:
      options.dueMs === undefined ? scenario.end : instantIso(options.dueMs),
    earliestStartAt:
      options.earliestMs === undefined
        ? scenario.start
        : instantIso(options.earliestMs),
    estimate,
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn,
    ...(options.bufferBeforeDueMin === undefined
      ? {}
      : { bufferBeforeDueMin: options.bufferBeforeDueMin }),
  };
}

function splitSessions(minutes: number): number[] {
  const sessions: number[] = [];
  let remaining = minutes;
  while (remaining > 120) {
    sessions.push(120);
    remaining -= 120;
  }
  if (remaining > 0) {
    sessions.push(remaining);
  }
  const lastIndex = sessions.length - 1;
  const last = sessions[lastIndex];
  if (last !== undefined && last < 30) {
    const deficit = 30 - last;
    sessions[lastIndex - 1] = (sessions[lastIndex - 1] ?? 120) - deficit;
    sessions[lastIndex] = 30;
  }
  return sessions;
}

interface Placement {
  blocks: Block[];
  lastEndMs: number;
}

function allocateFromSlots(
  slots: Array<{ start: string; end: string }>,
  taskId: string,
  minutes: number,
  startAfterMs: number,
): Placement | null {
  const sessions = splitSessions(minutes);
  const blocks: Block[] = [];
  let cursor = startAfterMs;
  for (const sessionMin of sessions) {
    let placed = false;
    for (const slot of slots) {
      const slotStart = instantMs(slot.start);
      const slotEnd = instantMs(slot.end);
      const start = Math.max(cursor, slotStart);
      const end = start + sessionMin * MINUTE_MS;
      if (end <= slotEnd) {
        blocks.push({
          taskId,
          start: Temporal.Instant.fromEpochMilliseconds(start).toString(),
          end: Temporal.Instant.fromEpochMilliseconds(end).toString(),
        });
        cursor = end;
        placed = true;
        break;
      }
    }
    if (!placed) {
      return null;
    }
  }
  return { blocks, lastEndMs: cursor };
}

function isCoveredBySlots(
  slots: Array<{ start: string; end: string }>,
  startMs: number,
  endMs: number,
): boolean {
  let cursor = startMs;
  for (const slot of slots) {
    const slotStart = instantMs(slot.start);
    const slotEnd = instantMs(slot.end);
    if (slotEnd <= cursor) {
      continue;
    }
    if (slotStart > cursor) {
      return false;
    }
    cursor = Math.max(cursor, slotEnd);
    if (cursor >= endMs) {
      return true;
    }
  }
  return cursor >= endMs;
}


function hasH6Oracle(
  blocks: Block[],
  timeZone: string,
  maxDailyFocusMin: number,
  breakAfterMin: number,
  breakMin: number,
): boolean {
  for (const minutes of dailyLoadsByMinute(blocks, timeZone).values()) {
    if (minutes > maxDailyFocusMin) {
      return true;
    }
  }

  const sorted = [...blocks]
    .map((block) => ({ startMs: instantMs(block.start), endMs: instantMs(block.end) }))
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  let runStart: number | undefined;
  let runEnd: number | undefined;
  for (const interval of sorted) {
    if (runStart === undefined || runEnd === undefined) {
      runStart = interval.startMs;
      runEnd = interval.endMs;
      continue;
    }
    if (interval.startMs - runEnd >= breakMin * MINUTE_MS) {
      if (runEnd - runStart > breakAfterMin * MINUTE_MS) {
        return true;
      }
      runStart = interval.startMs;
      runEnd = interval.endMs;
    } else {
      runEnd = Math.max(runEnd, interval.endMs);
    }
  }
  return (
    runStart !== undefined &&
    runEnd !== undefined &&
    runEnd - runStart > breakAfterMin * MINUTE_MS
  );
}

describe('scheduler properties', () => {
  it('plans derived from computeAvailableSlots stay valid across varied inputs', () => {
    const generator = fc.tuple(fc.constantFrom(...SCENARIOS), rawSpec);

    fc.assert(
      fc.property(generator, ([scenario, spec]) => {
        const horizonStartMs = instantMs(scenario.start);
        const horizonEndMs = instantMs(scenario.end);
        const earliestAMs =
          horizonStartMs + spec.earliestASteps * 5 * MINUTE_MS;
        const earliestBMs =
          horizonStartMs + spec.earliestBSteps * 5 * MINUTE_MS;
        const bufferAMin = spec.bufferASteps * 5;
        const bufferBMin = spec.bufferBSteps * 5;
        const dueAMs = horizonEndMs + bufferAMin * MINUTE_MS;
        const dueBMs = horizonEndMs + bufferBMin * MINUTE_MS;

        const baseInput = buildInput(scenario, spec, [], []);
        const baseSlots = computeAvailableSlots(baseInput);

        let lockedBlocks: Block[] = [];
        let lockedMin = 0;
        let lockedEndMs = Number.NEGATIVE_INFINITY;
        if (spec.withLocked) {
          const preferred = spec.lockedSlotIndex % Math.max(1, baseSlots.length);
          let chosen: { start: string; end: string } | undefined;
          for (let offset = 0; offset < baseSlots.length; offset += 1) {
            const candidate = baseSlots[(preferred + offset) % baseSlots.length];
            if (candidate === undefined) {
              continue;
            }
            const lengthMin = (instantMs(candidate.end) - instantMs(candidate.start)) / MINUTE_MS;
            if (lengthMin >= 30 && instantMs(candidate.start) >= earliestAMs) {
              chosen = candidate;
              break;
            }
          }
          if (chosen === undefined) {
            fc.pre(false);
            return;
          }
          const slotStart = instantMs(chosen.start);
          const slotMinutes = (instantMs(chosen.end) - slotStart) / MINUTE_MS;
          const maxSteps = Math.floor(Math.min(60, slotMinutes) / 5);
          const durationSteps = Math.min(spec.lockedDurationSteps, maxSteps);
          const end = slotStart + durationSteps * 5 * MINUTE_MS;
          lockedBlocks = [
            {
              taskId: 'A',
              start: Temporal.Instant.fromEpochMilliseconds(slotStart).toString(),
              end: Temporal.Instant.fromEpochMilliseconds(end).toString(),
            },
          ];
          lockedMin = durationSteps * 5;
          lockedEndMs = end;
        }

        const sessionAMin = spec.sessionASteps * 5;
        const sessionBMin = spec.sessionBSteps * 5;
        const requiredA = lockedMin + sessionAMin;
        const tasks: Task[] = [
          makeTask('A', requiredA, scenario, [], {
            riskLevel: spec.riskLevel,
            earliestMs: earliestAMs,
            dueMs: dueAMs,
            bufferBeforeDueMin: bufferAMin,
          }),
        ];
        if (spec.hasDependent) {
          tasks.push(
            makeTask('B', sessionBMin, scenario, ['A'], {
              riskLevel: spec.riskLevel,
              earliestMs: earliestBMs,
              dueMs: dueBMs,
              bufferBeforeDueMin: bufferBMin,
            }),
          );
        }

        const input = buildInput(scenario, spec, tasks, lockedBlocks);
        const slots = computeAvailableSlots(input);
        const aPlacement = allocateFromSlots(
          slots,
          'A',
          sessionAMin,
          earliestAMs,
        );
        if (aPlacement === null) {
          fc.pre(false);
          return;
        }

        const blocks = [...aPlacement.blocks];
        if (spec.hasDependent) {
          const aReady = Math.max(
            aPlacement.lastEndMs,
            lockedEndMs,
            earliestBMs,
          );
          const bPlacement = allocateFromSlots(
            slots,
            'B',
            sessionBMin,
            aReady,
          );
          if (bPlacement === null) {
            fc.pre(false);
            return;
          }
          blocks.push(...bPlacement.blocks);
        }

        expect(validate(input, blocks, { riskLevel: input.prefs.riskLevel })).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 60000);

  it('H2 agrees with computeAvailableSlots for arbitrary grid blocks', () => {
    const generator = fc.tuple(
      fc.constantFrom(...SCENARIOS),
      rawSpec,
      fc.integer({ min: 0, max: 5000 }),
      fc.integer({ min: 6, max: 24 }),
    );

    fc.assert(
      fc.property(
        generator,
        ([scenario, spec, startStep, durationSteps]) => {
          const input = buildInput(scenario, spec, [], []);
          const slots = computeAvailableSlots(input);

          const horizonStartMs = instantMs(scenario.start);
          const horizonEndMs = instantMs(scenario.end);
          const durationMin = durationSteps * 5;
          const totalMin = (horizonEndMs - horizonStartMs) / MINUTE_MS;
          const maxStartSteps = Math.floor((totalMin - durationMin) / 5);
          if (maxStartSteps < 0) {
            fc.pre(false);
            return;
          }
          const steps = startStep % (maxStartSteps + 1);
          const blockStartMs = horizonStartMs + steps * 5 * MINUTE_MS;
          const blockEndMs = blockStartMs + durationMin * MINUTE_MS;
          const block: Block = {
            taskId: 'A',
            start: Temporal.Instant.fromEpochMilliseconds(blockStartMs).toString(),
            end: Temporal.Instant.fromEpochMilliseconds(blockEndMs).toString(),
          };
          input.tasks = [
            makeTask('A', durationMin, scenario, [], {
              riskLevel: spec.riskLevel,
            }),
          ];

          const covered = isCoveredBySlots(slots, blockStartMs, blockEndMs);
          const codes = validate(input, [block], {
            riskLevel: input.prefs.riskLevel,
          })
            .map((violation) => violation.code)
            .sort();
          expect(codes).toEqual(covered ? [] : ['H2']);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60000);

  it('a block overlapping a commitment always reports H1', () => {
    const generator = fc.record({
      commitStartStep: fc.integer({ min: 0, max: 84 }),
      commitStepCount: fc.integer({ min: 6, max: 24 }),
      overlapStep: fc.integer({ min: 0, max: 23 }),
      blockStepCount: fc.integer({ min: 6, max: 24 }),
    });

    fc.assert(
      fc.property(generator, (sample) => {
        const commitSteps = sample.commitStepCount;
        const startStep = Math.min(sample.commitStartStep, 96 - commitSteps);
        const overlapStep = sample.overlapStep % commitSteps;
        const blockSteps = sample.blockStepCount;

        const epochBase = Temporal.Instant.from('2026-11-09T00:00:00Z');
        const commitmentStartMs =
          epochBase.epochMilliseconds + startStep * 5 * MINUTE_MS;
        const commitmentEndMs =
          commitmentStartMs + commitSteps * 5 * MINUTE_MS;
        const blockStartMs =
          commitmentStartMs + overlapStep * 5 * MINUTE_MS;
        const blockEndMs = blockStartMs + blockSteps * 5 * MINUTE_MS;

        const input = buildInput(
          COMMIT_SCENARIO,
          {
            daySet: 'all',
            baseStart: '09:00',
            baseEnd: '17:00',
            includeEarly: false,
            exceptions: [],
            riskLevel: 'p50',
            withLocked: false,
            hasDependent: false,
            sessionASteps: 12,
            sessionBSteps: 12,
            lockedSlotIndex: 0,
            lockedDurationSteps: 6,
            earliestASteps: 0,
            earliestBSteps: 0,
            bufferASteps: 0,
            bufferBSteps: 0,
          },
          [makeTask('A', 60, COMMIT_SCENARIO)],
          [],
        );
        input.commitments = [
          {
            start: Temporal.Instant.fromEpochMilliseconds(
              commitmentStartMs,
            ).toString(),
            end: Temporal.Instant.fromEpochMilliseconds(
              commitmentEndMs,
            ).toString(),
          },
        ];
        const block: Block = {
          taskId: 'A',
          start: Temporal.Instant.fromEpochMilliseconds(blockStartMs).toString(),
          end: Temporal.Instant.fromEpochMilliseconds(blockEndMs).toString(),
        };

        const violations = validate(input, [block], { riskLevel: 'p50' });
        expect(violations.some((violation) => violation.code === 'H1')).toBe(
          true,
        );
      }),
      { numRuns: NUM_RUNS },
    );
  }, 60000);
  it('H6 daily and break boundaries agree with an independent oracle', () => {
    const generator = fc.tuple(
      fc.constantFrom(...SCENARIOS),
      rawSpec,
      fc.integer({ min: 0, max: 49 }),
      fc.integer({ min: 6, max: 24 }),
      fc.integer({ min: 6, max: 24 }),
      fc.integer({ min: 0, max: 3 }),
      fc.constantFrom(30, 60, 90, 120, 150),
      fc.constantFrom(30, 60, 90, 120),
      fc.constantFrom(15, 30),
    );

    fc.assert(
      fc.property(
        generator,
        ([
          scenario,
          spec,
          slotIndex,
          firstSteps,
          secondSteps,
          gapSteps,
          maxDailyFocusMin,
          breakAfterMin,
          breakMin,
        ]) => {
          const input = buildInput(scenario, spec, [], []);
          const slots = computeAvailableSlots(input);
          if (slots.length === 0) {
            fc.pre(false);
            return;
          }
          const preferred = slotIndex % slots.length;
          let chosen: { start: string; end: string } | undefined;
          for (let offset = 0; offset < slots.length; offset += 1) {
            const candidate = slots[(preferred + offset) % slots.length];
            if (candidate === undefined) {
              continue;
            }
            if ((instantMs(candidate.end) - instantMs(candidate.start)) / MINUTE_MS >= 60) {
              chosen = candidate;
              break;
            }
          }
          if (chosen === undefined) {
            fc.pre(false);
            return;
          }
          const slotStart = instantMs(chosen.start);
          const slotEnd = instantMs(chosen.end);
          const slotMinutes = (slotEnd - slotStart) / MINUTE_MS;
          const firstMin = Math.min(firstSteps * 5, slotMinutes);
          if (firstMin < 30) {
            fc.pre(false);
            return;
          }
          const gapMin = gapSteps * 5;
          const remaining = slotMinutes - firstMin - gapMin;
          const secondMin = Math.min(secondSteps * 5, Math.floor(remaining / 5) * 5);
          const blocks: Block[] = [
            {
              taskId: 'A',
              start: instantIso(slotStart),
              end: instantIso(slotStart + firstMin * MINUTE_MS),
            },
          ];
          if (secondMin >= 30) {
            blocks.push({
              taskId: 'A',
              start: instantIso(
                slotStart + (firstMin + gapMin) * MINUTE_MS,
              ),
              end: instantIso(
                slotStart + (firstMin + gapMin + secondMin) * MINUTE_MS,
              ),
            });
          }
          const requiredMin = blocks.reduce(
            (sum, block) => sum + (instantMs(block.end) - instantMs(block.start)) / MINUTE_MS,
            0,
          );
          input.tasks = [makeTask('A', requiredMin, scenario, [], { riskLevel: spec.riskLevel })];
          input.prefs.maxDailyFocusMin = maxDailyFocusMin;
          input.prefs.breakAfterMin = breakAfterMin;
          input.prefs.breakMin = breakMin;

          const hasH6 = validate(input, blocks, {
            riskLevel: input.prefs.riskLevel,
          }).some((violation) => violation.code === 'H6');
          const oracle = hasH6Oracle(
            blocks,
            scenario.timeZone,
            maxDailyFocusMin,
            breakAfterMin,
            breakMin,
          );
          expect(hasH6).toBe(oracle);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60000);

  it('H2 agrees with the one-minute UTC membership oracle around transitions', () => {
    const generator = fc.tuple(
      fc.constantFrom(...MINUTE_SCENARIOS),
      fc.constantFrom(...MINUTE_WINDOWS),
      fc.constantFrom<'off' | 'extra'>('off', 'extra'),
      fc.integer({ min: 0, max: 2 }),
      fc.boolean(),
      fc.integer({ min: 0, max: 287 }),
      fc.integer({ min: 1, max: 24 }),
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 1, max: 2000 }),
    );

    fc.assert(
      fc.property(
        generator,
        ([
          scenario,
          window,
          kind,
          dayOffset,
          fullDay,
          startStepInDay,
          exceptionSteps,
          rawStart,
          rawDuration,
        ]) => {
          const totalSteps =
            (instantMs(scenario.end) - instantMs(scenario.start)) /
            (5 * MINUTE_MS);
          const durationSteps = 1 + (rawDuration % totalSteps);
          const startStep = rawStart % (totalSteps - durationSteps + 1);
          const block = gridBlock(scenario, startStep, durationSteps);
          const input = buildMinuteScenarioInput(
            scenario,
            allWeekRules(window),
            [
              buildExceptionRule(
                scenario,
                kind,
                dayOffset,
                fullDay,
                startStepInDay,
                exceptionSteps,
              ),
            ],
          );
          input.tasks = [minuteTask(scenario, durationSteps * 5)];

          const covered = isCoveredByMinutes(
            input,
            instantMs(block.start),
            instantMs(block.end),
          );
          const codes = validate(input, [block], { riskLevel: 'p50' })
            .map((violation) => violation.code)
            .sort();
          expect(codes).toEqual(covered ? [] : ['H2']);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120000);

  it('H6 daily loads agree with the one-minute UTC oracle around transitions', () => {
    const generator = fc.tuple(
      fc.constantFrom(...MINUTE_SCENARIOS),
      fc.integer({ min: 0, max: 2000 }),
      fc.integer({ min: 1, max: 2000 }),
      fc.constantFrom(10, 30, 60, 90, 120, 240, 480),
    );

    fc.assert(
      fc.property(
        generator,
        ([scenario, rawStart, rawDuration, maxDailyFocusMin]) => {
          const totalSteps =
            (instantMs(scenario.end) - instantMs(scenario.start)) /
            (5 * MINUTE_MS);
          const durationSteps = 1 + (rawDuration % totalSteps);
          const startStep = rawStart % (totalSteps - durationSteps + 1);
          const block = gridBlock(scenario, startStep, durationSteps);
          const input = buildMinuteScenarioInput(
            scenario,
            allWeekRules(['00:00', '24:00']),
            [],
          );
          input.tasks = [minuteTask(scenario, durationSteps * 5)];
          input.prefs.maxDailyFocusMin = maxDailyFocusMin;
          input.prefs.breakAfterMin = 100000;
          input.prefs.breakMin = 15;

          const hasH6 = validate(input, [block], { riskLevel: 'p50' }).some(
            (violation) => violation.code === 'H6',
          );
          expect(hasH6).toBe(
            hasDailyCapViolationByMinute(input, [block]),
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 120000);

  it('exact slot intervals agree with the one-minute UTC oracle for varied windows', () => {
    const generator = fc.tuple(
      fc.constantFrom(...MINUTE_SCENARIOS),
      fc.constantFrom(...MINUTE_WINDOWS),
      fc.array(
        fc.tuple(
          fc.constantFrom<'off' | 'extra'>('off', 'extra'),
          fc.integer({ min: 0, max: 2 }),
          fc.boolean(),
          fc.integer({ min: 0, max: 287 }),
          fc.integer({ min: 1, max: 24 }),
        ),
        { maxLength: 2 },
      ),
    );

    fc.assert(
      fc.property(generator, ([scenario, window, exceptionSpecs]) => {
        const input = buildMinuteScenarioInput(
          scenario,
          allWeekRules(window),
          exceptionSpecs.map(([kind, dayOffset, fullDay, start, steps]) =>
            buildExceptionRule(
              scenario,
              kind,
              dayOffset,
              fullDay,
              start,
              steps,
            ),
          ),
        );

        const slots = computeAvailableSlots(input);
        expect(slots).toEqual(alignedAvailableSlots(input));
        expect(slotTotalMin(slots)).toBe(alignedAvailableSlotMinutes(input));
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120000);

});
