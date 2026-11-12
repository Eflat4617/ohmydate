import type { ScheduleInput, Task } from '../src/index.js';
import {
  autoSplitMinSessionMin,
  generate,
  maxLegalSessionMin,
  validate,
} from '../src/index.js';
import { MAX_AUTO_SPLIT_LINES } from '../src/generate.js';

/**
 * FU-96: a non-splittable task longer than one H6-legal block, and chains
 * blocked by an unplaced predecessor (06 §3, §6.1).
 */

const PREFS = {
  maxDailyFocusMin: 480,
  breakAfterMin: 60,
  breakMin: 15,
  riskLevel: 'p50' as const,
  dayStartLocal: '00:00',
  dayEndLocal: '24:00',
};

function task(overrides: Partial<Task> & { id: string }): Task {
  return {
    dueAt: '2026-11-20T00:00:00Z',
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 90,
    priority: 2,
    dependsOn: [],
    ...overrides,
  };
}

function input(tasks: Task[], overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'UTC',
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-20T00:00:00Z' },
    tasks,
    availability: ([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({
      weekday,
      startLocal: '09:00',
      endLocal: '18:00',
      kind: 'work' as const,
    })),
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: PREFS,
    seed: 3,
    ...overrides,
  };
}

/** Non-splittable task with the pre-FU-96 bounds (one block = the estimate). */
function unsplittable(id: string, minutes: number, dependsOn: string[] = []): Task {
  return task({
    id,
    estimate: { p50Min: minutes, p90Min: minutes },
    splittable: false,
    minSessionMin: minutes,
    maxSessionMin: minutes,
    dependsOn,
  });
}

/** The same task as the caller sends it after the FU-96 auto-split. */
function autoSplit(id: string, minutes: number, capMin: number, dependsOn: string[] = []): Task {
  return task({
    id,
    estimate: { p50Min: minutes, p90Min: minutes },
    splittable: true,
    minSessionMin: autoSplitMinSessionMin(capMin, 30),
    maxSessionMin: capMin,
    dependsOn,
    autoSplit: 'break_after',
  });
}

function codes(candidate: { explanationItems: { code: string }[] }): string[] {
  return candidate.explanationItems.map((item) => item.code);
}

describe('maxLegalSessionMin (FU-96)', () => {
  it('is the smaller H6 limit on the 5-minute grid, break_after on a tie', () => {
    expect(maxLegalSessionMin({ breakAfterMin: 60, maxDailyFocusMin: 240 })).toEqual({ capMin: 60, reason: 'break_after' });
    expect(maxLegalSessionMin({ breakAfterMin: 60, maxDailyFocusMin: 180 })).toEqual({ capMin: 60, reason: 'break_after' });
    expect(maxLegalSessionMin({ breakAfterMin: 240, maxDailyFocusMin: 150 })).toEqual({ capMin: 150, reason: 'daily_cap' });
    expect(maxLegalSessionMin({ breakAfterMin: 90, maxDailyFocusMin: 90 })).toEqual({ capMin: 90, reason: 'break_after' });
    expect(maxLegalSessionMin({ breakAfterMin: 62, maxDailyFocusMin: 480 })).toEqual({ capMin: 60, reason: 'break_after' });
  });

  it('falls back to the daily cap when the break rule is off', () => {
    expect(maxLegalSessionMin({ breakAfterMin: 0, maxDailyFocusMin: 200 })).toEqual({ capMin: 200, reason: 'daily_cap' });
  });

  it('has no legal session below one grid cell or for non-finite prefs (negative)', () => {
    expect(maxLegalSessionMin({ breakAfterMin: 60, maxDailyFocusMin: 0 })).toBeUndefined();
    expect(maxLegalSessionMin({ breakAfterMin: 3, maxDailyFocusMin: 480 })).toBeUndefined();
    expect(maxLegalSessionMin({ breakAfterMin: 0, maxDailyFocusMin: Number.NaN })).toBeUndefined();
  });
});

