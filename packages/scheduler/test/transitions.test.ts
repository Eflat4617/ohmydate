import { Temporal } from 'temporal-polyfill';
import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
} from '../src/index.js';
import {
  computeAvailableSlots,
  slotTotalMin,
  validate,
} from '../src/index.js';
import {
  availableSlotMinutes,
  dailyLoadsByMinute,
  hasDailyCapViolationByMinute,
  isCoveredByMinutes,
} from './minuteOracle.js';

const MINUTE_MS = 60 * 1000;

const ALL_WEEK_FULL_DAY: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
  (weekday) => ({
    weekday: weekday as AvailabilityRule['weekday'],
    startLocal: '00:00',
    endLocal: '24:00',
    kind: 'work' as const,
  }),
);

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'A',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 5,
    maxSessionMin: 1440,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function makeInput(options: {
  timeZone: string;
  start: string;
  end: string;
  availability: AvailabilityRule[];
  task: Task;
  lockedBlocks?: Block[];
  maxDailyFocusMin?: number;
  breakAfterMin?: number;
}): ScheduleInput {
  return {
    now: options.start,
    timeZone: options.timeZone,
    horizon: { start: options.start, end: options.end },
    tasks: [options.task],
    availability: options.availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: options.lockedBlocks ?? [],
    prefs: {
      maxDailyFocusMin: options.maxDailyFocusMin ?? 1440,
      breakAfterMin: options.breakAfterMin ?? 1440,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 17017,
  };
}

function codes(input: ScheduleInput, blocks: Block[]): string[] {
  return validate(input, blocks, { riskLevel: 'p50' })
    .map((violation) => violation.code)
    .sort();
}

function instantMs(value: string): number {
  return Temporal.Instant.from(value).epochMilliseconds;
}

const GOOSE_BAY_ROLLBACK_BLOCK: Block = {
  taskId: 'A',
  start: '2009-11-01T02:30:00Z',
  end: '2009-11-01T04:00:00Z',
};

const GOOSE_BAY_H2_BLOCK: Block = {
  taskId: 'A',
  start: '2009-11-01T03:00:00Z',
  end: '2009-11-01T03:30:00Z',
};

const GOOSE_BAY_ROLLBACK_AVAILABILITY: AvailabilityRule[] = [
  { weekday: 6, startLocal: '23:10', endLocal: '23:20', kind: 'work' },
  { weekday: 7, startLocal: '00:00', endLocal: '00:01', kind: 'work' },
];

describe('ADR-017 backward local-date transitions', () => {
  it('H6 rejects a daily-cap overflow when a rollback revisits the previous date', () => {
    const input = makeInput({
      timeZone: 'America/Goose_Bay',
      start: '2009-11-01T02:30:00Z',
      end: '2009-11-01T04:30:00Z',
      availability: ALL_WEEK_FULL_DAY,
      task: makeTask({
        estimate: { p50Min: 90, p90Min: 90 },
        minSessionMin: 5,
        maxSessionMin: 1440,
      }),
      maxDailyFocusMin: 60,
    });

    expect(codes(input, [GOOSE_BAY_ROLLBACK_BLOCK])).toEqual(['H6']);
    expect(hasDailyCapViolationByMinute(input, [GOOSE_BAY_ROLLBACK_BLOCK])).toBe(
      true,
    );
    const loads = dailyLoadsByMinute(
      [GOOSE_BAY_ROLLBACK_BLOCK],
      input.timeZone,
    );
    expect(loads.get('2009-10-31')).toBe(89);
    expect(loads.get('2009-11-01')).toBe(1);
  });

  it('H6 audits the same rollback when supplied as historical locked work', () => {
    const input = makeInput({
      timeZone: 'America/Goose_Bay',
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
      availability: ALL_WEEK_FULL_DAY,
      task: makeTask({
        estimate: { p50Min: 90, p90Min: 90 },
        minSessionMin: 5,
        maxSessionMin: 1440,
      }),
      maxDailyFocusMin: 60,
      lockedBlocks: [GOOSE_BAY_ROLLBACK_BLOCK],
    });

    expect(codes(input, [])).toEqual(['H6']);
  });

  it('H2 enumerates both local dates of a block that ends on an earlier date', () => {
    const input = makeInput({
      timeZone: 'America/Goose_Bay',
      start: '2009-11-01T02:30:00Z',
      end: '2009-11-01T04:30:00Z',
      availability: GOOSE_BAY_ROLLBACK_AVAILABILITY,
      task: makeTask({
        estimate: { p50Min: 30, p90Min: 30 },
        minSessionMin: 5,
        maxSessionMin: 120,
      }),
    });

    expect(codes(input, [GOOSE_BAY_H2_BLOCK])).toEqual(['H2']);
    expect(
      isCoveredByMinutes(
        input,
        instantMs(GOOSE_BAY_H2_BLOCK.start),
        instantMs(GOOSE_BAY_H2_BLOCK.end),
      ),
    ).toBe(false);
  });

  it('H2 audits the same earlier-date block as historical locked work', () => {
    const input = makeInput({
      timeZone: 'America/Goose_Bay',
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
      availability: GOOSE_BAY_ROLLBACK_AVAILABILITY,
      task: makeTask({
        estimate: { p50Min: 30, p90Min: 30 },
        minSessionMin: 5,
        maxSessionMin: 120,
      }),
      lockedBlocks: [GOOSE_BAY_H2_BLOCK],
    });

    expect(codes(input, [])).toEqual(['H2']);
    expect(
      isCoveredByMinutes(
        input,
        instantMs(GOOSE_BAY_H2_BLOCK.start),
        instantMs(GOOSE_BAY_H2_BLOCK.end),
      ),
    ).toBe(false);
  });

  it('preserves every available minute across the Goose_Bay rollback', () => {
    const input = makeInput({
      timeZone: 'America/Goose_Bay',
      start: '2009-11-01T02:30:00Z',
      end: '2009-11-01T04:30:00Z',
      availability: ALL_WEEK_FULL_DAY,
      task: makeTask({
        estimate: { p50Min: 120, p90Min: 120 },
        minSessionMin: 5,
        maxSessionMin: 1440,
      }),
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2009-11-01T02:30:00Z', end: '2009-11-01T04:30:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(120);
    expect(availableSlotMinutes(input)).toBe(120);
    expect(
      codes(input, [
        { taskId: 'A', start: '2009-11-01T02:30:00Z', end: '2009-11-01T04:30:00Z' },
      ]),
    ).toEqual([]);
  });
});

describe('ADR-017 30-minute DST in Australia/Lord_Howe', () => {
  it('preserves both repetitions of a 30-minute fold as disjoint intervals', () => {
    const input = makeInput({
      timeZone: 'Australia/Lord_Howe',
      start: '2026-04-04T13:00:00Z',
      end: '2026-04-04T17:00:00Z',
      availability: [
        { weekday: 7, startLocal: '01:45', endLocal: '02:00', kind: 'work' },
      ],
      task: makeTask(),
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2026-04-04T14:45:00Z', end: '2026-04-04T15:00:00Z' },
      { start: '2026-04-04T15:15:00Z', end: '2026-04-04T15:30:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(30);
    expect(availableSlotMinutes(input)).toBe(30);
  });

  it('clips the 30-minute spring gap without inventing wall time', () => {
    const input = makeInput({
      timeZone: 'Australia/Lord_Howe',
      start: '2026-10-03T13:00:00Z',
      end: '2026-10-03T17:00:00Z',
      availability: [
        { weekday: 7, startLocal: '01:45', endLocal: '02:45', kind: 'work' },
      ],
      task: makeTask(),
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2026-10-03T15:15:00Z', end: '2026-10-03T15:45:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(30);
    expect(availableSlotMinutes(input)).toBe(30);
  });
});

describe('ADR-017 minute-level invariants', () => {
  it('projects full-day availability without losing time at a transition', () => {
    const input = makeInput({
      timeZone: 'America/St_Johns',
      start: '2026-11-01T00:00:00Z',
      end: '2026-11-01T06:00:00Z',
      availability: ALL_WEEK_FULL_DAY,
      task: makeTask(),
    });

    expect(slotTotalMin(computeAvailableSlots(input))).toBe(
      (instantMs(input.horizon.end) - instantMs(input.horizon.start)) / MINUTE_MS,
    );
  });
});
