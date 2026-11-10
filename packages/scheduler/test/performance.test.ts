import type {
  AvailabilityRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate } from '../src/index.js';

function buildLargeInput(): ScheduleInput {
  const availability: AvailabilityRule[] = [];
  for (let weekday = 1; weekday <= 5; weekday += 1) {
    availability.push({
      weekday: weekday as Weekday,
      startLocal: '08:00',
      endLocal: '18:00',
      kind: 'work',
    });
  }

  const tasks: Task[] = [];
  for (let index = 0; index < 50; index += 1) {
    tasks.push({
      id: `T${String(index).padStart(2, '0')}`,
      dueAt: '2026-11-23T00:00:00Z',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: true,
      minSessionMin: 30,
      maxSessionMin: 120,
      priority: ((index % 4) + 1) as 1 | 2 | 3 | 4,
      dependsOn: [],
      preferredWindows: index % 3 === 0 ? ['morning'] : [],
    });
  }

  return {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'Asia/Seoul',
    horizon: {
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-23T00:00:00Z',
    },
    tasks,
    availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 240,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 50,
  };
}

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index] ?? 0;
}

describe('generator performance (06 §11)', () => {
  it('50 tasks / 14 days / 3 policies p95 < 500 ms', () => {
    const input = buildLargeInput();
    const timings: number[] = [];
    const runs = 20;

    for (let run = 0; run < runs; run += 1) {
      const start = performance.now();
      const result = generate(input, {
        policies: ['front_loaded', 'balanced', 'focus_blocked'],
        seed: input.seed,
      });
      timings.push(performance.now() - start);
      expect(result.candidates.map((candidate) => candidate.feasible)).toEqual([
        true,
        true,
        true,
      ]);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const p50 = percentile(sorted, 0.5);
    const p95 = percentile(sorted, 0.95);
    console.log(
      `generator perf: 50 tasks / 14 days / 3 policies: p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms min=${(sorted[0] ?? 0).toFixed(1)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms`,
    );

    if (process.env.SCHED_PERF_ASSERT === '1') {
      expect(p95).toBeLessThan(500);
    } else {
      // The root `pnpm run ci` vitest run executes many test files in parallel,
      // which makes wall-clock percentiles unreliable. The package-scoped test
      // script sets SCHED_PERF_ASSERT=1 and runs with file parallelism off.
      console.log(
        'generator perf assertion skipped in full-suite run (unreliable parallel timer); run pnpm --filter @ohmydate/scheduler test to enforce p95 < 500ms.',
      );
    }
  }, 120000);
});
