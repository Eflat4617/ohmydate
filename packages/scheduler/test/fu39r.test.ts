import { performance } from 'node:perf_hooks';
import type {
  AvailabilityRule,
  ScheduleInput,
  Task,
} from '../src/index.js';
import { generate, MAX_INPUT_MINUTES, validate, validateInput } from '../src/index.js';

const MONDAY_1205_1300: AvailabilityRule[] = [
  { weekday: 1, startLocal: '12:05', endLocal: '13:00', kind: 'work' },
];

const MONDAY_0900_1700: AvailabilityRule[] = [
  { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
];

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    dueAt: '2026-11-09T14:00:00Z',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: '2026-11-09T09:00:00Z',
    timeZone: 'UTC',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-09T17:00:00Z',
    },
    tasks: [makeTask({ id: 'A' })],
    availability: MONDAY_0900_1700,
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
    seed: 39,
    ...overrides,
  };
}

const POLICIES = ['front_loaded', 'balanced', 'focus_blocked'] as const;

describe('FU-39R M1: generator H6 with nested occupied intervals', () => {
  function nestedHistoryInput(): ScheduleInput {
    return makeInput({
      now: '2026-11-09T12:05:00Z',
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-09T14:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T14:00:00Z',
          estimate: { p50Min: 30, p90Min: 30 },
          splittable: false,
          minSessionMin: 30,
          maxSessionMin: 30,
        }),
        makeTask({
          id: 'B',
          dueAt: '2026-11-09T14:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 0,
          splittable: false,
          minSessionMin: 60,
          maxSessionMin: 60,
        }),
      ],
      availability: MONDAY_1205_1300,
      existingBlocks: [
        {
          taskId: 'B',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T12:00:00Z',
        },
        {
          taskId: 'B',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T10:30:00Z',
        },
      ],
      prefs: {
        maxDailyFocusMin: 480,
        breakAfterMin: 120,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
      seed: 39,
    });
  }

  it('places the exact repro at or after 12:15 for every policy', () => {
    const input = nestedHistoryInput();
    for (const policy of POLICIES) {
      const [candidate] = generate(input, {
        policies: [policy],
        seed: input.seed,
      }).candidates;
      expect(candidate?.feasible).toBe(true);
      expect(candidate?.blocks).toHaveLength(1);
      const [block] = candidate?.blocks ?? [];
      expect(Date.parse(block?.start ?? '')).toBeGreaterThanOrEqual(
        Date.parse('2026-11-09T12:15:00Z'),
      );
      expect(
        validate(input, candidate?.blocks ?? [], {
          riskLevel: input.prefs.riskLevel,
          historyBlocks: input.existingBlocks ?? [],
        }),
      ).toEqual([]);
    }
  });

  it('accepts exactly breakMin and rejects a shorter gap', () => {
    const input = nestedHistoryInput();
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-09T12:15:00Z',
            end: '2026-11-09T12:45:00Z',
          },
        ],
        { riskLevel: 'p50', historyBlocks: input.existingBlocks ?? [] },
      ),
    ).toEqual([]);
    expect(
      validate(
        input,
        [
          {
            taskId: 'A',
            start: '2026-11-09T12:10:00Z',
            end: '2026-11-09T12:40:00Z',
          },
        ],
        { riskLevel: 'p50', historyBlocks: input.existingBlocks ?? [] },
      ).map((violation) => violation.code),
    ).toContain('H6');
  });
});

