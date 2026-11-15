/**
 * Oracle shrinker for the Rust scheduler port (blueprint 15 §5.3, R2).
 *
 * Takes one case on which the Rust scheduler and the TypeScript reference
 * differ and makes its input as small as it can while they still differ
 * (delta debugging): tasks, availability rules, exceptions, commitments and
 * blocks are removed, optional fields dropped, and every change is kept only
 * if the two implementations still disagree in the same layer. The result is
 * written as a one-case pack for `core/crates/scheduler/tests/oracle/regressions/`,
 * with the reference's values, so it fails until the port is fixed and guards
 * the fix afterwards.
 *
 * The Rust side is the `sched-diff` binary (input JSON → layers JSON); build
 * it first, or use `corepack pnpm run core:shrink`, which does.
 *
 * Usage (from the repository root):
 *   corepack pnpm run core:shrink -- --pack core/target/oracle/diff.json --case gen-000123
 *                                    [--layer any|inputIssues|slots|deficit|validation|result]
 *                                    [--name gen-000123] [--note "what was wrong"]
 *                                    [--out core/crates/scheduler/tests/oracle/regressions]
 *   corepack pnpm run core:shrink -- --self-test
 *
 * Exit codes: 0 a shrunk pack was written (or the self-test passed), 1 the
 * case does not differ (nothing to shrink) or the self-test failed, 2 usage.
 *
 * This file is tooling: it is not imported by the package and is not a test.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  GENERATOR_VERSION,
  POLICY_VERSION,
  type Block,
  type GenerateOptions,
  type GenerateResult,
  type ScheduleInput,
  type Task,
} from '../src/index.js';
import { canonicalJson } from '../src/hash.js';
import { createPrng } from '../src/prng.js';
import {
  FORMAT,
  FORMAT_VERSION,
  evaluate,
  packText,
  probePlans,
  referenceLayers,
  type OracleCase,
} from './oracle-lib.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const SCHED_DIFF = join(repoRoot, 'core/target/debug/sched-diff');

/** Layers in comparison order; the first that differs names the mismatch. */
const LAYERS = ['shape', 'inputIssues', 'slots', 'deficit', 'validation', 'result'] as const;
type Layer = (typeof LAYERS)[number];

interface Subject {
  readonly input: ScheduleInput;
  readonly options: GenerateOptions | null;
}

/** The first layer in which the two implementations differ, or null. */
type Differ = (subject: Subject) => Layer | null;

const PROBE_SEED = 0x0dd5_eed5;

/** The plans both sides audit: the reference's candidates and broken variants of them. */
function plansOf(subject: Subject, result: GenerateResult): Block[][] {
  const candidates = result.candidates.map((candidate) => candidate.blocks);
  return [...candidates, ...probePlans(createPrng(PROBE_SEED), subject.input, candidates)];
}

