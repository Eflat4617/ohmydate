/**
 * Oracle exporter for the Rust scheduler port (blueprint 15 §5).
 *
 * Runs the TypeScript scheduler — the reference implementation — over seeded
 * scenarios and writes inputs with everything it computed for them. The Rust
 * differential tests (`core/crates/scheduler/tests/oracle.rs`) replay each
 * input and must reproduce every value exactly.
 *
 * One output file is a "pack" (`formatVersion` 2):
 *
 *   {
 *     format: "ohmydate-scheduler-oracle", formatVersion: 2,
 *     oracle:  { generatorVersion, policyVersion, node, tzdata, seed, count },
 *     primitives: {
 *       prng:       [{ seed, floats[8], ints: [{ maxExclusive, values[8] }] }],
 *       canonical:  [{ value, text, sha256 }],            // canonicalJson + sha256Hex
 *       instants:   [{ text, epochMs | null, utc | null, subMillisecond }],
 *       zones:      [{ id, valid }],                      // isValidTimeZone
 *       dates:      [{ text, valid, printed | null }],    // Temporal.PlainDate.from
 *       clocks:     [{ text, minutes | null }],           // parseClock
 *       sessions:   [{ breakAfterMin, maxDailyFocusMin, limit | null, autoSplitMin[] }],
 *       partitions: [{ timeZone, start, end, segments[] }] // partitionByLocalDate
 *     },
 *     cases: [                                             // one per line
 *       {
 *         id, kind: "golden" | "generated" | "replan" | "invalid",
 *         input, options | null,
 *         inputIssues[],          // validateInput(input)
 *         slots[] | null,         // computeAvailableSlots(input); null if it throws
 *         deficit | null,         // deficit(input); null if it throws
 *         result,                 // generate(input, options)
 *         validation[],           // validate(input, candidate.blocks, …) per candidate;
 *                                 //   `violations` is null where validate throws
 *         probes[],               // validate() of deliberately broken plans
 *         resultHash              // sha256Hex(canonicalJson(result))
 *       }
 *     ]
 *   }
 *
 * The same seed and count always produce the same pack on the same Node
 * version. `oracle.tzdata` records the IANA database the reference used, so
 * a mismatch caused by time zone data can be told apart from a porting bug.
 *
 * Usage (from the repository root):
 *   corepack pnpm run core:oracle -- [--count 12] [--seed 20261113] [--name sample]
 *                                    [--out core/crates/scheduler/tests/oracle]
 *
 * This file is tooling: it is not imported by the package and is not a test.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATOR_VERSION,
  POLICY_VERSION,
  autoSplitMinSessionMin,
  generate,
  maxLegalSessionMin,
  taskRequiredMinutes,
  type AvailabilityRule,
  type Block,
  type ExceptionRule,
  type GenerateOptions,
  type PolicyName,
  type Preferences,
  type ScheduleInput,
  type Task,
  type Weekday,
  type WindowKind,
} from '../src/index.js';
import { canonicalJson, sha256Hex } from '../src/hash.js';
import { createPrng, type Prng } from '../src/prng.js';
import {
  DAY_MS,
  FORMAT,
  FORMAT_VERSION,
  GRID_MS,
  MINUTE_MS,
  chance,
  evaluate,
  iso,
  orNull,
  packText,
  pick,
  type OracleCase,
} from './oracle-lib.mjs';
import { Temporal } from 'temporal-polyfill';
import {
  instantToUtc,
  isValidTimeZone,
  parseClock,
  parseInstant,
  partitionByLocalDate,
} from '../src/time.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

interface Args {
  readonly out: string;
  readonly count: number;
  readonly seed: number;
  readonly name: string;
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--') continue;
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) {
      throw new Error(`usage: export-oracle [--out DIR] [--count N] [--seed N] [--name NAME]`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new Error(`--${key} must be an integer in [${min}, ${max}]`);
    }
    return parsed;
  };
  const name = values.get('name') ?? 'sample';
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error('--name must be a short slug');
  return {
    out: resolve(repoRoot, values.get('out') ?? 'core/crates/scheduler/tests/oracle'),
    count: integer('count', 12, 0, 100_000),
    seed: integer('seed', 20_261_113, 0, 0xffff_ffff),
    name,
  };
}

// ---------------------------------------------------------------------------
// Scenario generation. Every choice comes from the scheduler's own mulberry32.
// ---------------------------------------------------------------------------

const ZONES = [
  'Asia/Seoul',
  'America/New_York',
  'Europe/Berlin',
  'America/Santiago',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'UTC',
] as const;

/** Horizon start dates; several sit just before an offset transition of a zone above. */
const START_DATES = [
  '2026-11-13',
  '2026-10-30', // New York leaves DST on 2026-11-01, Berlin on 2026-10-25
  '2026-03-06', // New York enters DST on 2026-03-08, St. John's too
  '2026-09-04', // Santiago enters DST on 2026-09-06 (midnight gap)
  '2026-04-03', // Lord Howe leaves DST on 2026-04-05 (30-minute step)
  '2026-03-27', // Berlin enters DST on 2026-03-29
  '2026-12-28', // year boundary
] as const;

