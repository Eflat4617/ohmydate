import { cpus, loadavg } from 'node:os';
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

/**
 * FU-66: make the 06 §11 p95 gate load-independent.
 *
 * The budget is 500 ms p95 for 50 tasks / 14 days / 3 policies. On a shared
 * host the raw reading also includes time spent waiting for a CPU and time
 * lost to frequency/cache contention from other worktrees, which made this
 * gate fail intermittently without any generator change (FU-69R2). Two changes
 * keep the 500 ms target while removing that noise:
 *
 * 1. We measure `process.cpuUsage()` (user + system) rather than wall time, so
 *    time spent queued off-CPU is not charged to the generator.
 * 2. Before every measured run we run a fixed CPU-bound workload that is
 *    completely independent of packages/scheduler (a deterministic array
 *    hash), and divide the measured CPU time by that calibration time. The
 *    factor is expressed in milliseconds via CALIBRATION_REF_MS, so the
 *    asserted quantity is still "milliseconds of generator work on the
 *    reference machine" and the 500 ms threshold is unchanged. A uniformly
 *    slower/loaded host scales both the calibration and the workload, leaving
 *    the normalised value stable. Because the calibration never calls the
 *    generator, a real scheduler-wide regression still doubles the numerator
 *    without moving the denominator (see the negative self-test below); this
 *    is why the calibration must not be another `generate()` call, which
 *    would cancel exactly the slowdown the gate exists to catch.
 *
 * CALIBRATION_REF_MS was measured on this host on 2026-11-12 under a quiet
 * run: 31 samples of `runCalibrationWorkload()` gave p50=10.543 ms,
 * p95=10.629 ms, min=10.515 ms, max=14.713 ms; 10.5 ms is the rounded median.
 * Re-measure it if the calibration workload itself changes.
 *
 * Best-of-N batches is kept (the load average is printed for diagnosis only)
 * so a burst of contention can be outlived without weakening the target.
 */
const CALIBRATION_REF_MS = 10.5;

const CALIBRATION_VALUES = new Uint32Array(4096);
for (let index = 0; index < CALIBRATION_VALUES.length; index += 1) {
  CALIBRATION_VALUES[index] =
    (Math.imul(index + 1, 2654435761) ^ 0x9e3779b9) >>> 0;
}

let calibrationSink = 0;

function runCalibrationWorkload(): void {
  let hash = 0x811c9dc5;
  for (let round = 0; round < 3000; round += 1) {
    for (let index = 0; index < CALIBRATION_VALUES.length; index += 1) {
      hash ^= CALIBRATION_VALUES[index]!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  calibrationSink = (calibrationSink + hash) >>> 0;
}

function cpuMillisSince(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
}

function measureCalibratedCpuMillis(work: () => void): number {
  const calibrationStart = process.cpuUsage();
  runCalibrationWorkload();
  const calibrationMs = Math.max(0.001, cpuMillisSince(calibrationStart));

  const start = process.cpuUsage();
  work();
  const cpuMs = cpuMillisSince(start);
  return (cpuMs / calibrationMs) * CALIBRATION_REF_MS;
}

/** Busy-wait on CPU for at least `targetMs`, independent of packages/scheduler. */
function burnCpuMillis(targetMs: number): void {
  const start = process.cpuUsage();
  let hash = calibrationSink;
  while (cpuMillisSince(start) < targetMs) {
    for (let index = 0; index < 65536; index += 1) {
      hash ^= CALIBRATION_VALUES[index & (CALIBRATION_VALUES.length - 1)]!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  calibrationSink = (calibrationSink + hash) >>> 0;
}

describe('generator performance (06 §11)', () => {
  it('50 tasks / 14 days / 3 policies p95 < 500 ms (calibrated CPU time)', () => {
    const input = buildLargeInput();
    const batchSize = 20;
    const maxBatches = 5;
    const batchP95: number[] = [];

    for (let batch = 1; batch <= maxBatches; batch += 1) {
      const timings: number[] = [];

      for (let run = 0; run < batchSize; run += 1) {
        let result: ReturnType<typeof generate> | undefined;
        timings.push(
          measureCalibratedCpuMillis(() => {
            result = generate(input, {
              policies: ['front_loaded', 'balanced', 'focus_blocked'],
              seed: input.seed,
            });
          }),
        );
        expect(result?.candidates.map((candidate) => candidate.feasible)).toEqual([
          true,
          true,
          true,
        ]);
      }

      const sorted = [...timings].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      batchP95.push(p95);
      const loadPerCore = (loadavg()[0] ?? 0) / Math.max(1, cpus().length);
      console.log(
        `generator perf batch ${batch}/${maxBatches}: calibrated p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms min=${(sorted[0] ?? 0).toFixed(1)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms loadavg/core=${loadPerCore.toFixed(2)}`,
      );

      // Best-of-N: one quiet batch is enough evidence on a shared host. The
      // load average is printed for diagnosis but never gates the assertion.
      if (p95 < 500) {
        break;
      }
    }

    if (process.env.SCHED_PERF_ASSERT === '1') {
      const bestP95 = Math.min(...batchP95);
      expect(bestP95).toBeLessThan(500);
    } else {
      // Root `pnpm run ci` does not set SCHED_PERF_ASSERT; timings are still
      // printed there, but only the scheduler package script enforces them.
      console.log(
        `generator perf assertion skipped (SCHED_PERF_ASSERT not set); best p95=${Math.min(...batchP95).toFixed(1)}ms.`,
      );
    }
  }, 180000);

  it('calibrated p95 roughly doubles under a uniform +100% workload slowdown (negative self-test)', () => {
    // Feed the same measurement function the gate uses a fixed CPU workload
    // that cannot vary with GC/JIT in the scheduler, so this self-test is
    // deterministic. If the calibration were another copy of the workload
    // under test (the bug this guards against), both samples would scale
    // together and the ratio below would stay at 1x.
    const baseline: number[] = [];
    const slowed: number[] = [];

    for (let run = 0; run < 12; run += 1) {
      baseline.push(
        measureCalibratedCpuMillis(() => {
          burnCpuMillis(25);
        }),
      );
      slowed.push(
        measureCalibratedCpuMillis(() => {
          // Exactly +100% of the measured workload.
          burnCpuMillis(25);
          burnCpuMillis(25);
        }),
      );
    }

    const baselineP95 = percentile(
      [...baseline].sort((a, b) => a - b),
      0.95,
    );
    const slowedP95 = percentile(
      [...slowed].sort((a, b) => a - b),
      0.95,
    );
    console.log(
      `slowdown self-test: baseline p95=${baselineP95.toFixed(1)}ms doubled p95=${slowedP95.toFixed(1)}ms ratio=${(slowedP95 / baselineP95).toFixed(2)}x`,
    );
    expect(slowedP95).toBeGreaterThan(baselineP95 * 1.7);
    expect(slowedP95).toBeLessThan(baselineP95 * 2.3);
  }, 180000);
});
