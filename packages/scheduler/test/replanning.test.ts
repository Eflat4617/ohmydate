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

function effectiveInput(input: ScheduleInput): ScheduleInput {
  const nowMs = Date.parse(input.now);
  const fixed = (input.existingBlocks ?? []).filter(
    (block) => Date.parse(block.start) < nowMs,
  );
  return { ...input, lockedBlocks: [...input.lockedBlocks, ...fixed] };
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
        validate(effectiveInput(input), candidate.blocks, {
          riskLevel: input.prefs.riskLevel,
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
});
