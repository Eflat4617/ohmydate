/**
 * Shared by the oracle exporter and the oracle shrinker (blueprint 15 §5.3):
 * what the TypeScript reference computes for one case, and how a pack is
 * written.
 *
 * This file is tooling: it is not imported by the package and is not a test.
 */
import {
  computeAvailableSlots,
  deficit,
  generate,
  validate,
  validateInput,
  type Block,
  type GenerateOptions,
  type ScheduleInput,
} from '../src/index.js';
import { canonicalJson, sha256Hex } from '../src/hash.js';
import { createPrng, type Prng } from '../src/prng.js';
import { parseInstant } from '../src/time.js';

export const FORMAT = 'ohmydate-scheduler-oracle';
export const FORMAT_VERSION = 2;

export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * MINUTE_MS;
export const GRID_MS = 5 * MINUTE_MS;

export function pick<T>(prng: Prng, items: readonly T[]): T {
  const item = items[prng.nextInt(items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

export function chance(prng: Prng, probability: number): boolean {
  return prng.next() < probability;
}

export function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export interface OracleCase {
  readonly id: string;
  readonly kind: 'golden' | 'generated' | 'replan' | 'invalid' | 'reference-test';
  readonly input: ScheduleInput;
  readonly options: GenerateOptions | null;
  /** Seeds the validator probes of this case. */
  readonly probeSeed: number;
}

export function historyBlocks(input: ScheduleInput): Block[] {
  try {
    const nowMs = parseInstant(input.now);
    return (input.existingBlocks ?? []).filter((block) => parseInstant(block.start) < nowMs);
  } catch {
    return [];
  }
}

export function orNull<T>(compute: () => T): T | null {
  try {
    return compute();
  } catch {
    return null;
  }
}

/**
 * Plans broken on purpose. Generated candidates are mostly feasible, so on
 * their own they exercise few validator branches; each probe changes one or
 * two things in a candidate's blocks and records what `validate` reports.
 */
export function probePlans(prng: Prng, input: ScheduleInput, plans: Block[][]): Block[][] {
  const shift = (instant: string, minutes: number): string =>
    orNull(() => iso(parseInstant(instant) + minutes * MINUTE_MS)) ?? instant;
  const otherTask = (taskId: string): string =>
    input.tasks.find((task) => task.id !== taskId)?.id ?? taskId;
  const breakPlan = (blocks: Block[]): Block[] => {
    const index = prng.nextInt(blocks.length);
    const block = blocks[index];
    if (block === undefined) {
      const task = input.tasks[0];
      return task === undefined
        ? blocks
        : [{ taskId: task.id, start: input.horizon.start, end: shift(input.horizon.start, 30) }];
    }
    const minutes = 5 * (1 + prng.nextInt(24));
    const replaced = (changed: Block): Block[] =>
      blocks.map((entry, position) => (position === index ? changed : entry));
    switch (prng.nextInt(14)) {
      case 0:
        return replaced({ ...block, start: shift(block.start, minutes), end: shift(block.end, minutes) });
      case 1:
        return replaced({ ...block, start: shift(block.start, -minutes), end: shift(block.end, -minutes) });
      case 2:
        return replaced({ ...block, end: shift(block.end, minutes) });
      case 3:
        return blocks.filter((_, position) => position !== index);
      case 4:
        return replaced({ ...block, taskId: otherTask(block.taskId) });
      case 5:
        return [...blocks, { ...block }];
      case 6:
        return replaced({
          ...block,
          start: shift(input.horizon.start, -minutes),
          end: shift(input.horizon.start, 30 - minutes),
        });
      case 7:
        return replaced({ ...block, end: shift(input.horizon.end, minutes) });
      case 8:
        return replaced({ ...block, start: shift(block.start, 1) });
      case 9:
        return replaced({ ...block, start: `${shift(block.start, 0).slice(0, 19)}.0001Z` });
      case 10:
        return replaced({ ...block, end: 'nope' });
      case 11:
        return replaced({ ...block, start: block.end, end: block.start });
      case 12:
        return replaced({ ...block, taskId: 'nobody' });
      default:
        return [...blocks, { ...block, taskId: otherTask(block.taskId), start: shift(block.start, 5) }];
    }
  };
  const probes: Block[][] = [];
  const sources = plans.length === 0 ? [[]] : plans;
  for (let index = 0; index < 4; index += 1) {
    let blocks = pick(prng, sources);
    for (let changes = 1 + prng.nextInt(2); changes > 0; changes -= 1) {
      blocks = breakPlan(blocks);
    }
    probes.push(blocks);
  }
  return probes;
}

export function evaluate(testCase: OracleCase): Record<string, unknown> {
  const { input, options } = testCase;
  const result = generate(input, options ?? {});
  const inputIssues = validateInput(input);
  const history = historyBlocks(input);
  const audit = (blocks: Block[]): unknown =>
    orNull(() => validate(input, blocks, { riskLevel: input.prefs.riskLevel, historyBlocks: history }));
  // Rejected inputs are audited too: `validate` is a public function and
  // must answer the same on input that `validateInput` would refuse.
  const validation = result.candidates.map((candidate) => ({
    policy: candidate.policy,
    violations: audit(candidate.blocks),
  }));
  const probes = probePlans(
    createPrng(testCase.probeSeed),
    input,
    result.candidates.map((candidate) => candidate.blocks),
  ).map((blocks) => ({ blocks, violations: audit(blocks) }));
  return {
    id: testCase.id,
    kind: testCase.kind,
    input,
    options,
    inputIssues,
    slots: orNull(() => computeAvailableSlots(input)),
    deficit: orNull(() => deficit(input)),
    result,
    validation,
    probes,
    resultHash: sha256Hex(canonicalJson(result)),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnly(value: unknown, required: readonly string[], optional: readonly string[] = []): boolean {
  return (
    isRecord(value) &&
    required.every((key) => value[key] !== undefined) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

/** No NaN, Infinity or `undefined` array element anywhere: JSON would change them. */
export function survivesJson(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => entry !== undefined && survivesJson(entry));
  if (isRecord(value)) return Object.values(value).every((entry) => entry === undefined || survivesJson(entry));
  return value === null || typeof value === 'string' || typeof value === 'boolean';
}

/**
 * True when an input can be given to the Rust port as it is: it survives
 * JSON, and it has the shape `ScheduleInput::from_json` reads (blueprint 15
 * §5.1) — closed string sets hold known values, and tasks, estimates,
 * availability rules, exceptions and preferences carry no field the
 * reference would hash but the port does not know. Tests that probe the
 * reference with NaN, `undefined` holes or made-up enum values are left out.
 */
export function isPortableInput(input: unknown, options: unknown): input is ScheduleInput {
  if (!survivesJson(input) || !survivesJson(options)) return false;
  if (!isRecord(input) || !Array.isArray(input['tasks'])) return false;
  const text = (value: unknown): boolean => typeof value === 'string';
  const blocks = (value: unknown): boolean =>
    Array.isArray(value) &&
    value.every((block) => isRecord(block) && text(block['taskId']) && text(block['start']) && text(block['end']));
  const oneOf = (value: unknown, allowed: readonly string[]): boolean =>
    typeof value === 'string' && allowed.includes(value);
  const numbers = (record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
    required.every((key) => typeof record[key] === 'number') &&
    optional.every((key) => record[key] === undefined || typeof record[key] === 'number');
  const prefs = input['prefs'];
  const horizon = input['horizon'];
  return (
    text(input['now']) &&
    text(input['timeZone']) &&
    typeof input['seed'] === 'number' &&
    isRecord(horizon) &&
    text(horizon['start']) &&
    text(horizon['end']) &&
    input['tasks'].every(
      (task) =>
        hasOnly(
          task,
          ['id', 'estimate', 'splittable', 'minSessionMin', 'maxSessionMin', 'priority', 'dependsOn'],
          ['dueAt', 'earliestStartAt', 'remainingMin', 'bufferBeforeDueMin', 'preferredWindows', 'autoSplit'],
        ) &&
        hasOnly(task['estimate'], ['p50Min', 'p90Min']) &&
        isRecord(task) &&
        isRecord(task['estimate']) &&
        numbers(task['estimate'], ['p50Min', 'p90Min']) &&
        numbers(task, ['minSessionMin', 'maxSessionMin', 'priority'], ['remainingMin', 'bufferBeforeDueMin']) &&
        text(task['id']) &&
        (task['dueAt'] === undefined || text(task['dueAt'])) &&
        (task['earliestStartAt'] === undefined || text(task['earliestStartAt'])) &&
        typeof task['splittable'] === 'boolean' &&
        Array.isArray(task['dependsOn']) &&
        task['dependsOn'].every(text) &&
        (task['preferredWindows'] === undefined ||
          (Array.isArray(task['preferredWindows']) &&
            task['preferredWindows'].every((window) => oneOf(window, ['morning', 'afternoon', 'evening'])))) &&
        (task['autoSplit'] === undefined || oneOf(task['autoSplit'], ['break_after', 'daily_cap'])),
    ) &&
    Array.isArray(input['availability']) &&
    input['availability'].every(
      (rule) =>
        hasOnly(rule, ['weekday', 'startLocal', 'endLocal', 'kind']) &&
        isRecord(rule) &&
        typeof rule['weekday'] === 'number' &&
        text(rule['startLocal']) &&
        text(rule['endLocal']) &&
        oneOf(rule['kind'], ['work', 'focus']),
    ) &&
    Array.isArray(input['exceptions']) &&
    input['exceptions'].every(
      (exception) =>
        hasOnly(exception, ['date', 'kind'], ['startLocal', 'endLocal']) &&
        isRecord(exception) &&
        text(exception['date']) &&
        (exception['startLocal'] === undefined || text(exception['startLocal'])) &&
        (exception['endLocal'] === undefined || text(exception['endLocal'])) &&
        oneOf(exception['kind'], ['off', 'extra']),
    ) &&
    Array.isArray(input['commitments']) &&
    input['commitments'].every((entry) => isRecord(entry) && text(entry['start']) && text(entry['end'])) &&
    blocks(input['lockedBlocks']) &&
    (input['existingBlocks'] === undefined || blocks(input['existingBlocks'])) &&
    (input['affectedTaskIds'] === undefined ||
      (Array.isArray(input['affectedTaskIds']) && input['affectedTaskIds'].every(text))) &&
    hasOnly(prefs, ['maxDailyFocusMin', 'breakAfterMin', 'breakMin', 'riskLevel', 'dayStartLocal', 'dayEndLocal']) &&
    isRecord(prefs) &&
    numbers(prefs, ['maxDailyFocusMin', 'breakAfterMin', 'breakMin']) &&
    text(prefs['dayStartLocal']) &&
    text(prefs['dayEndLocal']) &&
    oneOf(prefs['riskLevel'], ['p50', 'p90']) &&
    (options === null || options === undefined || isRecord(options))
  );
}

/**
 * The layers the Rust port can be asked for directly (`sched-diff`): the
 * input checks, and `validate` on the given plans. `result` is the
 * reference's own generation, for the layers a caller compares itself.
 */
export function referenceLayers(
  input: ScheduleInput,
  options: GenerateOptions | null,
  plans: Block[][],
): Record<string, unknown> {
  const history = historyBlocks(input);
  return {
    inputIssues: validateInput(input),
    slots: orNull(() => computeAvailableSlots(input)),
    deficit: orNull(() => deficit(input)),
    plans: plans.map((blocks) => ({
      violations: orNull(() =>
        validate(input, blocks, { riskLevel: input.prefs.riskLevel, historyBlocks: history }),
      ),
    })),
    result: generate(input, options ?? {}),
  };
}

/**
 * A pack as text: the header pretty-printed, then one case per line, which
 * keeps the committed packs reviewable and lets a reader take a large pack
 * one case at a time.
 */
export function packText(header: object, cases: ReadonlyArray<Record<string, unknown>>): string {
  const head = JSON.stringify(header, null, 1).replace(/\n}$/, '');
  const lines = cases.map((entry) => JSON.stringify(entry));
  const text = `${head},\n "cases": [\n${lines.join(',\n')}\n ]\n}\n`;
  JSON.parse(text);
  return text;
}
