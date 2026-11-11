import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
} from '../src/index.js';
import {
  MAX_HORIZON_DAYS,
  generate,
  validate,
  validateInput,
} from '../src/index.js';

const FULL_WEEK: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
  (weekday) => ({
    weekday: weekday as AvailabilityRule['weekday'],
    startLocal: '00:00',
    endLocal: '24:00',
    kind: 'work' as const,
  }),
);

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
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
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-10T00:00:00Z',
    },
    tasks: [makeTask({ id: 'A' })],
    availability: FULL_WEEK,
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
    seed: 43,
    ...overrides,
  };
}

function codes(input: ScheduleInput): string[] {
  return validateInput(input).map((issue) => issue.code);
}

describe('FU-43 rejection totals are bounded and finite', () => {
  it('keeps all rejection metrics finite and JSON-round-trippable for finite huge inputs', () => {
    const huge = Number.MAX_VALUE;
    const input = makeInput({
      tasks: [
        makeTask({ id: 'A', estimate: { p50Min: huge, p90Min: huge } }),
        makeTask({ id: 'B', estimate: { p50Min: huge, p90Min: huge } }),
        makeTask({ id: 'C', estimate: { p50Min: 1e308, p90Min: 1e308 } }),
      ],
    });
    expect(codes(input)).toContain('invalid_estimate');

    const result = generate(input, { policies: ['front_loaded'], seed: 43 });
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
    expect(candidate.explanation.join(' ')).not.toContain('Infinity');
  });

  it('still rejects non-finite estimates without producing non-finite totals', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: Number.POSITIVE_INFINITY, p90Min: 60 },
        }),
      ],
    });
    const [candidate] = generate(input, {
      policies: ['front_loaded'],
      seed: 43,
    }).candidates;
    expect(candidate?.feasible).toBe(false);
    expect(Number.isFinite(candidate?.deficitMin)).toBe(true);
    expect(JSON.parse(JSON.stringify(candidate))).toEqual(candidate);
  });
});

describe('FU-43 occupied-span cap clips or ignores commitments', () => {
  it('accepts a commitment exactly at the 366-day boundary', () => {
    const horizon = {
      start: '2026-01-01T00:00:00Z',
      end: '2027-01-02T00:00:00Z',
    };
    const input = makeInput({
      now: horizon.start,
      horizon,
      tasks: [makeTask({ id: 'A', estimate: { p50Min: 0, p90Min: 0 } })],
      commitments: [
        { start: horizon.start, end: horizon.end },
      ],
    });
    expect(Date.parse(horizon.end) - Date.parse(horizon.start)).toBe(
      MAX_HORIZON_DAYS * 86_400_000,
    );
    expect(codes(input)).not.toContain('invalid_input');
    expect(generate(input, { policies: ['front_loaded'] }).candidates[0]?.feasible)
      .toBe(true);
  });

  it('ignores long commitments entirely outside the horizon', () => {
    const input = makeInput({
      commitments: [
        { start: '2025-01-01T00:00:00Z', end: '2026-06-01T00:00:00Z' },
        { start: '2027-01-01T00:00:00Z', end: '2028-06-01T00:00:00Z' },
      ],
    });
    expect(codes(input)).not.toContain('invalid_input');
    const [candidate] = generate(input, {
      policies: ['front_loaded'],
      seed: 43,
    }).candidates;
    expect(candidate?.feasible).toBe(true);
  });

  it('clips a long commitment that only partially overlaps the horizon', () => {
    const input = makeInput({
      commitments: [
        { start: '2025-01-01T00:00:00Z', end: '2026-11-09T01:00:00Z' },
      ],
    });
    expect(codes(input)).not.toContain('invalid_input');
    const [candidate] = generate(input, {
      policies: ['front_loaded'],
      seed: 43,
    }).candidates;
    expect(candidate?.feasible).toBe(true);
  });

  it('still rejects an over-span locked block (negative)', () => {
    const input = makeInput({
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-01-01T00:00:00Z',
          end: '2027-06-01T00:00:00Z',
        },
      ],
    });
    expect(codes(input)).toContain('invalid_input');
  });
});

const NESTED_HISTORY: Block[] = [
  {
    taskId: 'H1',
    start: '2026-11-09T23:00:00Z',
    end: '2026-11-10T01:00:00Z',
  },
  {
    taskId: 'H2',
    start: '2026-11-09T23:30:00Z',
    end: '2026-11-10T00:30:00Z',
  },
];

describe('FU-43 nested-history break across midnight and DST', () => {
  it('raises H6 when nested history across local midnight joins an audited block', () => {
    const input = makeInput({
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-11T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 230, p90Min: 230 },
          maxSessionMin: 300,
        }),
      ],
      prefs: {
        maxDailyFocusMin: 480,
        breakAfterMin: 240,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
    });
    const violations = validate(
      input,
      [
        {
          taskId: 'A',
          start: '2026-11-10T01:10:00Z',
          end: '2026-11-10T05:00:00Z',
        },
      ],
      { riskLevel: input.prefs.riskLevel, historyBlocks: NESTED_HISTORY },
    );
    expect(violations.map((violation) => violation.code)).toContain('H6');
  });

  it('raises H6 when nested history across the Lord_Howe fold joins an audited block', () => {
    const history: Block[] = [
      {
        taskId: 'H1',
        start: '2026-04-04T13:00:00Z',
        end: '2026-04-04T16:00:00Z',
      },
      {
        taskId: 'H2',
        start: '2026-04-04T13:30:00Z',
        end: '2026-04-04T14:30:00Z',
      },
    ];
    const input = makeInput({
      timeZone: 'Australia/Lord_Howe',
      horizon: {
        start: '2026-04-04T12:00:00Z',
        end: '2026-04-04T20:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 170, p90Min: 170 },
          maxSessionMin: 300,
        }),
      ],
      prefs: {
        maxDailyFocusMin: 480,
        breakAfterMin: 240,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
    });
    const violations = validate(
      input,
      [
        {
          taskId: 'A',
          start: '2026-04-04T16:10:00Z',
          end: '2026-04-04T19:00:00Z',
        },
      ],
      { riskLevel: input.prefs.riskLevel, historyBlocks: history },
    );
    expect(violations.map((violation) => violation.code)).toContain('H6');
  });
});