describe('autoSplitMinSessionMin (FU-96)', () => {
  it('keeps the default minimum but never more than half the cap', () => {
    expect(autoSplitMinSessionMin(60, 30)).toBe(30);
    expect(autoSplitMinSessionMin(180, 30)).toBe(30);
    expect(autoSplitMinSessionMin(45, 30)).toBe(20);
    expect(autoSplitMinSessionMin(40, 30)).toBe(20);
    expect(autoSplitMinSessionMin(10, 30)).toBe(5);
    expect(autoSplitMinSessionMin(5, 30)).toBe(5);
  });

  it('lets every remaining length above the cap split inside the bounds', () => {
    for (const capMin of [5, 10, 15, 40, 45, 55, 60, 75, 120, 180]) {
      for (const remainingMin of [capMin + 5, capMin + 10, 2 * capMin + 5, 3 * capMin - 5, 5 * capMin]) {
        const result = generate(
          input([autoSplit('A', remainingMin, capMin)], {
            prefs: { ...PREFS, breakAfterMin: capMin },
            horizon: { start: '2026-11-09T00:00:00Z', end: '2026-12-09T00:00:00Z' },
            tasks: [{ ...autoSplit('A', remainingMin, capMin), dueAt: '2026-12-09T00:00:00Z' }],
          }),
          { policies: ['front_loaded'] },
        );
        const candidate = result.candidates[0];
        expect(candidate?.feasible, `cap ${capMin}, remaining ${remainingMin}`).toBe(true);
        expect(codes(candidate!)).not.toContain('heuristic_session_bounds_infeasible');
      }
    }
  });
});

describe('auto-split explanation lines (FU-96)', () => {
  it('places a long non-splittable task as legal sessions and explains it once', () => {
    const tasks = [autoSplit('A', 160, 60), unsplittable('B', 45, ['A'])];
    const result = generate(input(tasks));
    expect(result.candidates.length).toBeGreaterThan(0);
    for (const candidate of result.candidates) {
      expect(candidate.feasible, candidate.policy).toBe(true);
      expect(validate(input(tasks), candidate.blocks, { riskLevel: 'p50' })).toEqual([]);
      const aBlocks = candidate.blocks.filter((block) => block.taskId === 'A');
      expect(aBlocks.length).toBeGreaterThanOrEqual(3);
      for (const block of aBlocks) {
        expect((Date.parse(block.end) - Date.parse(block.start)) / 60_000).toBeLessThanOrEqual(60);
      }
      // The fitting non-splittable task stays one exact block.
      const bBlocks = candidate.blocks.filter((block) => block.taskId === 'B');
      expect(bBlocks.map((block) => (Date.parse(block.end) - Date.parse(block.start)) / 60_000)).toEqual([45]);

      expect(candidate.explanation).toHaveLength(candidate.explanationItems.length);
      const index = candidate.explanationItems.findIndex((item) => item.code === 'auto_split_long_task');
      expect(candidate.explanationItems[index]).toEqual({
        code: 'auto_split_long_task',
        params: { taskId: 'A', sessionMaxMin: 60, reason: 'break_after' },
      });
      expect(candidate.explanation[index]).toBe(
        'Non-splittable task "A" is longer than the 60-minute limit before a break; scheduled in sessions of at most 60 min.',
      );
      expect(codes(candidate).filter((code) => code === 'auto_split_long_task')).toHaveLength(1);
    }
  });

  it('names the daily cap when that is the binding limit', () => {
    const tasks = [{ ...autoSplit('A', 200, 120), autoSplit: 'daily_cap' as const }];
    const candidate = generate(input(tasks, { prefs: { ...PREFS, breakAfterMin: 0, maxDailyFocusMin: 120 } }), {
      policies: ['front_loaded'],
    }).candidates[0];
    expect(candidate?.feasible).toBe(true);
    const index = candidate!.explanationItems.findIndex((item) => item.code === 'auto_split_long_task');
    expect(candidate!.explanationItems[index]?.params).toEqual({ taskId: 'A', sessionMaxMin: 120, reason: 'daily_cap' });
    expect(candidate!.explanation[index]).toContain('the 120-minute daily focus cap');
  });

  it('adds no line without the marker, for a non-splittable task, or for an unknown reason (negative)', () => {
    const plain = { ...autoSplit('A', 160, 60) };
    delete plain.autoSplit;
    const marked = { ...unsplittable('B', 45), autoSplit: 'break_after' as const };
    const bogus = { ...autoSplit('C', 160, 60), autoSplit: 'whatever' as unknown as 'break_after' };
    for (const candidate of generate(input([plain, marked, bogus])).candidates) {
      expect(codes(candidate)).not.toContain('auto_split_long_task');
      expect(candidate.explanation).toHaveLength(candidate.explanationItems.length);
    }
  });

  it('caps the lines so a candidate stays within the 50-line contract', () => {
    const tasks = Array.from({ length: MAX_AUTO_SPLIT_LINES + 15 }, (_, index) =>
      autoSplit(`T${String(index).padStart(2, '0')}`, 65, 60),
    );
    const result = generate(input(tasks), { policies: ['front_loaded'] });
    const candidate = result.candidates[0]!;
    const lines = codes(candidate).filter((code) => code === 'auto_split_long_task');
    expect(lines).toHaveLength(MAX_AUTO_SPLIT_LINES);
    expect(candidate.explanationItems.filter((item) => item.code === 'auto_split_long_task')[0]?.params).toMatchObject({
      taskId: 'T00',
    });
    expect(candidate.explanation.length).toBeLessThanOrEqual(50);
    expect(candidate.explanation).toHaveLength(candidate.explanationItems.length);
  });
});

