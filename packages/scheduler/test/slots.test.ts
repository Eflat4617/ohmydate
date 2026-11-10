import type { AvailabilityRule, ExceptionRule, ScheduleInput, Task } from '../src/index.js';
import {
  computeAvailableSlots,
  slotTotalMin,
  validate,
} from '../src/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'A',
    dueAt: '2026-03-08T10:00:00Z',
    estimate: { p50Min: 30, p90Min: 30 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 45,
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
  task?: Task;
  exceptions?: ExceptionRule[];
}): ScheduleInput {
  return {
    now: options.start,
    timeZone: options.timeZone,
    horizon: { start: options.start, end: options.end },
    tasks: [options.task ?? makeTask()],
    availability: options.availability,
    exceptions: options.exceptions ?? [],
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
    seed: 202,
  };
}

describe('DST wall-clock projection', () => {
  it('clips the New York spring-forward gap', () => {
    const input = makeInput({
      timeZone: 'America/New_York',
      start: '2026-03-08T05:00:00Z',
      end: '2026-03-08T10:00:00Z',
      availability: [
        { weekday: 7, startLocal: '02:30', endLocal: '03:30', kind: 'work' },
      ],
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2026-03-08T07:00:00Z', end: '2026-03-08T07:30:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(30);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-03-08T07:00:00Z',
            end: '2026-03-08T07:30:00Z',
          },
        ],
        { riskLevel: 'p50' },
      ),
    ).toEqual([]);
  });

  it('preserves both repetitions of the New York autumn fold as disjoint intervals', () => {
    const input = makeInput({
      timeZone: 'America/New_York',
      start: '2026-11-01T04:00:00Z',
      end: '2026-11-01T08:00:00Z',
      availability: [
        { weekday: 7, startLocal: '01:15', endLocal: '01:45', kind: 'work' },
      ],
      task: makeTask({
        dueAt: '2026-11-01T08:00:00Z',
        estimate: { p50Min: 60, p90Min: 60 },
      }),
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2026-11-01T05:15:00Z', end: '2026-11-01T05:45:00Z' },
      { start: '2026-11-01T06:15:00Z', end: '2026-11-01T06:45:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(60);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-01T05:15:00Z',
            end: '2026-11-01T05:45:00Z',
          },
          {
            taskId: 'A',
            start: '2026-11-01T06:15:00Z',
            end: '2026-11-01T06:45:00Z',
          },
        ],
        { riskLevel: 'p50' },
      ),
    ).toEqual([]);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-01T05:45:00Z',
            end: '2026-11-01T06:15:00Z',
          },
        ],
        { riskLevel: 'p50' },
      ).some((violation) => violation.code === 'H2'),
    ).toBe(true);
  });

  it('does not assume weekly rules are grid-aligned', () => {
    const input = makeInput({
      timeZone: 'UTC',
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-10T00:00:00Z',
      availability: [
        { weekday: 1, startLocal: '09:02', endLocal: '09:12', kind: 'work' },
      ],
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        estimate: { p50Min: 5, p90Min: 5 },
        minSessionMin: 5,
        maxSessionMin: 5,
      }),
    });

    expect(computeAvailableSlots(input)).toEqual([
      { start: '2026-11-09T09:05:00Z', end: '2026-11-09T09:10:00Z' },
    ]);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-09T09:05:00Z',
            end: '2026-11-09T09:10:00Z',
          },
        ],
        { riskLevel: 'p50' },
      ),
    ).toEqual([]);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-09T09:10:00Z',
            end: '2026-11-09T09:15:00Z',
          },
        ],
        { riskLevel: 'p50' },
      ).some((violation) => violation.code === 'H2'),
    ).toBe(true);
  });
  it('applies exact fold projection to timed off exceptions', () => {
    const input = makeInput({
      timeZone: 'America/New_York',
      start: '2026-11-01T04:00:00Z',
      end: '2026-11-01T09:30:00Z',
      availability: [
        { weekday: 7, startLocal: '00:00', endLocal: '04:00', kind: 'work' },
      ],
      exceptions: [
        {
          date: '2026-11-01',
          kind: 'off',
          startLocal: '01:15',
          endLocal: '01:45',
        },
      ],
    });

    const slots = computeAvailableSlots(input);
    expect(slots).toEqual([
      { start: '2026-11-01T04:00:00Z', end: '2026-11-01T05:15:00Z' },
      { start: '2026-11-01T05:45:00Z', end: '2026-11-01T06:15:00Z' },
      { start: '2026-11-01T06:45:00Z', end: '2026-11-01T09:00:00Z' },
    ]);
    expect(slotTotalMin(slots)).toBe(240);
  });

  it('applies gap clipping to timed extra exceptions', () => {
    const input = makeInput({
      timeZone: 'America/New_York',
      start: '2026-03-08T05:00:00Z',
      end: '2026-03-08T08:00:00Z',
      availability: [
        { weekday: 7, startLocal: '00:00', endLocal: '02:00', kind: 'work' },
      ],
      exceptions: [
        {
          date: '2026-03-08',
          kind: 'extra',
          startLocal: '02:30',
          endLocal: '03:30',
        },
      ],
    });

    expect(computeAvailableSlots(input)).toEqual([
      { start: '2026-03-08T05:00:00Z', end: '2026-03-08T07:30:00Z' },
    ]);
  });

});
