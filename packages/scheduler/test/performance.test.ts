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

function buildSelfTestInput(): ScheduleInput {
  const input = buildLargeInput();
  return {
    ...input,
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-10T00:00:00Z' },
    tasks: input.tasks.slice(0, 1).map((task) => ({
      ...task,
      dueAt: '2026-11-10T00:00:00Z',
    })),
  };
}

function cpuMillisSince(start: NodeJS.CpuUsage): number {
  const usage = process.cpuUsage(start);
  return (usage.user + usage.system) / 1000;
}

interface BatchStats {
  p50: number;
  p95: number;
  min: number;
  max: number;
  samples: number[];
}

interface MeasureP95Options {
  /** The scheduler work under test. Called once per sample. */
  workload: () => void;
  /** Fixed CPU cost used to normalise the sample. Must not call the workload. */
  calibration: () => void;
  /** Number of batches to run. */
  batches: number;
  /** Calibration reference in milliseconds (see CALIBRATION_REF_MS). */
  refMs: number;
  /** Samples per batch (default 20; p95 is then the second-highest sample). */
  batchSize?: number;
  /** Stop early once a batch p95 is under this value (best-of-N). */
  stopWhenP95Below?: number;
}

interface MeasureP95Result {
  batches: BatchStats[];
  /** Smallest batch p95; this is what the budget gate asserts on. */
  bestP95: number;
}

/**
 * Pure calibrated p95 measurement shared by the production gate and the
 * negative self-tests. Both the workload and the calibration are injected, so
 * the self-tests can prove that a *scheduler-wide* slowdown is detected only
 * when the calibration is independent of the scheduler.
 */