const WINDOWS: ReadonlyArray<readonly [string, string]> = [
  ['09:00', '12:00'],
  ['13:00', '18:00'],
  ['19:00', '22:00'],
  ['08:30', '11:45'],
  ['00:00', '24:00'],
  ['06:00', '07:30'],
  ['09:02', '11:47'], // off the 5-minute grid
];

const PREFERRED: readonly WindowKind[] = ['morning', 'afternoon', 'evening'];
const POLICIES: readonly PolicyName[] = ['front_loaded', 'balanced', 'focus_blocked'];

/** The same instant written with a +09:00 offset, to exercise canonicalisation. */
function isoWithOffset(epochMs: number): string {
  return `${new Date(epochMs + 9 * 60 * MINUTE_MS).toISOString().slice(0, 19)}+09:00`;
}

function generateTasks(prng: Prng, startMs: number, endMs: number, prefs: Preferences): Task[] {
  // A quarter of the cases are overloaded on purpose, so that infeasible
  // candidates, deficits and their explanations are part of the oracle.
  const heavy = chance(prng, 0.25);
  const count = 1 + prng.nextInt(heavy ? 8 : 4);
  const tasks: Task[] = [];
  for (let index = 0; index < count; index += 1) {
    let p50Min = 15 + 5 * prng.nextInt(heavy ? 70 : 20);
    const splittable = chance(prng, 0.7);
    let minSessionMin = pick(prng, [15, 25, 30, 45, 60]);
    let maxSessionMin = Math.max(minSessionMin, pick(prng, [60, 90, 120, 180]));
    // Most tasks are possible on their own: one block fits the break rule and
    // its own bounds, a splittable task is at least one session long. The
    // rest keep whatever was drawn, which is often impossible (H5, H6).
    const sane = chance(prng, 0.85);
    if (sane && !splittable && prefs.breakAfterMin > 0) {
      p50Min = Math.min(p50Min, prefs.breakAfterMin - 10);
    }
    const p90Min =
      p50Min + (sane && !splittable ? 5 * prng.nextInt(3) : 5 * prng.nextInt(heavy ? 25 : 7));
    if (sane) {
      minSessionMin = Math.min(minSessionMin, 5 * Math.floor(p50Min / 5));
      if (!splittable) maxSessionMin = Math.max(maxSessionMin, p90Min);
    }
    const task: Task = {
      id: `t${String(index + 1).padStart(2, '0')}`,
      estimate: { p50Min, p90Min },
      splittable,
      minSessionMin,
      maxSessionMin,
      priority: pick(prng, [1, 2, 3, 4] as const),
      dependsOn: tasks.filter(() => chance(prng, 0.2)).map((earlier) => earlier.id),
    };
    if (chance(prng, 0.6)) {
      const span = endMs - startMs;
      const dueMs =
        startMs + Math.floor((span * (0.5 + 0.5 * prng.next())) / GRID_MS) * GRID_MS;
      task.dueAt = chance(prng, 0.25) ? isoWithOffset(dueMs) : iso(dueMs);
    }
    if (chance(prng, 0.15)) {
      task.earliestStartAt = iso(startMs + prng.nextInt(24) * 60 * MINUTE_MS);
    }
    if (chance(prng, 0.2)) task.bufferBeforeDueMin = pick(prng, [0, 15, 30, 60]);
    if (chance(prng, 0.3)) {
      task.preferredWindows = PREFERRED.filter(() => chance(prng, 0.5));
    }
    // Rarer shapes: estimates off the grid or below one cell, a caller-capped
    // long task (FU-96), a remaining amount that differs from the estimate.
    if (chance(prng, 0.03)) {
      const extra = pick(prng, [1, 2, 3, 4]);
      task.estimate = { p50Min: p50Min + extra, p90Min: p90Min + extra };
    }
    if (chance(prng, 0.015)) task.estimate = { p50Min: 3, p90Min: 4 };
    if (task.splittable && chance(prng, 0.06)) {
      task.autoSplit = chance(prng, 0.5) ? 'break_after' : 'daily_cap';
    }
    if (chance(prng, 0.04)) task.remainingMin = 5 * prng.nextInt(1 + Math.floor(p50Min / 5));
    tasks.push(task);
  }
  return tasks;
}

