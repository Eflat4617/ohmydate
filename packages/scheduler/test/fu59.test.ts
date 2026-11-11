import type {
  AvailabilityRule,
  Block,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate, validateInput } from '../src/index.js';

/**
 * FU-59 (06 §7.1 caller contract): `ScheduleInput.affectedTaskIds` lets the
 * replan caller scope dependency edits the scheduler cannot see (a removed
 * edge, or a new edge whose existing blocks already satisfy the order). The
 * explicit ids join the affected set and its successors; everything else
 * stays frozen. The staged predecessor expansion still releases only the
 * dependency depth that is actually needed.
 */

function blockKey(block: Block): string {
  return `${block.taskId}|${block.start}|${block.end}`;
}

function taskKeys(blocks: readonly Block[], taskId: string): string[] {
  return blocks
    .filter((block) => block.taskId === taskId)
    .map(blockKey)
    .sort();
}

function task(
  id: string,
  minutes: number,
  overrides: Partial<Task> = {},
): Task {
  return {
    id,
    dueAt: '2026-11-11T00:00:00Z',
    estimate: { p50Min: minutes, p90Min: minutes },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 2,
    dependsOn: [],
    ...overrides,
  };
}

function block(taskId: string, start: string, end: string): Block {
  return {
    taskId,
    start: `2026-11-09T${start}:00Z`,
    end: `2026-11-09T${end}:00Z`,
  };
}

function baseInput(tasks: Task[], existingBlocks: Block[]): ScheduleInput {
  const availability: AvailabilityRule[] = [1, 2, 3, 4, 5, 6, 7].map(
    (weekday) => ({
      weekday: weekday as Weekday,
      startLocal: '09:00',
      endLocal: '17:00',
      kind: 'work',
    }),
  );
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-11T00:00:00Z',
    },
    tasks,
    availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    existingBlocks,
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 59,
  };
}

function frontLoaded(input: ScheduleInput) {
  const [candidate] = generate(input, {
    policies: ['front_loaded'],
    seed: 59,
  }).candidates;
  if (candidate === undefined) throw new Error('no candidate');
  return candidate;
}

// A and B used to be linked by A -> B; the edge was removed. Every existing
// block still looks valid, so the scheduler alone sees nothing to release.
const EXISTING = [
  block('A', '09:00', '10:00'),
  block('D', '10:00', '11:00'),
  block('B', '15:00', '16:00'),
];

describe('FU-59 caller-supplied affected scope', () => {
  it('keeps every block frozen when the caller passes no scope (negative)', () => {
    const input = baseInput([task('A', 60), task('B', 60), task('D', 60)], EXISTING);
    const candidate = frontLoaded(input);
    expect(candidate.feasible).toBe(true);
    expect(candidate.metrics.changedBlocks).toBe(0);
    expect(candidate.blocks.map(blockKey).sort()).toEqual(EXISTING.map(blockKey).sort());
  });

  it('releases both endpoints of a removed dependency edge and freezes the rest', () => {
    const input = {
      ...baseInput([task('A', 60), task('B', 60), task('D', 60)], EXISTING),
      affectedTaskIds: ['A', 'B'],
    };
    const candidate = frontLoaded(input);
    expect(candidate.feasible).toBe(true);
    // B is released: front_loaded pulls it out of the late 15:00 slot.
    expect(taskKeys(candidate.blocks, 'B')).not.toEqual(taskKeys(EXISTING, 'B'));
    // D is outside the scope and stays exactly where it was.
    expect(taskKeys(candidate.blocks, 'D')).toEqual(taskKeys(EXISTING, 'D'));
    expect(candidate.metrics.changedBlocks).toBeGreaterThan(0);
    // 2 x (A + B existing blocks) + 2
    expect(candidate.metrics.changedBlocks).toBeLessThanOrEqual(2 * 2 + 2);
  });

  it('releases an already-in-order new edge only when the caller names it', () => {
    // B -> A is new but A already ends before B starts: undetectable.
    const tasks = [task('A', 60), task('B', 60, { dependsOn: ['A'] }), task('D', 60)];
    const without = frontLoaded(baseInput(tasks, EXISTING));
    expect(without.metrics.changedBlocks).toBe(0);
    expect(taskKeys(without.blocks, 'B')).toEqual(taskKeys(EXISTING, 'B'));

    const scoped = frontLoaded({ ...baseInput(tasks, EXISTING), affectedTaskIds: ['A', 'B'] });
    expect(scoped.feasible).toBe(true);
    expect(taskKeys(scoped.blocks, 'B')).not.toEqual(taskKeys(EXISTING, 'B'));
    expect(taskKeys(scoped.blocks, 'D')).toEqual(taskKeys(EXISTING, 'D'));
    // H3 still holds for the re-placed pair.
    const aEnd = Math.max(
      ...scoped.blocks.filter((entry) => entry.taskId === 'A').map((entry) => Date.parse(entry.end)),
    );
    const bStart = Math.min(
      ...scoped.blocks.filter((entry) => entry.taskId === 'B').map((entry) => Date.parse(entry.start)),
    );
    expect(aEnd).toBeLessThanOrEqual(bStart);
  });

  it('propagates the explicit scope to transitive successors', () => {
    const existing = [
      block('A', '09:00', '10:00'),
      block('D', '10:00', '11:00'),
      block('C', '16:00', '17:00'),
    ];
    const tasks = [task('A', 60), task('C', 60, { dependsOn: ['A'] }), task('D', 60)];
    const candidate = frontLoaded({ ...baseInput(tasks, existing), affectedTaskIds: ['A'] });
    expect(candidate.feasible).toBe(true);
    // C depends on A, so it is released with A and moves out of 16:00.
    expect(taskKeys(candidate.blocks, 'C')).not.toEqual(taskKeys(existing, 'C'));
    expect(taskKeys(candidate.blocks, 'D')).toEqual(taskKeys(existing, 'D'));
  });

  it('ignores unknown ids and is byte-identical to an unscoped replan (negative)', () => {
    const tasks = [task('A', 60), task('B', 60), task('D', 60)];
    const plain = frontLoaded(baseInput(tasks, EXISTING));
    const ghost = frontLoaded({ ...baseInput(tasks, EXISTING), affectedTaskIds: ['ghost'] });
    expect(ghost.blocks).toEqual(plain.blocks);
    expect(ghost.metrics).toEqual(plain.metrics);
    // The explicit scope is part of the hashed input, but only when supplied.
    expect(ghost.inputHash).not.toBe(plain.inputHash);
    expect(validateInput({ ...baseInput(tasks, EXISTING), affectedTaskIds: ['ghost'] })).toEqual([]);
  });

  it('hashes the scope as a set: order and duplicates do not matter', () => {
    const tasks = [task('A', 60), task('B', 60), task('D', 60)];
    const first = frontLoaded({ ...baseInput(tasks, EXISTING), affectedTaskIds: ['B', 'A'] });
    const second = frontLoaded({
      ...baseInput(tasks, EXISTING),
      affectedTaskIds: ['A', 'B', 'A'],
    });
    expect(second.inputHash).toBe(first.inputHash);
    expect(second.blocks).toEqual(first.blocks);
  });
});

