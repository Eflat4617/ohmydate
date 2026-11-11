import { cpus, loadavg } from 'node:os';
import { vi } from 'vitest';
import type * as SchedulerModule from '../src/index.js';
import type {
  AvailabilityRule,
  ScheduleInput,
  Task,
  Weekday,
} from '../src/index.js';
import { generate } from '../src/index.js';

// FU-66d: replace the `generate` *binding* this file imports with a
// pass-through vi.fn (vi.mock is hoisted above the imports). Every generate()
// call written in this file -- the gate workload, the self-test workloads and
// any generate() call a mistaken calibration would make -- now goes through
// `generateMock`, so the tests below can count those calls and slow every one
// of them. Scheduler-internal calls between src modules are not affected.
vi.mock('../src/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SchedulerModule>();
  return { ...actual, generate: vi.fn(actual.generate) };
});

const generateMock = vi.mocked(generate);
const { generate: actualGenerate } =
  await vi.importActual<typeof SchedulerModule>('../src/index.js');

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
 *    the normalised value stable. The calibration must not call
 *    `generate()`: a generator regression would then slow the denominator
 *    too and cancel exactly the slowdown the gate exists to catch (the
 *    c12ff8f bug). The gate and self-test A read the calibration from the
 *    single PRODUCTION_GATE constant, and three checks below fail if it calls
 *    the mocked `generate` binding: the per-sample call count inside the
 *    gate, the spy test, and self-test A (every generate() call slowed +100%,
 *    so a generate()-based calibration collapses the ratio towards 1x).
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

/**
 * The one place the production gate's calibration is chosen. The gate spreads
 * this constant (it has no `calibration:` argument of its own), and the spy
 * test and self-test A exercise `PRODUCTION_GATE.calibration`, so changing the
 * gate's calibration changes what those tests check.
 */
const PRODUCTION_GATE = {
  /** Scheduler-independent CPU workload; must never call generate(). */
  calibration: runCalibrationWorkload,
  refMs: CALIBRATION_REF_MS,
} as const;

/**
 * Small input (1 task / 1 day, well under 1 ms per generate()) for the
 * self-tests. Small calls allocate little per sample, which keeps concurrent
 * GC helper-thread CPU (counted by process.cpuUsage(), but only partly doubled
 * by the burn) from pulling the slowdown ratio far below 2x.
 */
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
  /** Fixed CPU cost used to normalise the sample. Must not call generate(). */
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
 * Calibrated p95 measurement shared by the production gate and the negative
 * self-tests, so the self-tests exercise the same normalisation the gate
 * asserts on. Both the workload and the calibration are injected.
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

/**
 * Busy-wait on CPU for at least `targetMs`, independent of packages/scheduler.
 * The CPU clock is re-read every 4096 iterations (a few microseconds), so the
 * overshoot stays small even when the target is one small generate() call.
 */