function generateAvailability(prng: Prng): AvailabilityRule[] {
  const rules: AvailabilityRule[] = [];
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    if (!chance(prng, 0.9)) continue;
    const first = pick(prng, WINDOWS);
    rules.push({
      weekday: weekday as Weekday,
      startLocal: first[0],
      endLocal: first[1],
      kind: chance(prng, 0.3) ? 'focus' : 'work',
    });
    if (chance(prng, 0.4)) {
      const second = pick(prng, WINDOWS);
      rules.push({
        weekday: weekday as Weekday,
        startLocal: second[0],
        endLocal: second[1],
        kind: 'work',
      });
    }
  }
  return rules;
}

function generateInput(prng: Prng): ScheduleInput {
  const startMs = Date.parse(`${pick(prng, START_DATES)}T00:00:00Z`) + prng.nextInt(3) * DAY_MS;
  const endMs = startMs + (4 + prng.nextInt(11)) * DAY_MS;
  const exceptions: ExceptionRule[] = [];
  for (let index = prng.nextInt(3); index > 0; index -= 1) {
    const date = iso(startMs + prng.nextInt(10) * DAY_MS).slice(0, 10);
    const shape = prng.nextInt(4);
    exceptions.push(
      shape === 0
        ? { date, kind: 'off' }
        : shape === 1
          ? { date, kind: 'off', startLocal: '12:00', endLocal: '13:30' }
          : shape === 2
            ? { date, kind: 'extra' }
            : { date, kind: 'extra', startLocal: '20:00', endLocal: '23:00' },
    );
  }
  const commitments = [];
  for (let index = prng.nextInt(5); index > 0; index -= 1) {
    // Some commitments are off the 5-minute grid on purpose.
    const start = startMs + prng.nextInt(Math.floor((endMs - startMs) / MINUTE_MS)) * MINUTE_MS;
    commitments.push({ start: iso(start), end: iso(start + (30 + 5 * prng.nextInt(31)) * MINUTE_MS) });
  }
  const prefs: Preferences = {
    maxDailyFocusMin: pick(prng, [120, 240, 360, 480]),
    breakAfterMin: pick(prng, [0, 50, 60, 90, 120]),
    breakMin: pick(prng, [5, 10, 15]),
    riskLevel: chance(prng, 0.5) ? 'p50' : 'p90',
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
  };
  return {
    now: iso(startMs + prng.nextInt(17) * 30 * MINUTE_MS),
    timeZone: pick(prng, ZONES),
    horizon: { start: iso(startMs), end: iso(endMs) },
    tasks: generateTasks(prng, startMs, endMs, prefs),
    availability: generateAvailability(prng),
    exceptions,
    commitments,
    lockedBlocks: [],
    prefs,
    seed: prng.nextInt(0x7fff_ffff),
  };
}

// ---------------------------------------------------------------------------
// Replans: an approved plan, then one to three things that changed since.
// ---------------------------------------------------------------------------

function minutesOf(block: Block): number {
  return (parseInstant(block.end) - parseInstant(block.start)) / MINUTE_MS;
}

type ReplanChange = (prng: Prng, replan: ScheduleInput, approved: Block[]) => void;

/** A new commitment on top of one approved block. */
const addCommitment: ReplanChange = (prng, replan, approved) => {
  const block = pick(prng, approved);
  replan.commitments = [...replan.commitments, { start: block.start, end: block.end }];
  if (chance(prng, 0.3)) {
    replan.affectedTaskIds = [...(replan.affectedTaskIds ?? []), block.taskId];
  }
};

/**
 * Time has passed: blocks that started before the new `now` are history. For
 * half of the tasks with history the caller sends what is left (06 §7.1).
 */
const advanceNow: ReplanChange = (prng, replan, approved) => {
  const starts = approved.map((block) => parseInstant(block.start)).sort((a, b) => a - b);
  const anchor = starts[prng.nextInt(starts.length)] ?? parseInstant(replan.now);
  const nowMs = Math.max(parseInstant(replan.now), anchor + prng.nextInt(7) * 15 * MINUTE_MS);
  replan.now = iso(nowMs);
  replan.tasks = replan.tasks.map((task) => {
    const historyMin = approved
      .filter((block) => block.taskId === task.id && parseInstant(block.start) < nowMs)
      .reduce((sum, block) => sum + minutesOf(block), 0);
    if (historyMin === 0 || !chance(prng, 0.5)) return task;
    const required = taskRequiredMinutes(task, replan.prefs.riskLevel);
    return { ...task, remainingMin: Math.max(0, required - historyMin) };
  });
};

/** The user locked some approved blocks; half of them also stay in existingBlocks. */
const lockBlocks: ReplanChange = (prng, replan, approved) => {
  const locked = approved.filter(() => chance(prng, 0.3));
  if (locked.length === 0) locked.push(pick(prng, approved));
  replan.lockedBlocks = [...replan.lockedBlocks, ...locked];
  if (chance(prng, 0.5)) {
    replan.existingBlocks = (replan.existingBlocks ?? []).filter((block) => !locked.includes(block));
  }
};