describe('FU-59 stage-specific predecessor expansion', () => {
  // Chain P2 -> P1 -> X. X grew from 60 to 90 minutes.
  const existing = [
    block('P2', '09:00', '09:30'),
    block('P1', '10:00', '11:00'),
    block('X', '11:00', '12:00'),
  ];

  function chain(xDueAt: string): Task[] {
    return [
      task('P2', 30),
      task('P1', 60, { dependsOn: ['P2'] }),
      task('X', 90, { dependsOn: ['P1'], dueAt: xDueAt }),
    ];
  }

  it('releases no predecessor when the initial scope is feasible', () => {
    const candidate = frontLoaded({
      ...baseInput(chain('2026-11-09T17:00:00Z'), existing),
      affectedTaskIds: ['X'],
    });
    expect(candidate.feasible).toBe(true);
    expect(taskKeys(candidate.blocks, 'P1')).toEqual(taskKeys(existing, 'P1'));
    expect(taskKeys(candidate.blocks, 'P2')).toEqual(taskKeys(existing, 'P2'));
    const xMinutes = candidate.blocks
      .filter((entry) => entry.taskId === 'X')
      .reduce((sum, entry) => sum + (Date.parse(entry.end) - Date.parse(entry.start)) / 60_000, 0);
    expect(xMinutes).toBe(90);
  });

  it('releases only the depth that is required (P1, not P2)', () => {
    // X is due at 12:00. With P1 frozen at 10:00-11:00 only 60 minutes remain
    // after it; releasing P1 (depth 1) lets it start at 09:30 so X fits, and
    // P2 (depth 2) is never released.
    const candidate = frontLoaded({
      ...baseInput(chain('2026-11-09T12:00:00Z'), existing),
      affectedTaskIds: ['X'],
    });
    expect(candidate.feasible).toBe(true);
    expect(taskKeys(candidate.blocks, 'P2')).toEqual(taskKeys(existing, 'P2'));
    expect(taskKeys(candidate.blocks, 'P1')).not.toEqual(taskKeys(existing, 'P1'));
    const p1End = Math.max(
      ...candidate.blocks.filter((entry) => entry.taskId === 'P1').map((entry) => Date.parse(entry.end)),
    );
    const xStart = Math.min(
      ...candidate.blocks.filter((entry) => entry.taskId === 'X').map((entry) => Date.parse(entry.start)),
    );
    expect(p1End).toBeLessThanOrEqual(xStart);
    expect(
      Math.max(...candidate.blocks.map((entry) => Date.parse(entry.end))),
    ).toBeLessThanOrEqual(Date.parse('2026-11-09T12:00:00Z'));
  });

  it('returns an explained infeasible candidate when even full expansion cannot fit (negative)', () => {
    // Due 11:30: P2 + P1 + X need 180 minutes after 09:00 -> impossible.
    const candidate = frontLoaded({
      ...baseInput(chain('2026-11-09T11:30:00Z'), existing),
      affectedTaskIds: ['X'],
    });
    expect(candidate.feasible).toBe(false);
    expect(candidate.deficitMin).toBeGreaterThan(0);
    expect(candidate.explanation.length).toBeGreaterThan(0);
  });
});