function burnCpuMillis(targetMs: number): void {
  const start = process.cpuUsage();
  let hash = calibrationSink;
  while (cpuMillisSince(start) < targetMs) {
    for (let index = 0; index < 4096; index += 1) {
      hash ^= CALIBRATION_VALUES[index & (CALIBRATION_VALUES.length - 1)]!;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  calibrationSink = (calibrationSink + hash) >>> 0;
}

/** Real generate() followed by a CPU burn of the same length (+100%). */
function slowedGenerate(
  ...args: Parameters<typeof generate>
): ReturnType<typeof generate> {
  const start = process.cpuUsage();
  const result = actualGenerate(...args);
  burnCpuMillis(cpuMillisSince(start));
  return result;
}

/**
 * Runs `run` with *every* call to the mocked `generate` binding slowed by
 * +100%: the workload's calls and any call a calibration makes alike.
 */
function withEveryGenerateSlowed<T>(run: () => T): T {
  generateMock.mockImplementation(slowedGenerate);
  try {
    return run();
  } finally {
    generateMock.mockImplementation(actualGenerate);
  }
}

/**
 * Per-sample slowdown ratios of `workload` as seen through `measureP95` with
 * the given calibration: each sample measures the baseline and the +100%
 * slowed variant back-to-back, so both see the same host load. Both paths are
 * warmed up first so JIT compilation does not inflate the early baselines.
 */
function slowdownRatios(options: {
  workload: () => void;
  calibration: () => void;
  samples: number;
}): number[] {
  const measureOnce = () =>
    measureP95({
      workload: options.workload,
      calibration: options.calibration,
      refMs: PRODUCTION_GATE.refMs,
      batches: 1,
      batchSize: 1,
    }).bestP95;

  for (let warmUp = 0; warmUp < 3; warmUp += 1) {
    measureOnce();
    withEveryGenerateSlowed(measureOnce);
  }

  const ratios: number[] = [];
  for (let run = 0; run < options.samples; run += 1) {
    generateMock.mockClear();
    const baseline = measureOnce();
    const slowed = withEveryGenerateSlowed(measureOnce);
    ratios.push(slowed / baseline);
  }
  generateMock.mockClear();
  return ratios;
}

function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function formatRatios(values: number[]): string {
  return values.map((value) => value.toFixed(2)).join(',');
}

/** `count` real generate() calls on the self-test input (via the mock). */
function repeatSelfTestGenerate(input: ScheduleInput, count: number): void {
  for (let repeat = 0; repeat < count; repeat += 1) {
    generate(input, { policies: ['balanced'], seed: input.seed });
  }
}

/**
 * Self-test scheduler workload: 100 small generate() calls per sample, so
 * per-sample CPU noise cannot swamp the slowdown ratio.
 */
function selfTestWorkload(input: ScheduleInput): () => void {
  return () => repeatSelfTestGenerate(input, 100);
}

/**
 * Self-test B's calibration: the c12ff8f mistake of calibrating with
 * generate() itself. It makes the same small calls as the workload (20 of
 * them, about the cost of runCalibrationWorkload) so the +100% burn is applied
 * at the same per-call granularity on both sides of B's ratio.
 */
function generateBasedCalibration(input: ScheduleInput): () => void {
  return () => repeatSelfTestGenerate(input, 20);
}

describe('generator performance (06 §11)', () => {
  beforeEach(() => {
    generateMock.mockClear();
    generateMock.mockImplementation(actualGenerate);
  });

  it('50 tasks / 14 days / 3 policies p95 < 500 ms (calibrated CPU time)', () => {
    const input = buildLargeInput();
    const measured = measureP95({
      ...PRODUCTION_GATE,
      workload: () => {
        const result = generate(input, {
          policies: ['front_loaded', 'balanced', 'focus_blocked'],
          seed: input.seed,
        });
        // Only the calibration and this call have run since the previous
        // sample, so exactly one generate() call means the calibration made
        // none. (Clearing here also stops vi.fn from retaining every result.)
        expect(generateMock).toHaveBeenCalledTimes(1);
        generateMock.mockClear();
        expect(result.candidates.map((candidate) => candidate.feasible)).toEqual([
          true,
          true,
          true,
        ]);
      },
      batches: 5,
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

  it('the production calibration never calls generate() (spy on the generate binding)', () => {
    generateMock.mockClear();
    PRODUCTION_GATE.calibration();
    expect(generateMock).not.toHaveBeenCalled();

    // Negative control: the spy is live on the binding a calibration would
    // use, so the assertion above is not vacuous.
    repeatSelfTestGenerate(buildSelfTestInput(), 1);
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('self-test A: a +100% slowdown of every generate() call is detected with the production calibration', () => {
    const ratios = slowdownRatios({
      workload: selfTestWorkload(buildSelfTestInput()),
      calibration: PRODUCTION_GATE.calibration,
      samples: 20,
    });
    const ratio = median(ratios);
    console.log(
      `slowdown self-test A (PRODUCTION_GATE.calibration): median ratio=${ratio.toFixed(2)}x samples=[${formatRatios(ratios)}]`,
    );
    // An independent calibration keeps the denominator fixed, so the
    // calibrated time roughly doubles. A calibration that called generate()
    // would be slowed by the same +100% and pull this towards 1x.
    expect(ratio).toBeGreaterThanOrEqual(1.6);
  }, 180000);

  it('self-test B: a generate()-based calibration (the c12ff8f bug) cancels the same slowdown', () => {
    const input = buildSelfTestInput();
    const ratios = slowdownRatios({
      workload: selfTestWorkload(input),
      calibration: generateBasedCalibration(input),
      samples: 20,
    });
    const ratio = median(ratios);
    console.log(
      `slowdown self-test B (generate()-based calibration): median ratio=${ratio.toFixed(2)}x samples=[${formatRatios(ratios)}]`,
    );
    // Positive control for self-test A: the injected slowdown reaches a
    // calibration that calls generate(), so such a calibration hides it.
    expect(ratio).toBeLessThanOrEqual(1.3);
  }, 180000);
});
