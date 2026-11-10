import type { AvailabilityRule, Block, ExceptionRule, ScheduleInput, Task } from '../src/index.js';
import { computeAvailableSlots, slotTotalMin, validate, validateInput } from '../src/index.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'A',
    dueAt: '2026-11-09T08:00:00Z',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function makeInput(
  options: {
    task?: Task;
    availability?: AvailabilityRule[];
    exceptions?: ExceptionRule[];
  } = {},
): ScheduleInput {
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'Asia/Seoul',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-10T00:00:00Z',
    },
    tasks: [options.task ?? makeTask()],
    availability: options.availability ?? [
      { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
    ],
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
    seed: 101,
  };
}

function codes(input: ScheduleInput, blocks: Block[]): string[] {
  return validate(input, blocks, { riskLevel: input.prefs.riskLevel })
    .map((violation) => violation.code)
    .sort();
}

describe('hard constraint validator', () => {
  it('reports H1 for overlapping blocks', () => {
    const input = makeInput({
      task: makeTask({ estimate: { p50Min: 120, p90Min: 120 } }),
    });
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T01:00:00Z' },
        { taskId: 'A', start: '2026-11-09T00:30:00Z', end: '2026-11-09T01:30:00Z' },
      ]),
    ).toContain('H1');
  });

  it('reports H4 when a block starts before earliestStartAt', () => {
    const input = makeInput({
      task: makeTask({ earliestStartAt: '2026-11-09T01:00:00Z' }),
    });
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T01:00:00Z' },
      ]),
    ).toContain('H4');
  });

  it('reports H5 for a session outside the min/max bounds', () => {
    const input = makeInput({
      task: makeTask({ minSessionMin: 60, maxSessionMin: 120 }),
    });
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T00:30:00Z' },
      ]),
    ).toContain('H5');
  });

  it('reports H5 when a non-splittable task is not one full block', () => {
    const input = makeInput({
      task: makeTask({
        splittable: false,
        estimate: { p50Min: 60, p90Min: 60 },
        minSessionMin: 60,
        maxSessionMin: 60,
      }),
    });
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T00:30:00Z' },
      ]),
    ).toContain('H5');
  });

  it('reports H6 when continuous focus exceeds breakAfterMin without a break', () => {
    const input = makeInput({
      task: makeTask({ estimate: { p50Min: 180, p90Min: 180 } }),
      exceptions: [],
    });
    input.prefs.breakAfterMin = 120;
    input.prefs.breakMin = 15;
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T02:00:00Z' },
        { taskId: 'A', start: '2026-11-09T02:00:00Z', end: '2026-11-09T03:00:00Z' },
      ]),
    ).toContain('H6');
  });

  it('accepts continuous focus that includes a long enough break', () => {
    const input = makeInput({
      task: makeTask({ estimate: { p50Min: 180, p90Min: 180 } }),
    });
    input.prefs.breakAfterMin = 120;
    input.prefs.breakMin = 15;
    const violations = validate(
      input,
      [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T02:00:00Z' },
        { taskId: 'A', start: '2026-11-09T02:15:00Z', end: '2026-11-09T03:15:00Z' },
      ],
      { riskLevel: 'p50' },
    );
    expect(violations.filter((violation) => violation.code === 'H6')).toEqual(
      [],
    );
  });

  it('reports H8 for a block that is not on the 5-minute grid', () => {
    const input = makeInput();
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:03:00Z', end: '2026-11-09T01:00:00Z' },
      ]),
    ).toContain('H8');
  });

  it('adds extra exception windows and subtracts timed off windows', () => {
    const input = makeInput({
      exceptions: [
        { date: '2026-11-09', kind: 'off', startLocal: '10:00', endLocal: '11:00' },
        { date: '2026-11-09', kind: 'extra', startLocal: '18:00', endLocal: '19:00' },
      ],
    });
    const slots = computeAvailableSlots(input);
    expect(slotTotalMin(slots)).toBe(480);
    expect(slots).toHaveLength(3);
  });

  it('rejects an invalid IANA time zone with H8', () => {
    const input = makeInput();
    input.timeZone = 'Not/AZone';
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T01:00:00Z' },
      ]),
    ).toEqual(['H8']);
  });
  it('H2 covers the full block against non-grid-aligned availability', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        estimate: { p50Min: 5, p90Min: 5 },
        minSessionMin: 5,
        maxSessionMin: 5,
      }),
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '09:03', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    expect(computeAvailableSlots(input)).toEqual([]);
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T09:05:00Z' },
      ]),
    ).toEqual(['H2']);
  });

  it('H2 catches a timed off exception inside the block', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        estimate: { p50Min: 5, p90Min: 5 },
        minSessionMin: 5,
        maxSessionMin: 5,
      }),
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      ],
      exceptions: [
        { date: '2026-11-09', kind: 'off', startLocal: '09:01', endLocal: '09:04' },
      ],
    });
    input.timeZone = 'UTC';
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T09:05:00Z' },
      ]),
    ).toEqual(['H2']);
  });

  it('H6 keeps continuous focus runs across local midnight', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-11-10T01:00:00Z',
        estimate: { p50Min: 120, p90Min: 120 },
        minSessionMin: 30,
        maxSessionMin: 120,
      }),
      availability: [
        { weekday: 1, startLocal: '23:00', endLocal: '24:00', kind: 'work' },
        { weekday: 2, startLocal: '00:00', endLocal: '01:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    input.horizon = {
      start: '2026-11-09T22:00:00Z',
      end: '2026-11-10T02:00:00Z',
    };
    input.prefs.breakAfterMin = 90;
    input.prefs.breakMin = 15;
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T23:00:00Z', end: '2026-11-10T01:00:00Z' },
      ]),
    ).toEqual(['H6']);
  });

  it('H6 joins adjacent blocks that meet across local midnight', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-11-10T01:00:00Z',
        estimate: { p50Min: 120, p90Min: 120 },
        minSessionMin: 30,
        maxSessionMin: 120,
      }),
      availability: [
        { weekday: 1, startLocal: '23:00', endLocal: '24:00', kind: 'work' },
        { weekday: 2, startLocal: '00:00', endLocal: '01:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    input.horizon = {
      start: '2026-11-09T22:00:00Z',
      end: '2026-11-10T02:00:00Z',
    };
    input.prefs.breakAfterMin = 90;
    input.prefs.breakMin = 15;
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T23:00:00Z', end: '2026-11-10T00:00:00Z' },
        { taskId: 'A', start: '2026-11-10T00:00:00Z', end: '2026-11-10T01:00:00Z' },
      ]),
    ).toEqual(['H6']);
  });

  it('rejects a candidate block outside the planning horizon', () => {
    const task = makeTask({ estimate: { p50Min: 60, p90Min: 60 } });
    delete task.dueAt;
    delete task.earliestStartAt;
    const input = makeInput({
      task,
      availability: [
        { weekday: 4, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    input.horizon = {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    };
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-12T09:00:00Z', end: '2026-11-12T10:00:00Z' },
      ]),
    ).toEqual(['H0_horizon']);
  });

  it('exempts locked blocks from the horizon check', () => {
    const input = makeInput({
      task: makeTask({ estimate: { p50Min: 120, p90Min: 120 } }),
      availability: [
        { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    input.tasks[0] = makeTask({
      dueAt: '2026-11-10T00:00:00Z',
      estimate: { p50Min: 120, p90Min: 120 },
    });
    input.lockedBlocks = [
      { taskId: 'A', start: '2026-11-08T09:00:00Z', end: '2026-11-08T10:00:00Z' },
    ];
    const result = codes(input, [
      { taskId: 'A', start: '2026-11-09T00:00:00Z', end: '2026-11-09T01:00:00Z' },
    ]);
    expect(result).not.toContain('H0_horizon');
  });

  it('H5 enforces session bounds for non-splittable tasks', () => {
    const input = makeInput({
      task: makeTask({
        splittable: false,
        dueAt: '2026-11-09T12:00:00Z',
        estimate: { p50Min: 120, p90Min: 120 },
        minSessionMin: 30,
        maxSessionMin: 60,
      }),
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '13:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T11:00:00Z' },
      ]),
    ).toEqual(['H5']);
  });

  it('requires overnight single-rule windows to be split at midnight', () => {
    const input = makeInput({
      availability: [
        { weekday: 1, startLocal: '23:00', endLocal: '01:00', kind: 'work' },
      ],
    });
    expect(
      validateInput(input)
        .map((issue) => issue.code)
        .sort(),
    ).toContain('invalid_window');
  });

});
