import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
} from '../src/index.js';
import { generate, validate } from '../src/index.js';

const MON_TUE_0900_1700: AvailabilityRule[] = [1, 2].map((weekday) => ({
  weekday: weekday as AvailabilityRule['weekday'],
  startLocal: '09:00',
  endLocal: '17:00',
  kind: 'work' as const,
}));

const ALL_WEEK_FULL_DAY: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
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
    now: '2026-11-09T12:00:00Z',
    timeZone: 'UTC',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    },
    tasks: [],
    availability: MON_TUE_0900_1700,
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
    ...overrides,
  };
}

function historyBlocksOf(input: ScheduleInput): Block[] {
  const nowMs = Date.parse(input.now);
  return (input.existingBlocks ?? []).filter(
    (block) => Date.parse(block.start) < nowMs,
  );
}

function codes(input: ScheduleInput, blocks: Block[]): string[] {
  return validate(input, blocks, {
    riskLevel: input.prefs.riskLevel,
    historyBlocks: historyBlocksOf(input),
  })
    .map((violation) => violation.code)
    .sort();
}

const POLICIES = ['front_loaded', 'balanced', 'focus_blocked'] as const;

function expectAllPoliciesFeasible(input: ScheduleInput): void {
  for (const policy of POLICIES) {
    const result = generate(input, { policies: [policy], seed: input.seed });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.blocks.length).toBeGreaterThan(0);
    expect(
      validate(input, candidate?.blocks ?? [], {
        riskLevel: input.prefs.riskLevel,
        historyBlocks: historyBlocksOf(input),
      }),
    ).toEqual([]);
  }
}

describe('history-only H1/H6 exemption (06 §7.1, C1-C5)', () => {
  it('C1: an in-progress history block overlapping a new commitment is feasible', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-10T17:00:00Z',
          estimate: { p50Min: 180, p90Min: 180 },
          remainingMin: 120,
        }),
      ],
      commitments: [
        {
          start: '2026-11-09T12:15:00Z',
          end: '2026-11-09T13:00:00Z',
        },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T11:30:00Z',
          end: '2026-11-09T12:30:00Z',
        },
      ],
    });

    expectAllPoliciesFeasible(input);
    for (const policy of POLICIES) {
      const [candidate] = generate(input, {
        policies: [policy],
        seed: input.seed,
      }).candidates;
      for (const block of candidate?.blocks ?? []) {
        expect(Date.parse(block.start)).toBeGreaterThanOrEqual(
          Date.parse('2026-11-09T13:00:00Z'),
        );
      }
    }
  });

  it('C2: a past commitment overlapping past history is feasible', () => {
    const input = makeInput({
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 60,
        }),
      ],
      commitments: [
        {
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
    });

    expectAllPoliciesFeasible(input);
  });

  it('C3: a past day whose history exceeds the lowered cap is feasible', () => {
    const input = makeInput({
      horizon: {
        start: '2026-11-08T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 60,
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-08T09:00:00Z',
          end: '2026-11-08T14:00:00Z',
        },
      ],
      prefs: {
        maxDailyFocusMin: 240,
        breakAfterMin: 480,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
    });

    expectAllPoliciesFeasible(input);
    const [candidate] = generate(input, {
      policies: ['front_loaded'],
      seed: input.seed,
    }).candidates;
    expect(
      (candidate?.blocks ?? []).every(
        (block) => Date.parse(block.start) >= Date.parse(input.now),
      ),
    ).toBe(true);
  });

  it('C3b: today history above the cap is feasible when the plan moves to another day', () => {
    const input = makeInput({
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-11T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-10T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 60,
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T12:00:00Z',
        },
      ],
      prefs: {
        maxDailyFocusMin: 120,
        breakAfterMin: 480,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
    });

    expectAllPoliciesFeasible(input);
    for (const policy of POLICIES) {
      const [candidate] = generate(input, {
        policies: [policy],
        seed: input.seed,
      }).candidates;
      expect(
        (candidate?.blocks ?? []).every(
          (block) =>
            Date.parse(block.start) >= Date.parse('2026-11-10T00:00:00Z'),
        ),
      ).toBe(true);
    }
  });

  it('C4: a history-only run above the lowered breakAfter is feasible', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-10T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
          remainingMin: 60,
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T12:00:00Z',
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
    });

    expectAllPoliciesFeasible(input);
  });

  it('C5: a locked block over in-progress history is feasible', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-10T17:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
          remainingMin: 120,
        }),
      ],
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T12:00:00Z',
          end: '2026-11-09T13:00:00Z',
        },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T11:30:00Z',
          end: '2026-11-09T12:30:00Z',
        },
      ],
    });

    expectAllPoliciesFeasible(input);
  });
});

describe('history exemption negatives', () => {
  it('an audited block overlapping history still raises H1', () => {
    const input = makeInput({
      availability: ALL_WEEK_FULL_DAY,
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
    });

    expect(
      codes(input, [
        {
          taskId: 'A',
          start: '2026-11-09T09:30:00Z',
          end: '2026-11-09T10:30:00Z',
        },
      ]),
    ).toContain('H1');
  });

  it('an audited block on a history-heavy day still raises H6 when history plus audited exceeds the cap', () => {
    const input = makeInput({
      availability: ALL_WEEK_FULL_DAY,
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 60, p90Min: 60 },
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
      prefs: {
        maxDailyFocusMin: 90,
        breakAfterMin: 480,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
    });

    expect(
      codes(input, [
        {
          taskId: 'A',
          start: '2026-11-09T12:00:00Z',
          end: '2026-11-09T13:00:00Z',
        },
      ]),
    ).toContain('H6');
  });

  it('a break run that joins history into an audited block still raises H6', () => {
    const input = makeInput({
      availability: ALL_WEEK_FULL_DAY,
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 90, p90Min: 90 },
          minSessionMin: 90,
          maxSessionMin: 90,
        }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T11:00:00Z',
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
    });

    expect(
      codes(input, [
        {
          taskId: 'A',
          start: '2026-11-09T11:00:00Z',
          end: '2026-11-09T12:30:00Z',
        },
      ]),
    ).toContain('H6');
  });
});