describe('heuristic_blocked_by_predecessor (FU-96)', () => {
  it('names the unplaced predecessor instead of missing available time', () => {
    // A 160-minute single block can never satisfy the 60-minute break rule,
    // so the root stays unplaced and every successor waits on it.
    const tasks = [unsplittable('A', 160), task({ id: 'B', dependsOn: ['A'] }), task({ id: 'C', dependsOn: ['B'] })];
    const result = generate(input(tasks));
    for (const candidate of result.candidates) {
      expect(candidate.blocks).toEqual([]);
      expect(codes(candidate)).toContain('heuristic_no_contiguous_window');
      expect(codes(candidate)).toContain('heuristic_blocked_by_predecessor');
      expect(codes(candidate)).not.toContain('heuristic_insufficient_available_time');
      const index = candidate.explanationItems.findIndex((item) => item.code === 'heuristic_blocked_by_predecessor');
      expect(candidate.explanation[index]).toBe('Heuristic reason: blocked_by_predecessor.');
    }
  });

  it('is reported next to a real time shortage, which keeps its own reason', () => {
    const tasks = [
      unsplittable('A', 160),
      task({ id: 'B', dependsOn: ['A'] }),
      task({ id: 'D', dueAt: '2026-11-09T09:30:00Z' }),
    ];
    for (const candidate of generate(input(tasks)).candidates) {
      expect(codes(candidate)).toContain('heuristic_blocked_by_predecessor');
      expect(codes(candidate)).toContain('heuristic_insufficient_available_time');
    }
  });

  it('does not appear when nothing is blocked (negative)', () => {
    const chain = [autoSplit('A', 160, 60), task({ id: 'B', dependsOn: ['A'] }), task({ id: 'C', dependsOn: ['B'] })];
    for (const candidate of generate(input(chain)).candidates) {
      expect(candidate.feasible).toBe(true);
      expect(codes(candidate)).not.toContain('heuristic_blocked_by_predecessor');
    }
    // A plain shortage without dependencies keeps the old reason only.
    const short = [task({ id: 'D', dueAt: '2026-11-09T09:30:00Z' })];
    for (const candidate of generate(input(short)).candidates) {
      expect(codes(candidate)).toContain('heuristic_insufficient_available_time');
      expect(codes(candidate)).not.toContain('heuristic_blocked_by_predecessor');
    }
  });
});
