import fc from 'fast-check';
import { Temporal } from 'temporal-polyfill';
import type { Block, ScheduleInput } from '../src/index.js';
import { validate } from '../src/index.js';

const TIME_ZONES = [
  'Asia/Seoul',
  'America/New_York',
  'Europe/Berlin',
  'UTC',
  'Australia/Sydney',
] as const;

const HORIZON_START = '2026-11-08T00:00:00Z';
const HORIZON_END = '2026-11-12T00:00:00Z';

function configuredRuns(): number {
  const raw = process.env.SCHED_PROPERTY_RUNS;
  if (raw === undefined) {
    return 1000;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
}

const NUM_RUNS = configuredRuns();

function localInstant(
  timeZone: string,
  dateString: string,
  minutesOfDay: number,
): string {
  const date = Temporal.PlainDate.from(dateString);
  const zoned = Temporal.ZonedDateTime.from(
    {
      timeZone,
      year: date.year,
      month: date.month,
      day: date.day,
      hour: Math.floor(minutesOfDay / 60),
      minute: minutesOfDay % 60,
    },
    { disambiguation: 'compatible' },
  );
  return zoned.toInstant().toString();
}

function baseInput(timeZone: string): ScheduleInput {
  return {
    now: HORIZON_START,
    timeZone,
    horizon: { start: HORIZON_START, end: HORIZON_END },
    tasks: [],
    availability: [
      { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      { weekday: 2, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      { weekday: 3, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
    ],
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 120,
      breakAfterMin: 120,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 20261109,
  };
}

describe('scheduler properties', () => {
  it('valid plan stays valid for random in-slot block sets', () => {
    const generator = fc.tuple(
      fc.constantFrom(...TIME_ZONES),
      fc.array(fc.integer({ min: 6, max: 24 }), {
        minLength: 1,
        maxLength: 3,
      }),
      fc.array(fc.integer({ min: 0, max: 72 }), {
        minLength: 3,
        maxLength: 3,
      }),
    );

    fc.assert(
      fc.property(generator, ([timeZone, sessionSteps, offsetSteps]) => {
        const sessionMinutes = sessionSteps.map((steps) => steps * 5);
        const requiredMin = sessionMinutes.reduce(
          (sum, minutes) => sum + minutes,
          0,
        );
        const localDates = ['2026-11-09', '2026-11-10', '2026-11-11'];

        const blocks: Block[] = sessionMinutes.map((minutes, index) => {
          const maxOffsetSteps = Math.floor((480 - minutes) / 5);
          const rawOffset = offsetSteps[index] ?? 0;
          const offset = rawOffset % (maxOffsetSteps + 1);
          const startMinutes = 9 * 60 + offset * 5;
          const date = localDates[index] ?? '2026-11-11';
          return {
            taskId: 'A',
            start: localInstant(timeZone, date, startMinutes),
            end: localInstant(timeZone, date, startMinutes + minutes),
          };
        });

        const input = baseInput(timeZone);
        input.tasks = [
          {
            id: 'A',
            dueAt: localInstant(timeZone, '2026-11-11', 17 * 60),
            earliestStartAt: HORIZON_START,
            estimate: { p50Min: requiredMin, p90Min: requiredMin },
            splittable: true,
            minSessionMin: 30,
            maxSessionMin: 120,
            priority: 1,
            dependsOn: [],
          },
        ];

        expect(validate(input, blocks, { riskLevel: 'p50' })).toEqual([]);
      }),
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
          epochBase.epochMilliseconds + startStep * 5 * 60 * 1000;
        const commitmentEndMs =
          commitmentStartMs + commitSteps * 5 * 60 * 1000;
        const blockStartMs =
          commitmentStartMs + overlapStep * 5 * 60 * 1000;
        const blockEndMs = blockStartMs + blockSteps * 5 * 60 * 1000;

        const input = baseInput('Asia/Seoul');
        input.tasks = [
          {
            id: 'A',
            dueAt: '2026-11-11T08:00:00Z',
            estimate: { p50Min: 60, p90Min: 60 },
            splittable: true,
            minSessionMin: 30,
            maxSessionMin: 120,
            priority: 1,
            dependsOn: [],
          },
        ];
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