function measureP95(options: MeasureP95Options): MeasureP95Result {
  const batchSize = options.batchSize ?? 20;
  const batches: BatchStats[] = [];

  for (let batch = 0; batch < options.batches; batch += 1) {
    const timings: number[] = [];
    for (let run = 0; run < batchSize; run += 1) {
      const calibrationStart = process.cpuUsage();
      options.calibration();
      const calibrationMs = Math.max(0.001, cpuMillisSince(calibrationStart));

      const start = process.cpuUsage();
      options.workload();
      const cpuMs = cpuMillisSince(start);
      timings.push((cpuMs / calibrationMs) * options.refMs);
    }

    const sorted = [...timings].sort((a, b) => a - b);
    const stats: BatchStats = {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      samples: timings,
    };
    batches.push(stats);
    if (
      options.stopWhenP95Below !== undefined &&
      stats.p95 < options.stopWhenP95Below
    ) {
      break;
    }
  }

  return { batches, bestP95: Math.min(...batches.map((batch) => batch.p95)) };
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

/**
 * Wraps a scheduler workload with a uniform +100% CPU burn applied to *every*
 * invocation, including any invocation made by a (mistaken) calibration.
 */
function withUniformSlowdown(work: () => void): () => void {
  return () => {
    const start = process.cpuUsage();
    work();
    burnCpuMillis(cpuMillisSince(start));
  };
}

interface GenerateSpy {
  countedGenerate: (...args: Parameters<typeof generate>) => ReturnType<typeof generate>;
  productionCalibration: () => void;
  callsDuringCalibration: () => number;
}

/**
 * Counts `generate()` calls made while the production calibration runs. The
 * production calibration is `runCalibrationWorkload`, which must never touch
 * the scheduler; this spy turns that expectation into an assertion.
 */
function createGenerateSpy(): GenerateSpy {
  let callsDuringCalibration = 0;
  let inCalibration = false;
  const countedGenerate = (
    ...args: Parameters<typeof generate>
  ): ReturnType<typeof generate> => {
    const result = generate(...args);
    if (inCalibration) {
      callsDuringCalibration += 1;
    }
    return result;
  };
  return {
    countedGenerate,
    productionCalibration: () => {
      inCalibration = true;
      try {
        runCalibrationWorkload();
      } finally {
        inCalibration = false;
      }
    },
    callsDuringCalibration: () => callsDuringCalibration,
  };
}

describe('generator performance (06 §11)', () => {
  it('50 tasks / 14 days / 3 policies p95 < 500 ms (calibrated CPU time)', () => {
    const input = buildLargeInput();
    const measured = measureP95({
      workload: () => {
        const result = generate(input, {
          policies: ['front_loaded', 'balanced', 'focus_blocked'],
          seed: input.seed,
        });
        expect(result.candidates.map((candidate) => candidate.feasible)).toEqual([
          true,
          true,
          true,
        ]);
      },
      calibration: runCalibrationWorkload,
      batches: 5,
      refMs: CALIBRATION_REF_MS,
      stopWhenP95Below: 500,
    });

    for (const [index, batch] of measured.batches.entries()) {
      const loadPerCore = (loadavg()[0] ?? 0) / Math.max(1, cpus().length);
      console.log(
        `generator perf batch ${index + 1}/${measured.batches.length}: calibrated p50=${batch.p50.toFixed(1)}ms p95=${batch.p95.toFixed(1)}ms min=${batch.min.toFixed(1)}ms max=${batch.max.toFixed(1)}ms loadavg/core=${loadPerCore.toFixed(2)}`,
      );
    }

    if (process.env.SCHED_PERF_ASSERT === '1') {
      expect(measured.bestP95).toBeLessThan(500);
    } else {
      // Root `pnpm run ci` does not set SCHED_PERF_ASSERT; timings are still
      // printed there, but only the scheduler package script enforces them.
      console.log(
        `generator perf assertion skipped (SCHED_PERF_ASSERT not set); best p95=${measured.bestP95.toFixed(1)}ms.`,
      );
    }
  }, 180000);

  it('detects a uniform scheduler slowdown and rejects scheduler-based calibration (negative self-test)', () => {
    const input = buildSelfTestInput();
    const SELF_TEST_SAMPLES = 20;
    const FAULTY_SAMPLES = 10;
    // Average many real generate() calls per invocation (still +100% wrapped)
    // so per-sample CPU noise cannot swamp the slowdown ratio.
    const SELF_TEST_REPEATS = 100;
    const schedulerWorkload = () => {
      for (let repeat = 0; repeat < SELF_TEST_REPEATS; repeat += 1) {
        generate(input, { policies: ['balanced'], seed: input.seed });
      }
    };
    const slowedWorkload = withUniformSlowdown(schedulerWorkload);
    const spy = createGenerateSpy();

    // Self-test A (detection): the *scheduler* workload is slowed uniformly
    // and the production (scheduler-independent) calibration is used. Measure
    // baseline and slowed back-to-back so both see the same host load, record
    // the per-sample slowdown ratio, and take its p95.
    const productionRatios: number[] = [];
    for (let run = 0; run < SELF_TEST_SAMPLES; run += 1) {
      const baseline = measureP95({
        workload: schedulerWorkload,
        calibration: spy.productionCalibration,
        batches: 1,
        batchSize: 1,
        refMs: CALIBRATION_REF_MS,
      });
      const slowed = measureP95({
        workload: slowedWorkload,
        calibration: spy.productionCalibration,
        batches: 1,
        batchSize: 1,
        refMs: CALIBRATION_REF_MS,
      });
      productionRatios.push(slowed.bestP95 / baseline.bestP95);
    }
    const productionRatio = percentile(
      [...productionRatios].sort((a, b) => a - b),
      0.95,
    );

    // Self-test B (known bug): use the scheduler workload itself as the
    // calibration. The uniform slowdown then scales numerator and
    // denominator together, so the ratio collapses to ~1x exactly as in the
    // old generate()-based design.
    const faultyRatios: number[] = [];
    for (let run = 0; run < FAULTY_SAMPLES; run += 1) {
      const baseline = measureP95({
        workload: schedulerWorkload,
        calibration: schedulerWorkload,
        batches: 1,
        batchSize: 1,
        refMs: CALIBRATION_REF_MS,
      });
      const slowed = measureP95({
        workload: slowedWorkload,
        calibration: slowedWorkload,
        batches: 1,
        batchSize: 1,
        refMs: CALIBRATION_REF_MS,
      });
      faultyRatios.push(slowed.bestP95 / baseline.bestP95);
    }
    const faultyRatio = percentile(
      [...faultyRatios].sort((a, b) => a - b),
      0.5,
    );

    console.log(
      `slowdown self-test: production calibration slowdown ratio p95=${productionRatio.toFixed(2)}x; scheduler-as-calibration slowdown ratio p50=${faultyRatio.toFixed(2)}x; generate() calls during production calibration=${spy.callsDuringCalibration()}`,
    );

    expect(productionRatio).toBeGreaterThanOrEqual(1.6);
    expect(faultyRatio).toBeLessThanOrEqual(1.3);
    expect(spy.callsDuringCalibration()).toBe(0);
  }, 180000);
});
