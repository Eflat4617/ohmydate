/**
 * Oracle exporter for the Rust scheduler port (RC-00, blueprint 15 §5).
 *
 * Runs the TypeScript scheduler — the reference implementation — over seeded
 * scenarios and writes inputs with everything it computed for them. The Rust
 * differential tests (`core/crates/scheduler/tests/oracle.rs`) replay each
 * input and must reproduce every value exactly.
 *
 * One output file is a "pack":
 *
 *   {
 *     format: "ohmydate-scheduler-oracle", formatVersion: 1,
 *     oracle:  { generatorVersion, policyVersion, node, tzdata, seed, count },
 *     primitives: {
 *       prng:       [{ seed, floats[8], ints: [{ maxExclusive, values[8] }] }],
 *       canonical:  [{ value, text, sha256 }],            // canonicalJson + sha256Hex
 *       instants:   [{ text, epochMs | null, utc }],      // parseInstant + instantToUtc
 *       partitions: [{ timeZone, start, end, segments[] }] // partitionByLocalDate
 *     },
 *     cases: [{
 *       id, kind: "golden" | "generated" | "replan" | "invalid",
 *       input, options | null,
 *       inputIssues[],          // validateInput(input)
 *       slots[] | null,         // computeAvailableSlots(input); null if it throws
 *       result,                 // generate(input, options)
 *       validation[],           // validate(input, candidate.blocks, …) per candidate
 *       resultHash              // sha256Hex(canonicalJson(result))
 *     }]
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
  computeAvailableSlots,
  generate,
  validate,
  validateInput,
  type AvailabilityRule,
  type Block,
  type ExceptionRule,
  type GenerateOptions,
  type PolicyName,
  type ScheduleInput,
  type Task,
  type Weekday,
  type WindowKind,
} from '../src/index.js';
import { canonicalJson, sha256Hex } from '../src/hash.js';
import { createPrng, type Prng } from '../src/prng.js';
import { instantToUtc, parseInstant, partitionByLocalDate } from '../src/time.js';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const GRID_MS = 5 * MINUTE_MS;

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
];

const PREFERRED: readonly WindowKind[] = ['morning', 'afternoon', 'evening'];
const POLICIES: readonly PolicyName[] = ['front_loaded', 'balanced', 'focus_blocked'];

function pick<T>(prng: Prng, items: readonly T[]): T {
  const item = items[prng.nextInt(items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function chance(prng: Prng, probability: number): boolean {
  return prng.next() < probability;
}

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** The same instant written with a +09:00 offset, to exercise canonicalisation. */
function isoWithOffset(epochMs: number): string {
  return `${new Date(epochMs + 9 * 60 * MINUTE_MS).toISOString().slice(0, 19)}+09:00`;
}