/** A task turned out longer or shorter than estimated. */
const changeEstimate: ReplanChange = (prng, replan) => {
  const index = prng.nextInt(replan.tasks.length);
  replan.tasks = replan.tasks.map((task, position) => {
    if (position !== index) return task;
    const delta = pick(prng, [-30, -15, 15, 30, 60, 120]);
    const p50Min = Math.max(5, task.estimate.p50Min + delta);
    return { ...task, estimate: { p50Min, p90Min: Math.max(p50Min, task.estimate.p90Min + delta) } };
  });
};

/** A new dependency edge between two existing tasks (kept acyclic by id order). */
const addDependency: ReplanChange = (prng, replan) => {
  if (replan.tasks.length < 2) return;
  const later = 1 + prng.nextInt(replan.tasks.length - 1);
  const earlier = replan.tasks[prng.nextInt(later)];
  if (earlier === undefined) return;
  replan.tasks = replan.tasks.map((task, position) =>
    position === later && !task.dependsOn.includes(earlier.id)
      ? { ...task, dependsOn: [...task.dependsOn, earlier.id] }
      : task,
  );
  if (chance(prng, 0.5)) {
    const dependent = replan.tasks[later];
    if (dependent !== undefined) {
      replan.affectedTaskIds = [...(replan.affectedTaskIds ?? []), dependent.id, earlier.id];
    }
  }
};

/** A day with approved work becomes a day off, fully or around noon. */
const addDayOff: ReplanChange = (prng, replan, approved) => {
  const date = Temporal.Instant.from(pick(prng, approved).start)
    .toZonedDateTimeISO(replan.timeZone)
    .toPlainDate()
    .toString();
  replan.exceptions = [
    ...replan.exceptions,
    chance(prng, 0.5)
      ? { date, kind: 'off' }
      : { date, kind: 'off', startLocal: '10:00', endLocal: '15:00' },
  ];
};

/** A task that did not exist when the plan was approved. */
const addTask: ReplanChange = (prng, replan) => {
  const p50Min = 30 + 15 * prng.nextInt(8);
  replan.tasks = [
    ...replan.tasks,
    {
      id: 'new',
      estimate: { p50Min, p90Min: p50Min + 15 },
      splittable: chance(prng, 0.7),
      minSessionMin: 30,
      maxSessionMin: 90,
      priority: pick(prng, [1, 2, 3, 4] as const),
      dependsOn: replan.tasks.filter(() => chance(prng, 0.15)).map((task) => task.id),
    },
  ];
};

/** The caller releases tasks explicitly (FU-59), including one it no longer has. */
const releaseTasks: ReplanChange = (prng, replan) => {
  const ids = replan.tasks.filter(() => chance(prng, 0.3)).map((task) => task.id);
  if (chance(prng, 0.2)) ids.push('gone');
  replan.affectedTaskIds = [...(replan.affectedTaskIds ?? []), ...ids];
};

const REPLAN_CHANGES: readonly ReplanChange[] = [
  addCommitment,
  addCommitment,
  advanceNow,
  advanceNow,
  lockBlocks,
  changeEstimate,
  addDependency,
  addDayOff,
  addTask,
  releaseTasks,
];

function toReplan(prng: Prng, base: ScheduleInput): ScheduleInput | null {
  const feasible = generate(base).candidates.filter(
    (candidate) => candidate.feasible && candidate.blocks.length > 0,
  );
  if (feasible.length === 0) return null;
  const approved = pick(prng, feasible).blocks;
  const replan: ScheduleInput = { ...base, existingBlocks: approved };
  for (let changes = 1 + prng.nextInt(3); changes > 0; changes -= 1) {
    pick(prng, REPLAN_CHANGES)(prng, replan, approved);
  }
  return replan;
}

