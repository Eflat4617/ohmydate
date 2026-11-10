import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
} from '../src/index.js';
import { generate, validate } from '../src/index.js';

const MONDAY_0900_1700: AvailabilityRule[] = [
  { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
];

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    dueAt: '2026-11-09T17:00:00Z',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 15,
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
    tasks: [],
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
    seed: 4004,
    ...overrides,
  };
}

function historyBlocksOf(input: ScheduleInput): Block[] {
  const nowMs = Date.parse(input.now);
  return (input.existingBlocks ?? []).filter(
    (block) => Date.parse(block.start) < nowMs,
  );
}

function blockKey(block: Block): string {
  return `${block.taskId}|${block.start}|${block.end}`;
}

describe('replanning from now', () => {
  it('fixes past/in-progress existing blocks and never places before now (P1)', () => {
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 180, p90Min: 180 },
        }),
        makeTask({ id: 'B', priority: 2 }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
        {
          taskId: 'A',
          start: '2026-11-09T11:30:00Z',
          end: '2026-11-09T12:30:00Z',
        },
        {
          taskId: 'B',
          start: '2026-11-09T14:00:00Z',
          end: '2026-11-09T15:00:00Z',
        },
      ],
    });
    const nowMs = Date.parse(input.now);
    const result = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: input.seed,
    });
    expect(result.candidates.length).toBeGreaterThan(0);

    for (const candidate of result.candidates) {
      expect(candidate.feasible).toBe(true);
      for (const block of candidate.blocks) {
        expect(Date.parse(block.start)).toBeGreaterThanOrEqual(nowMs);
      }
      expect(
        candidate.blocks.some(
          (block) =>
            block.taskId === 'B' &&
            block.start === '2026-11-09T14:00:00Z' &&
            block.end === '2026-11-09T15:00:00Z',
        ),
      ).toBe(true);
      expect(
        candidate.blocks.some(
          (block) => block.start === '2026-11-09T10:00:00Z',
        ),
      ).toBe(false);
      expect(
        candidate.blocks.some(
          (block) => block.start === '2026-11-09T11:30:00Z',
        ),
      ).toBe(false);
      expect(
        validate(input, candidate.blocks, {
          riskLevel: input.prefs.riskLevel,
          historyBlocks: historyBlocksOf(input),
        }),
      ).toEqual([]);
    }
  });

  it('clips a brand-new placement to now even without existing blocks (negative)', () => {
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [makeTask({ id: 'A' })],
    });
    const result = generate(input, { policies: ['front_loaded'] });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.blocks).toHaveLength(1);
    const [block] = candidate?.blocks ?? [];
    expect(block?.start).toBe('2026-11-09T12:00:00Z');
    expect(block?.end).toBe('2026-11-09T13:00:00Z');
  });

  it('re-places only the affected task in R1 and keeps untouched blocks', () => {
    const existing: Block[] = [
      {
        taskId: 'A',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
      },
      {
        taskId: 'B',
        start: '2026-11-09T11:00:00Z',
        end: '2026-11-09T12:00:00Z',
      },
      {
        taskId: 'C',
        start: '2026-11-09T14:00:00Z',
        end: '2026-11-09T15:00:00Z',
      },
    ];
    const input = makeInput({
      tasks: [makeTask({ id: 'A' }), makeTask({ id: 'B' }), makeTask({ id: 'C' })],
      commitments: [
        { start: '2026-11-09T11:00:00Z', end: '2026-11-09T12:00:00Z' },
      ],
      existingBlocks: existing,
    });

    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      expect(candidate?.metrics.changedBlocks).toBeLessThanOrEqual(3);
      expect(candidate?.metrics.changedBlocks).toBeGreaterThanOrEqual(2);
      const keys = new Set((candidate?.blocks ?? []).map(blockKey));
      expect(keys.has(blockKey(existing[0] as Block))).toBe(true);
      expect(keys.has(blockKey(existing[2] as Block))).toBe(true);
      expect(keys.has(blockKey(existing[1] as Block))).toBe(false);
      if (policy === 'front_loaded') {
        expect(candidate?.metrics.changedBlocks).toBe(2);
      }
    }
  });

  it('returns changedBlocks 0 for an unchanged replan in every policy', () => {
    const existing: Block[] = [
      {
        taskId: 'A',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
      },
      {
        taskId: 'B',
        start: '2026-11-09T11:00:00Z',
        end: '2026-11-09T12:00:00Z',
      },
      {
        taskId: 'C',
        start: '2026-11-09T14:00:00Z',
        end: '2026-11-09T15:00:00Z',
      },
    ];
    const input = makeInput({
      tasks: [makeTask({ id: 'A' }), makeTask({ id: 'B' }), makeTask({ id: 'C' })],
      existingBlocks: existing,
    });

    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      expect(candidate?.metrics.changedBlocks).toBe(0);
      expect((candidate?.blocks ?? []).map(blockKey).sort()).toEqual(
        existing.map(blockKey).sort(),
      );
    }
  });

  it('keeps G04 minimisation bounded when the commitment overlaps an existing block', () => {
    const input = makeInput({
      now: '2026-11-09T00:00:00Z',
      timeZone: 'Asia/Seoul',
      tasks: [makeTask({ id: 'A' })],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
      commitments: [
        { start: '2026-11-09T00:30:00Z', end: '2026-11-09T01:30:00Z' },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T00:00:00Z',
          end: '2026-11-09T01:00:00Z',
        },
      ],
    });
    const result = generate(input, { policies: ['front_loaded'], seed: input.seed });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.metrics.changedBlocks).toBe(2);
    expect(candidate?.blocks).toEqual([
      {
        taskId: 'A',
        start: '2026-11-09T01:30:00Z',
        end: '2026-11-09T02:30:00Z',
      },
    ]);
  });
});

