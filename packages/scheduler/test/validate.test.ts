import type { AvailabilityRule, Block, ExceptionRule, ScheduleInput, Task } from '../src/index.js';
import {
  computeAvailableSlots,
  MAX_INPUT_MINUTES,
  slotTotalMin,
  validate,
  validateInput,
} from '../src/index.js';

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

const ALL_WEEK_FULL_DAY: AvailabilityRule[] = [
  { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 2, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 3, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 4, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 5, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 6, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
  { weekday: 7, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
];

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

  it('H5 skips a non-splittable task with no remaining minutes and flags any block', () => {
    const input = makeInput({
      task: makeTask({
        splittable: false,
        dueAt: '2026-11-09T17:00:00Z',
        estimate: { p50Min: 90, p90Min: 90 },
        remainingMin: 0,
        minSessionMin: 90,
        maxSessionMin: 90,
      }),
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';

    expect(codes(input, [])).toEqual([]);
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:30:00Z' },
      ]),
    ).toContain('H5');
  });

  it('exempts history blocks from H4 and H5', () => {
    const input = makeInput({
      task: makeTask({
        splittable: false,
        dueAt: '2026-11-09T12:00:00Z',
        estimate: { p50Min: 60, p90Min: 60 },
        minSessionMin: 60,
        maxSessionMin: 60,
      }),
      availability: [
        { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
      ],
    });
    input.timeZone = 'UTC';
    const history: Block = {
      taskId: 'A',
      start: '2026-11-09T12:30:00Z',
      end: '2026-11-09T13:30:00Z',
    };
    const result = validate(
      input,
      [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
      { riskLevel: 'p50', historyBlocks: [history] },
    ).map((violation) => violation.code);
    expect(result).not.toContain('H4');
    expect(result).not.toContain('H5');
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

  it('H6 rejects a daily-cap overflow after the Santiago midnight gap', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-09-07T06:00:00Z',
        estimate: { p50Min: 150, p90Min: 150 },
        minSessionMin: 30,
        maxSessionMin: 150,
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    input.timeZone = 'America/Santiago';
    input.horizon = {
      start: '2026-09-06T04:00:00Z',
      end: '2026-09-07T06:00:00Z',
    };
    input.prefs.maxDailyFocusMin = 90;
    input.prefs.breakAfterMin = 1440;
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-09-07T02:30:00Z', end: '2026-09-07T05:00:00Z' },
      ]),
    ).toEqual(['H6']);
  });

  it('accepts valid daily loads split by the Santiago midnight gap', () => {
    const input = makeInput({
      task: makeTask({
        dueAt: '2026-09-07T06:00:00Z',
        estimate: { p50Min: 90, p90Min: 90 },
        minSessionMin: 30,
        maxSessionMin: 120,
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    input.timeZone = 'America/Santiago';
    input.horizon = {
      start: '2026-09-06T04:00:00Z',
      end: '2026-09-07T06:00:00Z',
    };
    input.prefs.maxDailyFocusMin = 60;
    input.prefs.breakAfterMin = 1440;
    expect(
      codes(input, [
        { taskId: 'A', start: '2026-09-07T02:30:00Z', end: '2026-09-07T04:00:00Z' },
      ]),
    ).toEqual([]);
  });

  it('rejects candidate and locked blocks for unknown task IDs', () => {
    const candidateInput = makeInput({
      task: makeTask({
        dueAt: '2026-11-11T00:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    candidateInput.timeZone = 'UTC';
    candidateInput.horizon = {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    };
    expect(
      codes(candidateInput, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' },
        { taskId: 'UNKNOWN', start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' },
      ]),
    ).toEqual(['H0_unknown_task']);

    const lockedInput = makeInput({
      task: makeTask({
        dueAt: '2026-11-11T00:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    lockedInput.timeZone = 'UTC';
    lockedInput.horizon = {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    };
    lockedInput.lockedBlocks = [
      { taskId: 'UNKNOWN', start: '2026-11-09T10:00:00Z', end: '2026-11-09T11:00:00Z' },
    ];
    expect(
      codes(lockedInput, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' },
      ]),
    ).toContain('H0_unknown_task');
    expect(
      validateInput(lockedInput)
        .map((issue) => issue.code)
        .sort(),
    ).toContain('unknown_task');
  });

  it('rejects sub-millisecond candidate and locked block precision', () => {
    const candidateInput = makeInput({
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    candidateInput.timeZone = 'UTC';
    expect(
      codes(candidateInput, [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00.000000001Z',
          end: '2026-11-09T10:00:00Z',
        },
      ]),
    ).toContain('H8');

    const lockedInput = makeInput({
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    lockedInput.timeZone = 'UTC';
    lockedInput.lockedBlocks = [
      {
        taskId: 'A',
        start: '2026-11-09T09:00:00.000000001Z',
        end: '2026-11-09T10:00:00Z',
      },
    ];
    expect(
      codes(lockedInput, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' },
      ]),
    ).toContain('H8');
    expect(
      validateInput(lockedInput)
        .map((issue) => issue.code)
        .sort(),
    ).toContain('invalid_precision');

    const offGridLocked = makeInput({
      task: makeTask({
        dueAt: '2026-11-09T10:00:00Z',
        earliestStartAt: '2026-11-09T00:00:00Z',
      }),
      availability: ALL_WEEK_FULL_DAY,
    });
    offGridLocked.timeZone = 'UTC';
    offGridLocked.lockedBlocks = [
      { taskId: 'A', start: '2026-11-09T09:03:00Z', end: '2026-11-09T10:00:00Z' },
    ];
    expect(
      codes(offGridLocked, [
        { taskId: 'A', start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' },
      ]),
    ).toContain('H8');
    expect(
      validateInput(offGridLocked)
        .map((issue) => issue.code)
        .sort(),
    ).toContain('invalid_precision');
  });
});

describe('minute input hardening', () => {
  function issueCodes(input: ScheduleInput): string[] {
    return validateInput(input)
      .map((issue) => issue.code)
      .sort();
  }

  it('rejects NaN, Infinity and 1e400-derived Infinity estimates', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.parseFloat('1e400')]) {
      const input = makeInput({
        task: makeTask({ estimate: { p50Min: value, p90Min: 60 } }),
      });
      expect(issueCodes(input)).toContain('invalid_estimate');
    }
    expect(Number.parseFloat('1e400')).toBe(Number.POSITIVE_INFINITY);
  });

  it('rejects non-finite and non-integer remainingMin and session bounds', () => {
    expect(
      issueCodes(
        makeInput({
          task: makeTask({ remainingMin: Number.POSITIVE_INFINITY }),
        }),
      ),
    ).toContain('invalid_estimate');
    expect(
      issueCodes(
        makeInput({
          task: makeTask({ remainingMin: 60.5 }),
        }),
      ),
    ).toContain('invalid_estimate');
    expect(
      issueCodes(
        makeInput({
          task: makeTask({ minSessionMin: 30.5 }),
        }),
      ),
    ).toContain('invalid_estimate');
    expect(
      issueCodes(
        makeInput({
          task: makeTask({ maxSessionMin: Number.NaN }),
        }),
      ),
    ).toContain('invalid_estimate');
  });

  it('rejects non-finite, non-integer and above-cap preference minutes', () => {
    for (const override of [
      { maxDailyFocusMin: Number.POSITIVE_INFINITY },
      { maxDailyFocusMin: Number.NaN },
      { breakAfterMin: 120.5 },
      { breakMin: 15.5 },
      { breakAfterMin: MAX_INPUT_MINUTES + 5 },
    ]) {
      const input = makeInput();
      input.prefs = { ...input.prefs, ...override };
      expect(issueCodes(input)).toContain('invalid_input');
    }
  });

  it('accepts whole minutes at the documented upper cap and rejects one above it', () => {
    const atCap = makeInput({
      task: makeTask({
        estimate: { p50Min: MAX_INPUT_MINUTES, p90Min: MAX_INPUT_MINUTES },
      }),
    });
    expect(issueCodes(atCap)).not.toContain('invalid_estimate');

    const aboveCap = makeInput({
      task: makeTask({
        estimate: { p50Min: MAX_INPUT_MINUTES + 5, p90Min: MAX_INPUT_MINUTES },
      }),
    });
    expect(issueCodes(aboveCap)).toContain('invalid_estimate');
  });
});