function invalidVariants(base: ScheduleInput): ScheduleInput[] {
  const first = base.tasks[0];
  if (first === undefined) return [];
  const rest = base.tasks.slice(1);
  const block = { taskId: first.id, start: base.horizon.start, end: base.horizon.end };
  const offGrid = iso(parseInstant(base.horizon.start) + MINUTE_MS);
  return [
    { ...base, timeZone: 'Mars/Olympus_Mons' },
    { ...base, horizon: { start: base.horizon.end, end: base.horizon.start } },
    { ...base, tasks: [...base.tasks, { ...first }] },
    { ...base, tasks: [{ ...first, dependsOn: [first.id] }, ...rest] },
    { ...base, tasks: [{ ...first, estimate: { p50Min: 12.5, p90Min: 1e21 } }, ...rest] },
    { ...base, now: 'yesterday' },
    { ...base, horizon: { start: base.horizon.start, end: '2028-06-01T00:00:00Z' } },
    { ...base, tasks: [{ ...first, dependsOn: ['nobody'] }, ...rest] },
    { ...base, tasks: [{ ...first, minSessionMin: 90, maxSessionMin: 30, bufferBeforeDueMin: -5 }, ...rest] },
    { ...base, tasks: [{ ...first, dueAt: base.horizon.start, earliestStartAt: base.horizon.end }, ...rest] },
    { ...base, tasks: [{ ...first, dueAt: '2026-13-01T00:00:00Z' }, ...rest] },
    { ...base, prefs: { ...base.prefs, maxDailyFocusMin: 240.5, breakMin: -1 } },
    {
      ...base,
      availability: [
        ...base.availability,
        { weekday: 9 as Weekday, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
        { weekday: 1, startLocal: '18:00', endLocal: '09:00', kind: 'work' },
        { weekday: 2, startLocal: '9am', endLocal: '24:30', kind: 'focus' },
      ],
    },
    {
      ...base,
      exceptions: [
        ...base.exceptions,
        { date: '2026-02-30', kind: 'off' },
        { date: base.horizon.start.slice(0, 10), kind: 'extra', startLocal: '10:00' },
        { date: base.horizon.start.slice(0, 10), kind: 'off', startLocal: '15:00', endLocal: '14:00' },
      ],
    },
    {
      ...base,
      commitments: [
        ...base.commitments,
        { start: 'soon', end: base.horizon.end },
        { start: base.horizon.end, end: base.horizon.start },
      ],
    },
    { ...base, lockedBlocks: [{ ...block, taskId: 'nobody' }] },
    { ...base, lockedBlocks: [{ ...block, start: offGrid }] },
    { ...base, existingBlocks: [{ ...block, start: `${base.horizon.start.slice(0, 19)}.0001Z` }] },
    { ...base, existingBlocks: [{ ...block, start: base.horizon.end, end: base.horizon.start }] },
    { ...base, existingBlocks: [{ ...block, end: 'later' }] },
    { ...base, horizon: { start: 'whenever', end: base.horizon.end } },
    { ...base, tasks: [{ ...first, minSessionMin: 22.5, maxSessionMin: 1e9 }, ...rest] },
    // The span cap of a commitment only applies when the horizon cannot clip it.
    {
      ...base,
      horizon: { start: base.horizon.end, end: base.horizon.start },
      commitments: [{ start: '2020-01-01T00:00:00Z', end: '2030-01-01T00:00:00Z' }],
    },
    { ...base, existingBlocks: [{ ...block, end: iso(parseInstant(base.horizon.start) + 367 * DAY_MS) }] },
  ];
}

function generateOptions(prng: Prng): GenerateOptions | null {
  if (!chance(prng, 0.3)) return null;
  const options: GenerateOptions = {};
  if (chance(prng, 0.5)) options.policies = POLICIES.filter(() => chance(prng, 0.6));
  if (chance(prng, 0.5)) options.maxLocalImprovement = pick(prng, [0, 50]);
  if (chance(prng, 0.3)) options.seed = prng.nextInt(0x7fff_ffff);
  return options;
}

function goldenCases(): OracleCase[] {
  const directory = join(scriptDir, '../test/golden');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file, index) => {
      const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as {
        id: string;
        input: ScheduleInput;
      };
      return {
        id: `golden-${fixture.id}`,
        kind: 'golden' as const,
        input: fixture.input,
        options: null,
        probeSeed: 0x51ed_270b + index,
      };
    });
}