describe('replan degradation', () => {
  it('keeps a conflicting existing block as an affected, re-placed task', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
      ],
      commitments: [
        { start: '2026-11-09T09:00:00Z', end: '2026-11-09T10:00:00Z' },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
    });
    const result = generate(input, { policies: ['front_loaded'], seed: input.seed });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.metrics.changedBlocks).toBe(2);
    expect(candidate?.blocks).toEqual([
      {
        taskId: 'A',
        start: '2026-11-09T10:00:00Z',
        end: '2026-11-09T12:00:00Z',
      },
    ]);
  });

  it('excludes locked blocks from changedBlocks', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
      ],
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T14:00:00Z',
          end: '2026-11-09T15:00:00Z',
        },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
    });
    const result = generate(input, { policies: ['front_loaded'], seed: input.seed });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(candidate?.metrics.changedBlocks).toBe(0);
  });

  it('N10: releases a seed whose remainder is below minSessionMin', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 90, p90Min: 90 },
          minSessionMin: 45,
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
    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      expect(candidate?.blocks).toEqual([
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:30:00Z',
        },
      ]);
    }
  });

  it('N6: releases a grown task seed when its successor is seeded', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
        makeTask({ id: 'B', dependsOn: ['A'] }),
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
        {
          taskId: 'B',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
    });
    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      const aBlocks = (candidate?.blocks ?? []).filter(
        (block) => block.taskId === 'A',
      );
      const bBlocks = (candidate?.blocks ?? []).filter(
        (block) => block.taskId === 'B',
      );
      const aEnd = Math.max(
        ...aBlocks.map((block) => Date.parse(block.end)),
      );
      const bStart = Math.min(
        ...bBlocks.map((block) => Date.parse(block.start)),
      );
      expect(bStart).toBeGreaterThanOrEqual(aEnd);
    }
  });

  it('N5: releases a seed that precedes a newly added dependency', () => {
    const input = makeInput({
      tasks: [
        makeTask({ id: 'A' }),
        makeTask({ id: 'B', dependsOn: ['A'] }),
      ],
      existingBlocks: [
        {
          taskId: 'B',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
        {
          taskId: 'A',
          start: '2026-11-09T11:00:00Z',
          end: '2026-11-09T12:00:00Z',
        },
      ],
    });
    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      const a = (candidate?.blocks ?? []).find((block) => block.taskId === 'A');
      const b = (candidate?.blocks ?? []).find((block) => block.taskId === 'B');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(Date.parse(b?.start ?? '')).toBeGreaterThanOrEqual(
        Date.parse(a?.end ?? ''),
      );
    }
  });

  it('treats past blocks as history for H2 and remainingMin (N2, N3, N3b)', () => {
    const history: Block = {
      taskId: 'A',
      start: '2026-11-09T09:00:00Z',
      end: '2026-11-09T10:00:00Z',
    };

    const n2 = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [makeTask({ id: 'A' })],
      availability: [
        { weekday: 1, startLocal: '10:00', endLocal: '17:00', kind: 'work' },
      ],
      existingBlocks: [history],
    });
    const n2Result = generate(n2, { policies: ['front_loaded'], seed: n2.seed });
    expect(n2Result.candidates[0]?.feasible).toBe(true);
    expect(n2Result.candidates[0]?.blocks).toEqual([
      {
        taskId: 'A',
        start: '2026-11-09T12:00:00Z',
        end: '2026-11-09T13:00:00Z',
      },
    ]);

    const future: Block = {
      taskId: 'A',
      start: '2026-11-09T13:00:00Z',
      end: '2026-11-09T14:00:00Z',
    };
    const n3 = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [makeTask({ id: 'A', remainingMin: 60 })],
      existingBlocks: [history, future],
    });
    const n3Result = generate(n3, { policies: ['front_loaded'], seed: n3.seed });
    expect(n3Result.candidates[0]?.feasible).toBe(true);
    expect(n3Result.candidates[0]?.blocks).toEqual([future]);
    expect(n3Result.candidates[0]?.metrics.changedBlocks).toBe(0);

    const n3b = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [
        makeTask({
          id: 'A',
          remainingMin: 30,
          minSessionMin: 30,
        }),
      ],
      existingBlocks: [history, future],
    });
    const n3bResult = generate(n3b, {
      policies: ['front_loaded'],
      seed: n3b.seed,
    });
    const n3bCandidate = n3bResult.candidates[0];
    expect(n3bCandidate?.feasible).toBe(true);
    expect(n3bCandidate?.blocks).toHaveLength(1);
    const n3bBlock = n3bCandidate?.blocks[0];
    expect(n3bBlock).toBeDefined();
    expect(Date.parse(n3bBlock?.start ?? '')).toBeGreaterThanOrEqual(
      Date.parse('2026-11-09T12:00:00Z'),
    );
    expect(
      Date.parse(n3bBlock?.end ?? '') - Date.parse(n3bBlock?.start ?? ''),
    ).toBe(30 * 60 * 1000);
  });

  it('does not audit a past block against a new full-day off exception', () => {
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-11T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-10T17:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
        { weekday: 2, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
      exceptions: [{ date: '2026-11-09', kind: 'off' }],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
    });
    const result = generate(input, { policies: ['front_loaded'], seed: input.seed });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(true);
    expect(
      (candidate?.blocks ?? []).every(
        (block) => Date.parse(block.start) >= Date.parse('2026-11-10T00:00:00Z'),
      ),
    ).toBe(true);
  });

  it('counts history for H1 and H6 but not for H2/H4/H5', () => {
    const history: Block = {
      taskId: 'A',
      start: '2026-11-09T09:00:00Z',
      end: '2026-11-09T10:00:00Z',
    };
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [makeTask({ id: 'A' })],
      availability: [
        { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
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

    const h6 = validate(
      input,
      [
        {
          taskId: 'A',
          start: '2026-11-09T12:00:00Z',
          end: '2026-11-09T13:00:00Z',
        },
      ],
      { riskLevel: input.prefs.riskLevel, historyBlocks: [history] },
    );
    expect(h6.map((violation) => violation.code)).toContain('H6');

    const h1 = validate(
      input,
      [
        {
          taskId: 'A',
          start: '2026-11-09T09:30:00Z',
          end: '2026-11-09T10:30:00Z',
        },
      ],
      { riskLevel: input.prefs.riskLevel, historyBlocks: [history] },
    );
    expect(h1.map((violation) => violation.code)).toContain('H1');
  });

  it('N16: a non-splittable task in progress needs no block (remainingMin=0)', () => {
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      tasks: [
        makeTask({
          id: 'A',
          splittable: false,
          estimate: { p50Min: 90, p90Min: 90 },
          remainingMin: 0,
          minSessionMin: 90,
          maxSessionMin: 90,
        }),
        makeTask({ id: 'B', priority: 2 }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T11:00:00Z',
          end: '2026-11-09T12:30:00Z',
        },
      ],
    });

    for (const policy of [
      'front_loaded',
      'balanced',
      'focus_blocked',
    ] as const) {
      const result = generate(input, { policies: [policy], seed: input.seed });
      const [candidate] = result.candidates;
      expect(candidate?.feasible).toBe(true);
      expect(
        (candidate?.blocks ?? []).filter((block) => block.taskId === 'A'),
      ).toEqual([]);
      const bBlocks = (candidate?.blocks ?? []).filter(
        (block) => block.taskId === 'B',
      );
      expect(bBlocks.length).toBeGreaterThan(0);
      for (const block of bBlocks) {
        expect(Date.parse(block.start)).toBeGreaterThanOrEqual(
          Date.parse('2026-11-09T12:30:00Z'),
        );
      }
    }
  });
});