function generateTasks(prng: Prng, startMs: number, endMs: number): Task[] {
  // A quarter of the cases are overloaded on purpose, so that infeasible
  // candidates, deficits and their explanations are part of the oracle.
  const heavy = chance(prng, 0.25);
  const count = 1 + prng.nextInt(heavy ? 8 : 4);
  const tasks: Task[] = [];
  for (let index = 0; index < count; index += 1) {
    const p50Min = 15 + 5 * prng.nextInt(heavy ? 70 : 20);
    const minSessionMin = pick(prng, [15, 25, 30, 45, 60]);
    const maxSessionMin = Math.max(minSessionMin, pick(prng, [60, 90, 120, 180]));
    const task: Task = {
      id: `t${String(index + 1).padStart(2, '0')}`,
      estimate: { p50Min, p90Min: p50Min + 5 * prng.nextInt(heavy ? 25 : 7) },
      splittable: chance(prng, 0.7),
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
    exceptions.push(
      chance(prng, 0.5)
        ? { date, kind: 'off' }
        : { date, kind: 'extra', startLocal: '20:00', endLocal: '23:00' },
    );
  }
  const commitments = [];
  for (let index = prng.nextInt(5); index > 0; index -= 1) {
    // Some commitments are off the 5-minute grid on purpose.
    const start = startMs + prng.nextInt(Math.floor((endMs - startMs) / MINUTE_MS)) * MINUTE_MS;
    commitments.push({ start: iso(start), end: iso(start + (30 + 5 * prng.nextInt(31)) * MINUTE_MS) });
  }
  return {
    now: iso(startMs + prng.nextInt(17) * 30 * MINUTE_MS),
    timeZone: pick(prng, ZONES),
    horizon: { start: iso(startMs), end: iso(endMs) },
    tasks: generateTasks(prng, startMs, endMs),
    availability: generateAvailability(prng),
    exceptions,
    commitments,
    lockedBlocks: [],
    prefs: {
      maxDailyFocusMin: pick(prng, [120, 240, 360, 480]),
      breakAfterMin: pick(prng, [0, 50, 60, 90, 120]),
      breakMin: pick(prng, [5, 10, 15]),
      riskLevel: chance(prng, 0.5) ? 'p50' : 'p90',
      dayStartLocal: '08:00',
      dayEndLocal: '18:00',
    },
    seed: prng.nextInt(0x7fff_ffff),
  };
}

/** A replan: an approved plan, then a new commitment on top of its first block. */
function toReplan(prng: Prng, base: ScheduleInput): ScheduleInput | null {
  const approved = generate(base).candidates.find(
    (candidate) => candidate.feasible && candidate.blocks.length > 0,
  );
  const first = approved?.blocks[0];
  if (approved === undefined || first === undefined) return null;
  const replan: ScheduleInput = {
    ...base,
    existingBlocks: approved.blocks,
    commitments: [...base.commitments, { start: first.start, end: first.end }],
  };
  if (chance(prng, 0.3)) replan.affectedTaskIds = [first.taskId];
  return replan;
}

function invalidVariants(base: ScheduleInput): ScheduleInput[] {
  const first = base.tasks[0];
  if (first === undefined) return [];
  return [
    { ...base, timeZone: 'Mars/Olympus_Mons' },
    { ...base, horizon: { start: base.horizon.end, end: base.horizon.start } },
    { ...base, tasks: [...base.tasks, { ...first }] },
    { ...base, tasks: [{ ...first, dependsOn: [first.id] }, ...base.tasks.slice(1)] },
    { ...base, tasks: [{ ...first, estimate: { p50Min: 12.5, p90Min: 1e21 } }, ...base.tasks.slice(1)] },
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

// ---------------------------------------------------------------------------
// Reference evaluation.
// ---------------------------------------------------------------------------

interface OracleCase {
  readonly id: string;
  readonly kind: 'golden' | 'generated' | 'replan' | 'invalid';
  readonly input: ScheduleInput;
  readonly options: GenerateOptions | null;
}

function historyBlocks(input: ScheduleInput): Block[] {
  try {
    const nowMs = parseInstant(input.now);
    return (input.existingBlocks ?? []).filter((block) => parseInstant(block.start) < nowMs);
  } catch {
    return [];
  }
}

function evaluate(testCase: OracleCase): Record<string, unknown> {
  const { input, options } = testCase;
  const result = generate(input, options ?? {});
  const slots = ((): unknown => {
    try {
      return computeAvailableSlots(input);
    } catch {
      return null;
    }
  })();
  const inputIssues = validateInput(input);
  const history = historyBlocks(input);
  const validation = result.candidates.map((candidate) => ({
    policy: candidate.policy,
    violations:
      inputIssues.length > 0
        ? null
        : validate(input, candidate.blocks, {
            riskLevel: input.prefs.riskLevel,
            historyBlocks: history,
          }).map(({ code, message, messageCode, params, taskId }) => ({
            code,
            message,
            messageCode,
            params,
            ...(taskId === undefined ? {} : { taskId }),
          })),
  }));
  return {
    id: testCase.id,
    kind: testCase.kind,
    input,
    options,
    inputIssues,
    slots,
    result,
    validation,
    resultHash: sha256Hex(canonicalJson(result)),
  };
}

function goldenCases(): OracleCase[] {
  const directory = join(scriptDir, '../test/golden');
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const fixture = JSON.parse(readFileSync(join(directory, file), 'utf8')) as {
        id: string;
        input: ScheduleInput;
      };
      return { id: `golden-${fixture.id}`, kind: 'golden' as const, input: fixture.input, options: null };
    });
}

function generatedCases(masterSeed: number, count: number): OracleCase[] {
  const cases: OracleCase[] = [];
  for (let index = 0; index < count; index += 1) {
    // One independent stream per case: case N does not change when the count does.
    const prng = createPrng((masterSeed + 0x9e37_79b9 * (index + 1)) >>> 0);
    const id = String(index + 1).padStart(6, '0');
    const base = generateInput(prng);
    const options = generateOptions(prng);
    if (index % 3 === 1) {
      const replan = toReplan(prng, base);
      if (replan !== null) {
        cases.push({ id: `replan-${id}`, kind: 'replan', input: replan, options });
        continue;
      }
    }
    if (index % 6 === 5) {
      const variants = invalidVariants(base);
      const variant = variants[prng.nextInt(variants.length)];
      if (variant !== undefined) {
        cases.push({ id: `invalid-${id}`, kind: 'invalid', input: variant, options });
        continue;
      }
    }
    cases.push({ id: `gen-${id}`, kind: 'generated', input: base, options });
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
  ].map((text) => {
    try {
      const epochMs = parseInstant(text);
      return { text, epochMs, utc: instantToUtc(epochMs) };
    } catch {
      return { text, epochMs: null, utc: null };
    }
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
    format: 'ohmydate-scheduler-oracle',
    formatVersion: 1,
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
      partitions: partitionPrimitives(),
    },
  };
  // One case per line keeps the committed sample reviewable and diffable.
  const lines = cases.map((testCase) => JSON.stringify(evaluate(testCase)));
  const head = JSON.stringify(header, null, 1).replace(/\n}$/, '');
  const text = `${head},\n "cases": [\n${lines.join(',\n')}\n ]\n}\n`;
  JSON.parse(text);
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