function generatedCases(masterSeed: number, count: number): OracleCase[] {
  const cases: OracleCase[] = [];
  for (let index = 0; index < count; index += 1) {
    // One independent stream per case: case N does not change when the count does.
    const caseSeed = (masterSeed + 0x9e37_79b9 * (index + 1)) >>> 0;
    const prng = createPrng(caseSeed);
    const probeSeed = (caseSeed ^ 0x5bd1_e995) >>> 0;
    const id = String(index + 1).padStart(6, '0');
    const base = generateInput(prng);
    const options = generateOptions(prng);
    if (index % 3 === 1) {
      const replan = toReplan(prng, base);
      if (replan !== null) {
        cases.push({ id: `replan-${id}`, kind: 'replan', input: replan, options, probeSeed });
        continue;
      }
    }
    if (index % 6 === 5) {
      const variants = invalidVariants(base);
      const variant = variants[prng.nextInt(variants.length)];
      if (variant !== undefined) {
        cases.push({ id: `invalid-${id}`, kind: 'invalid', input: variant, options, probeSeed });
        continue;
      }
    }
    cases.push({ id: `gen-${id}`, kind: 'generated', input: base, options, probeSeed });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// Primitives: small, exact checks for the lowest layers of the port.
// ---------------------------------------------------------------------------

function prngPrimitives(): unknown[] {
  return [0, 1, 42, 7919, 15_486, 0x7fff_ffff, 0xffff_ffff, -1, 2.9, 20_261_113].map((seed) => {
    const floats = createPrng(seed);
    return {
      seed,
      floats: Array.from({ length: 8 }, () => floats.next()),
      ints: [1, 2, 7, 200, 1_000_000].map((maxExclusive) => {
        const ints = createPrng(seed);
        return { maxExclusive, values: Array.from({ length: 8 }, () => ints.nextInt(maxExclusive)) };
      }),
    };
  });
}

function canonicalPrimitives(): unknown[] {
  const values: unknown[] = [
    null,
    true,
    0,
    -0,
    1,
    -17,
    0.1,
    1.5,
    12.5,
    1e21,
    1e-7,
    123456789012345680000,
    0.000001,
    5e-324,
    1.7976931348623157e308,
    2 ** 53,
    '',
    'plain',
    'quote " backslash \\ slash /',
    'control \u0000 \u0001 \b \f \n \r \t \u001f',
    'line separators     and del \u007f',
    '한글 😀 é',
    [],
    {},
    [1, [2, [3]], { b: 1, a: 2 }],
    { b: 1, a: { d: [true, null], c: 'x' }, 'A': 0, '10': 1, '9': 2, '': 3, 'é': 4, 'z\u0000': 5 },
    { taskId: 't01', start: '2026-11-13T00:00:00Z', end: '2026-11-13T00:30:00Z' },
  ];
  return values.map((value) => {
    const text = canonicalJson(value);
    return { value, text, sha256: sha256Hex(text) };
  });
}

/**
 * Spellings `Temporal.Instant.from` takes or refuses. Left out on purpose:
 * years outside 0000–9999 and the critical flag (`[!u-ca=…]`), where the Rust
 * side is documented to differ (blueprint 15 §5.2).
 */
function instantPrimitives(): unknown[] {
  return [
    '2026-11-13T00:00:00Z',
    '2026-11-13T00:00:00.000Z',
    '2026-11-13T09:00:00+09:00',
    '2026-11-13T00:00:00.5Z',
    '2026-11-13T00:00:00.120Z',
    '2026-11-13T00:00:00.123456Z',
    '2026-11-12T19:00:00-05:00',
    '1970-01-01T00:00:00Z',
    '2026-11-13T00:00Z',
    '2026-11-13',
    'not an instant',
    '',
    '2026-11-13t00:00:00z',
    '2026-11-13 00:00:00Z',
    '2026-11-13T00:00:00,5Z',
    '20261113T000000Z',
    '2026-11-13T000000Z',
    '2026-11-13T0000Z',
    '20261113T00:00:00Z',
    '2026-11-13T00Z',
    '2026-11-13T00:00:00+0900',
    '2026-11-13T00:00:00+09',
    '2026-11-13T00:00:00-00:00',
    '2026-11-13T00:00:00+09:00:00',
    '2026-11-13T00:00:00+09:00:30',
    '2026-11-13T00:00:00+09:00[Asia/Seoul]',
    '2026-11-13T00:00:00+09:00[America/New_York]',
    '2026-11-13T00:00:00Z[UTC]',
    '2026-11-13T00:00:00Z[Mars/Olympus]',
    '2026-11-13T00:00:00Z[u-ca=iso8601]',
    '2026-11-13T00:00:60Z',
    '2026-11-13T24:00:00Z',
    '2026-11-13T00:00:00.123456789Z',
    '2026-11-13T00:00:00.1234Z',
    '2026-11-13T00:00:00.000000001Z',
    '1969-12-31T23:59:59.9995Z',
    '1969-12-31T23:59:59.999Z',
    '+002026-11-13T00:00:00Z',
    '0000-01-01T00:00:00Z',
    '0099-03-01T00:00:00Z',
    ' 2026-11-13T00:00:00Z',
    '2026-11-13T00:00:00Z ',
    '2026-02-30T00:00:00Z',
    '2026-11-13T00:00:00',
    '2026-11-13T00:00:00[Asia/Seoul]',
    '2026-W46-5T00:00:00Z',
    '2026-11-13T00:00:00.Z',
    '2026-11-13T00:00:00−09:00',
    '2026-11-13T25:00:00Z',
    '2026-11-13T00:61:00Z',
  ].map((text) => {
    let subMillisecond = false;
    try {
      subMillisecond = Temporal.Instant.from(text).epochNanoseconds % 1_000_000n !== 0n;
    } catch {
      // Not an instant at all.
    }
    try {
      const epochMs = parseInstant(text);
      return { text, epochMs, utc: instantToUtc(epochMs), subMillisecond };
    } catch {
      return { text, epochMs: null, utc: null, subMillisecond };
    }
  });
}

function zonePrimitives(): unknown[] {
  return [
    'Asia/Seoul',
    'asia/seoul',
    'ASIA/SEOUL',
    'UTC',
    'utc',
    'GMT',
    'Etc/UTC',
    'Etc/GMT+5',
    'Etc/GMT-14',
    'US/Eastern',
    'Asia/Calcutta',
    'Asia/Saigon',
    'Europe/Kyiv',
    'Europe/Kiev',
    'America/Buenos_Aires',
    'America/Ciudad_Juarez',
    'Antarctica/Troll',
    'EST',
    'EST5EDT',
    'PST8PDT',
    'CET',
    'ROK',
    'Japan',
    'W-SU',
    '+09:00',
    '+0900',
    '+09',
    '-05:30',
    '-00:00',
    '+23:59',
    '2026-11-13T00:00:00+09:00[Asia/Seoul]',
    '2026-11-13T00:00:00Z',
    '2026-11-13T00:00:00+05:30',
    'Z',
    '',
    ' Asia/Seoul',
    'Asia/Seoul ',
    'Mars/Olympus_Mons',
    '+09:00:00',
    '+09:00:30',
    '+24:00',
    '+09:60',
    '+9',
    '09:00',
    'UTC+9',
    'GMT+9',
    'Etc/Unknown',
    'Factory',
    'posixrules',
    'local',
    'Asia/Seoul[u-ca=iso8601]',
    '2026-11-13T00:00:00',
    '2026-11-13T00:00:00+09:00[Mars/Olympus_Mons]',
    '2026-11-13T00:00:00+09:00:30',
  ].map((id) => ({ id, valid: isValidTimeZone(id) }));
}

function datePrimitives(): unknown[] {
  return [
    '2026-11-13',
    '2024-02-29',
    '2026-02-28',
    '2026-11-13T10:00',
    '2026-11-13 10:00',
    '2026-11-13T10:00:60',
    '2026-11-13T10:00+09:00',
    '2026-11-13[Asia/Seoul]',
    '2026-11-13[u-ca=iso8601]',
    '20261113',
    '+002026-11-13',
    '0000-01-01',
    '2026-11-13Z',
    '2026-11-13T10:00Z',
    '2026-11-13T24:00',
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-11-00',
    '2026-11',
    '11-13',
    '2026-1-3',
    '2026/11/13',
    ' 2026-11-13',
    '2026-11-13 ',
    '',
    'today',
  ].map((text) => {
    try {
      return { text, valid: true, printed: Temporal.PlainDate.from(text).toString() };
    } catch {
      return { text, valid: false, printed: null };
    }
  });
}

function clockPrimitives(): unknown[] {
  return [
    '00:00',
    '09:00',
    '9:00',
    '0:05',
    '23:59',
    '24:00',
    '24:01',
    '25:00',
    '9:5',
    '09:60',
    '09:99',
    ' 09:00',
    '09:00 ',
    '09:00\n',
    '099:00',
    '-1:00',
    '+9:00',
    '09:00:00',
    '0900',
    '9',
    '',
    ':',
    '٠٩:٠٠',
  ].map((text) => ({
    text,
    minutes: orNull(() => {
      const clock = parseClock(text);
      return clock.hour * 60 + clock.minute;
    }),
  }));
}

function sessionPrimitives(): unknown[] {
  const pairs: ReadonlyArray<readonly [number, number]> = [
    [90, 240],
    [300, 240],
    [120, 120],
    [0, 240],
    [-5, 240],
    [52, 240],
    [90, 44.9],
    [5, 240],
    [4, 240],
    [90, 0],
    [90, -30],
    [50, 120],
    [60, 360],
    [7.5, 12.5],
    [100_000, 100_000],
  ];
  return pairs.map(([breakAfterMin, maxDailyFocusMin]) => {
    const limit = maxLegalSessionMin({ breakAfterMin, maxDailyFocusMin }) ?? null;
    return {
      breakAfterMin,
      maxDailyFocusMin,
      limit,
      autoSplitMin:
        limit === null
          ? []
          : [0, 5, 15, 25, 30, 45, 60, 240].map((defaultMin) => ({
              defaultMin,
              minSessionMin: autoSplitMinSessionMin(limit.capMin, defaultMin),
            })),
    };
  });
}

function partitionPrimitives(): unknown[] {
  // ADR-017 fixed cases plus plain ones. Each range is partitioned into pieces
  // that lie on exactly one local date under one UTC offset.
  const ranges: ReadonlyArray<readonly [string, string, string]> = [
    ['Asia/Seoul', '2026-11-12T10:00:00Z', '2026-11-15T20:00:00Z'],
    ['UTC', '2026-12-30T00:00:00Z', '2027-01-02T00:00:00Z'],
    ['America/New_York', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'],
    ['America/New_York', '2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'],
    ['America/Santiago', '2026-09-05T00:00:00Z', '2026-09-08T00:00:00Z'],
    ['America/Santiago', '2026-04-04T00:00:00Z', '2026-04-06T12:00:00Z'],
    ['America/Goose_Bay', '2009-10-31T00:00:00Z', '2009-11-03T00:00:00Z'],
    ['America/St_Johns', '2026-03-07T12:00:00Z', '2026-03-09T12:00:00Z'],
    ['America/St_Johns', '2026-10-31T12:00:00Z', '2026-11-02T12:00:00Z'],
    ['Australia/Lord_Howe', '2026-04-03T12:00:00Z', '2026-04-06T12:00:00Z'],
    ['Australia/Lord_Howe', '2026-10-02T12:00:00Z', '2026-10-05T12:00:00Z'],
    ['Europe/Berlin', '2026-03-28T00:00:00Z', '2026-03-30T12:00:00Z'],
    ['Europe/Berlin', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['Pacific/Apia', '2011-12-29T00:00:00Z', '2012-01-01T00:00:00Z'],
    ['Asia/Kolkata', '2026-06-01T18:29:00Z', '2026-06-01T18:31:00Z'],
    ['Asia/Seoul', '2026-11-13T00:00:00Z', '2026-11-13T00:00:00Z'],
    // Offsets that are not whole minutes or hours, and zones given as offsets.
    ['Asia/Seoul', '1908-03-31T00:00:00Z', '1908-04-02T00:00:00Z'],
    ['Africa/Monrovia', '1972-01-06T00:00:00Z', '1972-01-08T00:00:00Z'],
    ['Asia/Kathmandu', '2026-11-13T00:00:00Z', '2026-11-15T00:00:00Z'],
    ['+09:00', '2026-11-13T00:00:00Z', '2026-11-14T12:00:00Z'],
    ['-05:30', '2026-11-13T00:00:00Z', '2026-11-14T12:00:00Z'],
    ['asia/seoul', '2026-11-13T00:00:00Z', '2026-11-14T00:00:00Z'],
    // Other rule shapes: Ramadan in Morocco, Seoul's 1988 DST, a two-hour step.
    ['Africa/Casablanca', '2026-02-13T00:00:00Z', '2026-02-17T00:00:00Z'],
    ['Africa/Casablanca', '2026-03-20T00:00:00Z', '2026-03-24T00:00:00Z'],
    ['Asia/Seoul', '1988-05-07T00:00:00Z', '1988-05-09T00:00:00Z'],
    ['Antarctica/Troll', '2026-03-28T00:00:00Z', '2026-03-30T00:00:00Z'],
    // Beyond the tables: the recurring rule of the zone.
    ['America/New_York', '2037-10-30T00:00:00Z', '2037-11-03T00:00:00Z'],
    ['America/New_York', '2100-03-12T00:00:00Z', '2100-03-16T00:00:00Z'],
    ['Europe/Berlin', '2060-03-27T00:00:00Z', '2060-03-29T00:00:00Z'],
  ];
  return ranges.map(([timeZone, start, end]) => ({
    timeZone,
    start,
    end,
    segments: partitionByLocalDate(Date.parse(start), Date.parse(end), timeZone),
  }));
}

// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cases = [...goldenCases(), ...generatedCases(args.seed, args.count)];
  const header = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    oracle: {
      generatorVersion: GENERATOR_VERSION,
      policyVersion: POLICY_VERSION,
      node: process.version,
      tzdata: process.versions['tz'] ?? 'unknown',
      seed: args.seed,
      count: cases.length,
    },
    primitives: {
      prng: prngPrimitives(),
      canonical: canonicalPrimitives(),
      instants: instantPrimitives(),
      zones: zonePrimitives(),
      dates: datePrimitives(),
      clocks: clockPrimitives(),
      sessions: sessionPrimitives(),
      partitions: partitionPrimitives(),
    },
  };
  const text = packText(header, cases.map(evaluate));
  mkdirSync(args.out, { recursive: true });
  const file = join(args.out, `${args.name}.json`);
  writeFileSync(file, text);
  const kinds = new Map<string, number>();
  for (const testCase of cases) kinds.set(testCase.kind, (kinds.get(testCase.kind) ?? 0) + 1);
  console.log(
    `wrote ${file}: ${cases.length} cases (${[...kinds].map(([kind, n]) => `${kind} ${n}`).join(', ')}), ` +
      `${Math.round(Buffer.byteLength(text) / 1024)} KiB, tzdata ${header.oracle.tzdata}`,
  );
}

main();
