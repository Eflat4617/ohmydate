import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
} from '../src/index.js';
import {
  generate,
  GENERATOR_VERSION,
  POLICIES,
  POLICY_VERSION,
  validate,
} from '../src/index.js';
import { canonicalJson, sha256Hex } from '../src/hash.js';

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
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    },
    tasks: [makeTask({ id: 'A' })],
    availability: ALL_WEEK_FULL_DAY,
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
    seed: 902,
    ...overrides,
  };
}

describe('plan generator', () => {
  it('publishes the weights from 06 §4', () => {
    expect(POLICY_VERSION).toBe('1.0.0');
    expect(POLICIES.front_loaded.weights).toEqual({
      s1EarlyCompletion: 1.0,
      s2DailySpread: 0.1,
      s3PreferredWindows: 0.2,
      s4ContextSwitches: 0.3,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.6,
    });
    expect(POLICIES.balanced.weights).toEqual({
      s1EarlyCompletion: 0.2,
      s2DailySpread: 1.0,
      s3PreferredWindows: 0.3,
      s4ContextSwitches: 0.3,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.4,
    });
    expect(POLICIES.focus_blocked.weights).toEqual({
      s1EarlyCompletion: 0.3,
      s2DailySpread: 0.3,
      s3PreferredWindows: 0.8,
      s4ContextSwitches: 1.0,
      s5RetainExisting: 0.5,
      s6MinSlack: 0.4,
    });
  });

  it('is byte-identical for the same input and seed', () => {
    const input = makeInput({
      tasks: [
        makeTask({ id: 'A', estimate: { p50Min: 90, p90Min: 120 } }),
        makeTask({ id: 'B', dependsOn: ['A'] }),
      ],
    });
    const first = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: 7,
    });
    const second = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: 7,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const candidate of first.candidates) {
      expect(candidate.generatorVersion).toBe(GENERATOR_VERSION);
      expect(candidate.inputHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('uses a pure SHA-256 and canonical JSON', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}',
    );
    const input = makeInput();
    const reordered = {
      seed: input.seed,
      prefs: input.prefs,
      lockedBlocks: input.lockedBlocks,
      commitments: input.commitments,
      exceptions: input.exceptions,
      availability: input.availability,
      tasks: input.tasks,
      horizon: input.horizon,
      timeZone: input.timeZone,
      now: input.now,
    } as ScheduleInput;
    expect(sha256Hex(canonicalJson(reordered))).toBe(
      sha256Hex(canonicalJson(input)),
    );
  });

  it('returns at most one candidate per requested policy and never more than three', () => {
    const input = makeInput();
    const single = generate(input, {
      policies: ['balanced', 'balanced'],
      seed: input.seed,
    });
    expect(single.candidates).toHaveLength(1);
    expect(single.candidates[0]?.policy).toBe('balanced');

    const all = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: input.seed,
    });
    expect(all.candidates.length).toBeLessThanOrEqual(3);
    expect(new Set(all.candidates.map((candidate) => candidate.policy)).size).toBe(
      all.candidates.length,
    );
  });

  it('rejects impossible inputs without planning blocks', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          earliestStartAt: '2026-11-09T05:00:00Z',
          dueAt: '2026-11-09T04:00:00Z',
        }),
      ],
    });
    const result = generate(input, { policies: ['front_loaded'] });
    expect(result.candidates).toHaveLength(1);
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(false);
    expect(candidate?.blocks).toEqual([]);
    expect(candidate?.explanation.some((line) => line.includes('invalid_window'))).toBe(
      true,
    );
  });

  it('keeps locked blocks fixed and reports changedBlocks against the full plan', () => {
    const locked: Block[] = [
      {
        taskId: 'A',
        start: '2026-11-09T09:00:00Z',
        end: '2026-11-09T10:00:00Z',
      },
    ];
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T23:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
      ],
      lockedBlocks: locked,
      existingBlocks: [
        ...locked,
        {
          taskId: 'A',
          start: '2026-11-09T10:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
    });

    const result = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: input.seed,
    });
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.feasible).toBe(true);
      expect(
        candidate.blocks.some(
          (block) =>
            block.taskId === 'A' &&
            block.start === locked[0]?.start &&
            block.end === locked[0]?.end,
        ),
      ).toBe(false);
      expect(candidate.metrics.changedBlocks).toBe(0);
      expect(
        validate(input, candidate.blocks, {
          riskLevel: input.prefs.riskLevel,
        }),
      ).toEqual([]);
    }
  });

  it('derives daily metrics and context switches from the placed blocks', () => {
    const input = makeInput({
      timeZone: 'Asia/Seoul',
      tasks: [makeTask({ id: 'A' }), makeTask({ id: 'B' })],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
        { weekday: 2, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
    });
    const result = generate(input, {
      policies: ['front_loaded', 'balanced'],
      seed: input.seed,
    });
    const front = result.candidates.find(
      (candidate) => candidate.policy === 'front_loaded',
    );
    const balanced = result.candidates.find(
      (candidate) => candidate.policy === 'balanced',
    );
    expect(front?.metrics.totalFocusMin).toBe(120);
    expect(front?.metrics.p90CoverageRatio).toBe(1);
    expect(balanced?.metrics.maxDailyLoadMin).toBeLessThanOrEqual(60);
    expect(balanced?.metrics.avgDailyLoadMin).toBe(60);
    expect(balanced?.metrics.contextSwitches).toBe(0);
  });

  it('never hides hard violations on an infeasible candidate', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 180, p90Min: 180 },
          splittable: false,
          minSessionMin: 180,
          maxSessionMin: 180,
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '11:00', kind: 'work' },
      ],
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
    });
    const result = generate(input, { policies: ['front_loaded'] });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(false);
    expect(candidate?.deficitMin).toBe(180);
    expect(candidate?.capacityDeficitMin).toBe(60);
    expect(candidate?.explanation.join('\n')).toContain('H7');
    expect(
      candidate?.explanation.some((line) => line.includes('no_contiguous_window')),
    ).toBe(true);
  });

  it('skips local improvement without changing feasibility', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'A', estimate: { p50Min: 90, p90Min: 90 } })],
    });
    const withImprovement = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: input.seed,
    });
    const withoutImprovement = generate(input, {
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
      seed: input.seed,
      maxLocalImprovement: 0,
    });
    expect(
      withoutImprovement.candidates.map((candidate) => candidate.feasible),
    ).toEqual(
      withImprovement.candidates.map((candidate) => candidate.feasible),
    );
    for (const candidate of withoutImprovement.candidates) {
      if (candidate.feasible) {
        expect(
          validate(input, candidate.blocks, {
            riskLevel: input.prefs.riskLevel,
          }),
        ).toEqual([]);
      }
    }
  });

  it('lets a feasible candidate win a diversity collision (E1)', () => {
    const input = makeInput({
      timeZone: 'UTC',
      tasks: [
        makeTask({
          id: 'Z',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 420, p90Min: 420 },
          priority: 1,
        }),
        makeTask({
          id: 'Y',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 20, p90Min: 20 },
          splittable: false,
          minSessionMin: 20,
          maxSessionMin: 20,
          priority: 4,
        }),
      ],
      availability: ALL_WEEK_FULL_DAY.map((rule) => ({
        ...rule,
        startLocal: '09:00',
        endLocal: '17:00',
      })),
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
    });
    const result = generate(input, {
      policies: ['balanced', 'focus_blocked'],
      seed: input.seed,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.policy).toBe('focus_blocked');
    expect(result.candidates[0]?.feasible).toBe(true);
  });

  it('hashes the effective seed and maxLocalImprovement', () => {
    const input = makeInput({
      tasks: [makeTask({ id: 'A', estimate: { p50Min: 90, p90Min: 90 } })],
    });
    const base = generate(input, { policies: ['balanced'], seed: 5 });
    const otherSeed = generate(input, { policies: ['balanced'], seed: 6 });
    const otherImprovement = generate(input, {
      policies: ['balanced'],
      seed: 5,
      maxLocalImprovement: 0,
    });
    expect(base.candidates[0]?.inputHash).not.toBe(
      otherSeed.candidates[0]?.inputHash,
    );
    expect(base.candidates[0]?.inputHash).not.toBe(
      otherImprovement.candidates[0]?.inputHash,
    );
  });

  it('canonicalises equivalent instant spellings before hashing', () => {
    const basic = makeInput({
      tasks: [makeTask({ id: 'A', dueAt: '2026-11-10T00:00:00Z' })],
    });
    const spelled = makeInput({
      now: '2026-11-09T09:00:00+09:00',
      horizon: {
        start: '2026-11-09T09:00:00+09:00',
        end: '2026-11-11T09:00:00+09:00',
      },
      tasks: [makeTask({ id: 'A', dueAt: '2026-11-10T09:00:00+09:00' })],
    });
    const first = generate(basic, { policies: ['front_loaded'], seed: 7 });
    const second = generate(spelled, { policies: ['front_loaded'], seed: 7 });
    expect(second.candidates[0]?.inputHash).toBe(
      first.candidates[0]?.inputHash,
    );
  });

  it('counts candidate-own H7 shortfall separately from capacity deficit', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T10:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      ],
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
    });
    const result = generate(input, { policies: ['front_loaded'] });
    const [candidate] = result.candidates;
    expect(candidate?.feasible).toBe(false);
    expect(candidate?.deficitMin).toBe(120);
    expect(candidate?.capacityDeficitMin).toBe(60);
    expect(candidate?.metrics.deficitMin).toBe(120);
    expect(candidate?.metrics.capacityDeficitMin).toBe(60);
    expect(candidate?.explanation.join('\n')).toContain('Capacity deficit: 60 min.');
    expect(candidate?.explanation.join('\n')).toContain(
      'Unplaced minutes (H7 shortfall): 120 min.',
    );
  });

  it('N14: deficitMin and coverage ignore history minutes', () => {
    const input = makeInput({
      now: '2026-11-09T12:00:00Z',
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T17:00:00Z',
          estimate: { p50Min: 120, p90Min: 120 },
          remainingMin: 60,
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '00:00', endLocal: '24:00', kind: 'work' },
      ],
      prefs: {
        maxDailyFocusMin: 120,
        breakAfterMin: 480,
        breakMin: 15,
        riskLevel: 'p50',
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
      },
      existingBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T11:00:00Z',
        },
      ],
    });
    const result = generate(input, { policies: ['front_loaded'] });
    const [candidate] = result.candidates;
    expect(candidate?.blocks).toEqual([]);
    expect(candidate?.feasible).toBe(false);
    expect(candidate?.deficitMin).toBe(60);
    expect(candidate?.metrics.deficitMin).toBe(60);
    expect(candidate?.metrics.p90CoverageRatio).toBe(0);
    expect(candidate?.explanation.join('\n')).toContain(
      'Placed 0 of 60 required minutes',
    );
    expect(candidate?.explanation.join('\n')).toContain(
      'Unplaced minutes (H7 shortfall): 60 min.',
    );
  });

  it('uses remainingMin for p90CoverageRatio', () => {
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 240, p90Min: 360 },
          remainingMin: 120,
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' },
      ],
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
    });
    const result = generate(input, { policies: ['front_loaded'] });
    expect(result.candidates[0]?.feasible).toBe(true);
    expect(result.candidates[0]?.metrics.p90CoverageRatio).toBe(1);
  });

  it('ranks all-infeasible attempts by deficit before retained seeds', () => {
    const seedBlock: Block = {
      taskId: 'A',
      start: '2026-11-09T09:00:00Z',
      end: '2026-11-09T09:30:00Z',
    };
    const input = makeInput({
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T10:00:00Z',
          estimate: { p50Min: 90, p90Min: 90 },
          minSessionMin: 30,
          maxSessionMin: 60,
        }),
      ],
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      ],
      horizon: {
        start: '2026-11-09T00:00:00Z',
        end: '2026-11-10T00:00:00Z',
      },
      existingBlocks: [seedBlock],
    });
    const withoutSeed = { ...input, existingBlocks: [] };

    const seeded = generate(input, {
      policies: ['front_loaded'],
      seed: input.seed,
    }).candidates[0];
    const fresh = generate(withoutSeed, {
      policies: ['front_loaded'],
      seed: input.seed,
    }).candidates[0];

    expect(seeded?.feasible).toBe(false);
    expect(fresh?.feasible).toBe(false);
    expect(seeded?.deficitMin).toBe(45);
    expect(seeded?.deficitMin).toBe(fresh?.deficitMin);
    expect(seeded?.explanation.join('\n')).toContain(
      'retaining 0 existing block(s)',
    );
  });

  it('documents and versions policy ordering and slot rules', () => {
    expect(POLICY_VERSION).toBe('1.0.0');
    expect(
      Object.fromEntries(
        Object.values(POLICIES).map((profile) => [
          profile.name,
          {
            version: profile.version,
            ordering: profile.ordering,
            slotRule: profile.slotRule,
          },
        ]),
      ),
    ).toEqual({
      front_loaded: {
        version: POLICY_VERSION,
        ordering: 'edf',
        slotRule: 'chronological-earliest',
      },
      balanced: {
        version: POLICY_VERSION,
        ordering: 'priority_then_length',
        slotRule: 'least-loaded-day',
      },
      focus_blocked: {
        version: POLICY_VERSION,
        ordering: 'longest_first',
        slotRule: 'longest-slot-then-fewest-switches',
      },
    });
  });
});