function runRust(document: unknown): Record<string, unknown> | null {
  const run = spawnSync(SCHED_DIFF, [], {
    input: JSON.stringify(document),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.error !== undefined) throw run.error;
  if (run.status !== 0) return null;
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

/** Compares the reference with `sched-diff`, layer by layer. */
const differsFromRust: Differ = (subject) => {
  // The reference generates first: its candidates are among the audited plans.
  const blank = referenceLayers(subject.input, subject.options, []);
  const plans = plansOf(subject, blank['result'] as GenerateResult);
  const reference = referenceLayers(subject.input, subject.options, plans);
  const rust = runRust({ input: subject.input, options: subject.options, plans });
  if (rust === null) return 'shape';
  for (const layer of ['inputIssues', 'slots', 'deficit'] as const) {
    if (canonicalJson(rust[layer]) !== canonicalJson(reference[layer])) return layer;
  }
  if (canonicalJson(rust['plans']) !== canonicalJson(reference['plans'])) return 'validation';
  if (canonicalJson(rust['result']) !== canonicalJson(reference['result'])) return 'result';
  return null;
};

// ---------------------------------------------------------------------------
// Delta debugging.
// ---------------------------------------------------------------------------

type Edit = (subject: Subject) => Subject | null;

function withInput(subject: Subject, input: ScheduleInput): Subject {
  return { input, options: subject.options };
}

/** A copy of `value` without one of its optional fields. */
function omit<T extends object>(value: T, key: keyof T): T {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function without<T>(items: readonly T[], from: number, count: number): T[] {
  return [...items.slice(0, from), ...items.slice(from + count)];
}

/** Removes `count` tasks, and with them every reference to their ids. */
function removeTasks(input: ScheduleInput, from: number, count: number): ScheduleInput {
  const removed = new Set(input.tasks.slice(from, from + count).map((task) => task.id));
  const kept = without(input.tasks, from, count);
  const stillThere = new Set(kept.map((task) => task.id));
  const gone = (id: string): boolean => removed.has(id) && !stillThere.has(id);
  const next: ScheduleInput = {
    ...input,
    tasks: kept.map((task) => ({ ...task, dependsOn: task.dependsOn.filter((id) => !gone(id)) })),
    lockedBlocks: input.lockedBlocks.filter((block) => !gone(block.taskId)),
  };
  if (input.existingBlocks !== undefined) {
    next.existingBlocks = input.existingBlocks.filter((block) => !gone(block.taskId));
  }
  if (input.affectedTaskIds !== undefined) {
    next.affectedTaskIds = input.affectedTaskIds.filter((id) => !gone(id));
  }
  return next;
}

type ListKey = 'availability' | 'exceptions' | 'commitments' | 'lockedBlocks' | 'existingBlocks' | 'affectedTaskIds';
const LIST_KEYS: readonly ListKey[] = [
  'commitments',
  'exceptions',
  'availability',
  'existingBlocks',
  'lockedBlocks',
  'affectedTaskIds',
];

function lengthOf(input: ScheduleInput, key: ListKey | 'tasks'): number {
  return input[key]?.length ?? 0;
}

function removeFrom(input: ScheduleInput, key: ListKey | 'tasks', from: number, count: number): ScheduleInput {
  if (key === 'tasks') return removeTasks(input, from, count);
  const items: readonly unknown[] = input[key] ?? [];
  return { ...input, [key]: without(items, from, count) } as ScheduleInput;
}

const OPTIONAL_TASK_FIELDS = [
  'dueAt',
  'earliestStartAt',
  'remainingMin',
  'bufferBeforeDueMin',
  'preferredWindows',
  'autoSplit',
] as const satisfies ReadonlyArray<keyof Task>;

/** Single-step simplifications tried after the lists cannot shrink further. */
function fieldEdits(subject: Subject): Edit[] {
  const edits: Edit[] = [];
  subject.input.tasks.forEach((task, index) => {
    for (const field of OPTIONAL_TASK_FIELDS) {
      if (task[field] === undefined) continue;
      edits.push((current) => {
        const target = current.input.tasks[index];
        if (target === undefined || target[field] === undefined) return null;
        const rest = omit(target, field);
        const tasks = current.input.tasks.map((entry, position) => (position === index ? rest : entry));
        return withInput(current, { ...current.input, tasks });
      });
    }
    task.dependsOn.forEach((dependency) => {
      edits.push((current) => {
        const target = current.input.tasks[index];
        if (target === undefined || !target.dependsOn.includes(dependency)) return null;
        const tasks = current.input.tasks.map((entry, position) =>
          position === index ? { ...entry, dependsOn: entry.dependsOn.filter((id) => id !== dependency) } : entry,
        );
        return withInput(current, { ...current.input, tasks });
      });
    });
  });
  for (const key of ['existingBlocks', 'affectedTaskIds'] as const) {
    edits.push((current) => {
      if (current.input[key] === undefined || (current.input[key]?.length ?? 0) > 0) return null;
      return withInput(current, omit(current.input, key));
    });
  }
  edits.push((current) => (current.options === null ? null : { input: current.input, options: null }));
  for (const field of ['policies', 'seed', 'maxLocalImprovement'] as const) {
    edits.push((current) => {
      if (current.options === null || current.options[field] === undefined) return null;
      return { input: current.input, options: omit(current.options, field) };
    });
  }
  return edits;
}

interface ShrinkOutcome {
  readonly subject: Subject;
  readonly layer: Layer;
  readonly trials: number;
}

/**
 * Shrinks until no single removal keeps the mismatch. Lists are cut in
 * halves first, then quarters, down to single elements (ddmin), so a large
 * irrelevant part goes in a few trials.
 */
function shrink(start: Subject, differ: Differ, wanted: Layer | 'any'): ShrinkOutcome | null {
  const first = differ(start);
  if (first === null || (wanted !== 'any' && first !== wanted)) return null;
  const target = first;
  let trials = 1;
  let subject = start;
  const keeps = (candidate: Subject): boolean => {
    trials += 1;
    return differ(candidate) === target;
  };

  for (let changed = true; changed; ) {
    changed = false;
    for (const key of ['tasks', ...LIST_KEYS] as const) {
      for (let chunk = Math.max(1, Math.ceil(lengthOf(subject.input, key) / 2)); chunk >= 1; ) {
        let removedAny = false;
        for (let from = 0; from + chunk <= lengthOf(subject.input, key); ) {
          const candidate = withInput(subject, removeFrom(subject.input, key, from, chunk));
          if (keeps(candidate)) {
            subject = candidate;
            removedAny = true;
            changed = true;
          } else {
            from += chunk;
          }
        }
        if (chunk === 1 && !removedAny) break;
        chunk = chunk === 1 ? 1 : Math.ceil(chunk / 2);
        if (lengthOf(subject.input, key) === 0) break;
      }
    }
    for (const edit of fieldEdits(subject)) {
      const candidate = edit(subject);
      if (candidate !== null && keeps(candidate)) {
        subject = candidate;
        changed = true;
      }
    }
  }
  return { subject, layer: target, trials };
}

// ---------------------------------------------------------------------------
// Pack reading and writing.
// ---------------------------------------------------------------------------

async function findCase(packFile: string, caseId: string): Promise<Subject | null> {
  const marker = `{"id":${JSON.stringify(caseId)},`;
  const lines = createInterface({ input: createReadStream(packFile, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.startsWith(marker)) continue;
    const found = JSON.parse(line.replace(/,$/, '')) as Subject;
    lines.close();
    return { input: found.input, options: found.options ?? null };
  }
  return null;
}

function regressionPack(name: string, note: string, source: string, outcome: ShrinkOutcome): string {
  const testCase: OracleCase = {
    id: `regression-${name}`,
    kind: 'generated',
    input: outcome.subject.input,
    options: outcome.subject.options,
    probeSeed: PROBE_SEED,
  };
  const header = {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    oracle: {
      generatorVersion: GENERATOR_VERSION,
      policyVersion: POLICY_VERSION,
      node: process.version,
      tzdata: process.versions['tz'] ?? 'unknown',
      seed: 0,
      count: 1,
      note,
      shrunkFrom: source,
      layer: outcome.layer,
    },
    // A regression pack carries one case; the primitives stay in the sample.
    primitives: {
      prng: [],
      canonical: [],
      instants: [],
      zones: [],
      dates: [],
      clocks: [],
      sessions: [],
      partitions: [],
    },
  };
  return packText(header, [evaluate(testCase)]);
}

function describe(subject: Subject): string {
  const { input } = subject;
  return (
    `${input.tasks.length} task(s), ${input.availability.length} rule(s), ${input.exceptions.length} exception(s), ` +
    `${input.commitments.length} commitment(s), ${input.lockedBlocks.length} locked, ` +
    `${input.existingBlocks?.length ?? 0} existing block(s)`
  );
}

// ---------------------------------------------------------------------------
// Self-test: the shrinking itself, against a mismatch with a known minimum.
// ---------------------------------------------------------------------------

function selfTest(): boolean {
  const weekdays = [1, 2, 3, 4, 5, 6, 7] as const;
  const task = (id: string, extra: Partial<Task> = {}): Task => ({
    id,
    estimate: { p50Min: 60, p90Min: 90 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 2,
    dependsOn: [],
    ...extra,
  });
  const input: ScheduleInput = {
    now: '2026-11-09T00:00:00Z',
    timeZone: 'Asia/Seoul',
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-16T00:00:00Z' },
    tasks: [
      task('a', { dueAt: '2026-11-12T00:00:00Z' }),
      task('b', { dependsOn: ['a'], preferredWindows: ['morning'] }),
      task('culprit', { splittable: false, dependsOn: ['b'], bufferBeforeDueMin: 15, dueAt: '2026-11-14T00:00:00Z' }),
      task('d', { dependsOn: ['culprit'] }),
      task('e'),
    ],
    availability: weekdays.map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '18:00', kind: 'work' as const })),
    exceptions: [
      { date: '2026-11-10', kind: 'extra', startLocal: '20:00', endLocal: '22:00' },
      { date: '2026-11-11', kind: 'off' },
      { date: '2026-11-12', kind: 'extra' },
    ],
    commitments: [
      { start: '2026-11-09T01:00:00Z', end: '2026-11-09T02:00:00Z' },
      { start: '2026-11-10T01:00:00Z', end: '2026-11-10T02:00:00Z' },
    ],
    lockedBlocks: [{ taskId: 'e', start: '2026-11-09T03:00:00Z', end: '2026-11-09T04:00:00Z' }],
    existingBlocks: [{ taskId: 'a', start: '2026-11-09T05:00:00Z', end: '2026-11-09T06:00:00Z' }],
    affectedTaskIds: ['a', 'd'],
    prefs: {
      maxDailyFocusMin: 240,
      breakAfterMin: 90,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '08:00',
      dayEndLocal: '18:00',
    },
    seed: 1,
  };
  // A stand-in for "the port is wrong whenever a task must be one block and
  // a whole day is off".
  const fake: Differ = (subject) =>
    subject.input.tasks.some((entry) => !entry.splittable) &&
    subject.input.exceptions.some((entry) => entry.kind === 'off')
      ? 'result'
      : null;

  const outcome = shrink({ input, options: { seed: 9, policies: ['balanced'] } }, fake, 'any');
  const checks: Array<readonly [string, boolean]> = [
    ['a mismatch is found and shrunk', outcome !== null],
    ['one task is left, the non-splittable one', outcome?.subject.input.tasks.map((entry) => entry.id).join() === 'culprit'],
    ['its references to removed tasks are gone', outcome?.subject.input.tasks[0]?.dependsOn.length === 0],
    ['its optional fields are dropped', outcome?.subject.input.tasks[0]?.dueAt === undefined && outcome?.subject.input.tasks[0]?.bufferBeforeDueMin === undefined],
    ['one exception is left, the day off', canonicalJson(outcome?.subject.input.exceptions) === canonicalJson([{ date: '2026-11-11', kind: 'off' }])],
    ['rules, commitments and blocks are gone', outcome !== null && ['availability', 'commitments', 'lockedBlocks'].every((key) => outcome.subject.input[key as ListKey]?.length === 0)],
    ['empty optional lists are dropped', outcome?.subject.input.existingBlocks === undefined && outcome?.subject.input.affectedTaskIds === undefined],
    ['options are dropped', outcome?.subject.options === null],
    ['the layer is reported', outcome?.layer === 'result'],
    ['a case without a mismatch is not shrunk', shrink({ input: { ...input, exceptions: [] }, options: null }, fake, 'any') === null],
    ['a mismatch in another layer than asked for is not shrunk', shrink({ input, options: null }, fake, 'slots') === null],
    ['the result is still valid pack text', outcome !== null && JSON.parse(regressionPack('self-test', 'self-test', 'self-test', outcome)).cases.length === 1],
  ];
  for (const [name, passed] of checks) console.log(`${passed ? 'ok  ' : 'FAIL'} ${name}`);
  const failed = checks.filter(([, passed]) => !passed).length;
  console.log(
    failed === 0
      ? `self-test passed: ${checks.length} checks, ${outcome?.trials ?? 0} trials`
      : `self-test FAILED: ${failed} of ${checks.length} checks`,
  );
  return failed === 0;
}

// ---------------------------------------------------------------------------

function usage(message: string): never {
  console.error(`${message}\nusage: shrink-oracle --pack FILE --case ID [--layer LAYER] [--name SLUG] [--note TEXT] [--out DIR] | --self-test`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2).filter((flag) => flag !== '--');
  if (argv.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith('--') || value === undefined) usage('bad arguments');
    values.set(flag.slice(2), value);
  }
  const packFile = values.get('pack');
  const caseId = values.get('case');
  if (packFile === undefined || caseId === undefined) usage('--pack and --case are required');
  const layer = (values.get('layer') ?? 'any') as Layer | 'any';
  if (layer !== 'any' && !LAYERS.includes(layer)) usage(`--layer must be any or one of ${LAYERS.join(', ')}`);
  const name = values.get('name') ?? caseId;
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(name)) usage('--name must be a short slug');
  if (!existsSync(SCHED_DIFF)) {
    usage(`${SCHED_DIFF} is missing: run (cd core && cargo build -p ohmydate-scheduler --bin sched-diff)`);
  }

  const start = await findCase(resolve(repoRoot, packFile), caseId);
  if (start === null) usage(`case ${caseId} is not in ${packFile}`);
  console.log(`${caseId}: ${describe(start)}`);
  const outcome = shrink(start, differsFromRust, layer);
  if (outcome === null) {
    console.log(`${caseId}: the Rust scheduler agrees with the reference${layer === 'any' ? '' : ` in ${layer}`}; nothing to shrink`);
    process.exit(1);
  }
  const out = resolve(repoRoot, values.get('out') ?? 'core/crates/scheduler/tests/oracle/regressions');
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.json`);
  writeFileSync(file, regressionPack(name, values.get('note') ?? '', `${packFile}#${caseId}`, outcome));
  console.log(`${caseId}: differs in ${outcome.layer}; shrunk to ${describe(outcome.subject)} in ${outcome.trials} trials`);
  console.log(`wrote ${file}`);
}

await main();