describe('FU-39R M3: bufferBeforeDueMin validation', () => {
  function bypassInput(buffer: number): ScheduleInput {
    return makeInput({
      now: '2026-11-09T09:00:00Z',
      horizon: {
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T17:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T10:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
          splittable: false,
          minSessionMin: 120,
          maxSessionMin: 120,
          bufferBeforeDueMin: buffer,
        }),
      ],
    });
  }

  it('rejects the deadline-bypass repro and all invalid buffer values', () => {
    const values = [
      Number.parseFloat('-1e400'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -1,
      1.5,
      MAX_INPUT_MINUTES + 5,
    ];
    for (const value of values) {
      const input = bypassInput(value);
      expect(validateInput(input).map((issue) => issue.code)).toContain(
        'invalid_estimate',
      );
      const [candidate] = generate(input, {
        policies: ['front_loaded'],
        seed: input.seed,
      }).candidates;
      expect(candidate?.feasible).toBe(false);
      expect(candidate?.blocks).toEqual([]);
    }
  });

  it('still accepts a valid buffer', () => {
    expect(validateInput(bypassInput(30))).toEqual([]);
  });
});

describe('FU-39R M4: rejected numeric inputs produce finite JSON metrics', () => {
  function rejectedInput(mutate: (input: ScheduleInput) => void): ScheduleInput {
    const input = makeInput();
    mutate(input);
    return input;
  }

  const cases: Array<[string, (input: ScheduleInput) => void]> = [
    ['p50 Infinity', (input) => {
      input.tasks[0]!.estimate.p50Min = Number.POSITIVE_INFINITY;
    }],
    ['p90 NaN', (input) => {
      input.tasks[0]!.estimate.p90Min = Number.NaN;
    }],
    ['remainingMin Infinity', (input) => {
      input.tasks[0]!.remainingMin = Number.POSITIVE_INFINITY;
    }],
    ['minSessionMin NaN', (input) => {
      input.tasks[0]!.minSessionMin = Number.NaN;
    }],
    ['maxSessionMin Infinity', (input) => {
      input.tasks[0]!.maxSessionMin = Number.POSITIVE_INFINITY;
    }],
    ['bufferBeforeDueMin -Infinity', (input) => {
      input.tasks[0]!.bufferBeforeDueMin = Number.parseFloat('-1e400');
    }],
    ['maxDailyFocusMin Infinity', (input) => {
      input.prefs.maxDailyFocusMin = Number.POSITIVE_INFINITY;
    }],
    ['breakAfterMin NaN', (input) => {
      input.prefs.breakAfterMin = Number.NaN;
    }],
    ['breakMin above cap', (input) => {
      input.prefs.breakMin = MAX_INPUT_MINUTES + 5;
    }],
  ];

  it.each(cases)('%s yields finite metrics and a JSON round trip', (_name, mutate) => {
    const input = rejectedInput(mutate);
    const result = generate(input, {
      policies: ['front_loaded'],
      seed: input.seed,
    });
    const [candidate] = result.candidates;
    expect(candidate).toBeDefined();
    if (candidate === undefined) {
      return;
    }
    expect(candidate.feasible).toBe(false);
    expect(Number.isFinite(candidate.deficitMin)).toBe(true);
    expect(Number.isFinite(candidate.capacityDeficitMin)).toBe(true);
    for (const value of Object.values(candidate.metrics)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(JSON.parse(JSON.stringify(candidate))).toEqual(candidate);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe('FU-39R LOW: absurd horizons and block spans are rejected', () => {
  it('rejects the 9999 horizon repro quickly without throwing', () => {
    const input = makeInput({
      timeZone: 'America/New_York',
      horizon: {
        start: '2026-01-01T00:00:00Z',
        end: '9999-01-01T00:00:00Z',
      },
    });
    expect(validateInput(input).map((issue) => issue.code)).toContain(
      'invalid_input',
    );
    const start = performance.now();
    const result = generate(input, { policies: ['front_loaded'] });
    const elapsedMs = performance.now() - start;
    expect(result.candidates[0]?.feasible).toBe(false);
    expect(result.candidates[0]?.blocks).toEqual([]);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('rejects an occupied block span above the supported horizon', () => {
    const input = makeInput({
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-01-01T00:00:00Z',
          end: '2027-06-01T00:00:00Z',
        },
      ],
    });
    expect(validateInput(input).map((issue) => issue.code)).toContain(
      'invalid_input',
    );
  });
});
