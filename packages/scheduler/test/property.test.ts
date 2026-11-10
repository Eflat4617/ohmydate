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
import { computeAvailableSlots, validate } from '../src/index.js';

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
    timeZone: 'UTC',
    start: '2026-11-08T00:00:00Z',
    end: '2026-11-13T00:00:00Z',
  },
];

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

function makeTask(
  id: string,
  requiredMin: number,
  scenario: Scenario,
  dependsOn: string[] = [],
): Task {
  return {
    id,
    dueAt: scenario.end,
    earliestStartAt: scenario.start,
    estimate: { p50Min: requiredMin, p90Min: requiredMin },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn,
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

describe('scheduler properties', () => {
  it('plans derived from computeAvailableSlots stay valid across varied inputs', () => {
    const generator = fc.tuple(fc.constantFrom(...SCENARIOS), rawSpec);

    fc.assert(
      fc.property(generator, ([scenario, spec]) => {
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
            if (lengthMin >= 30) {
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
        const tasks: Task[] = [makeTask('A', requiredA, scenario)];
        if (spec.hasDependent) {
          tasks.push(makeTask('B', sessionBMin, scenario, ['A']));
        }

        const input = buildInput(scenario, spec, tasks, lockedBlocks);
        const slots = computeAvailableSlots(input);
        const aPlacement = allocateFromSlots(
          slots,
          'A',
          sessionAMin,
          instantMs(scenario.start),
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
            instantMs(scenario.start),
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
  });

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
          input.tasks = [makeTask('A', durationMin, scenario)];

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
  });

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
  });
});
