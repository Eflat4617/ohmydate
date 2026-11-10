import type {
  Block,
  GenerateOptions,
  GenerateResult,
  InputIssue,
  PlanCandidate,
  PlanMetrics,
  PolicyName,
  ScheduleInput,
  Task,
  Violation,
} from './types.js';
import { computeAvailableSlots } from './slots.js';
import { validate, validateInput } from './validate.js';
import { deficit } from './explain.js';
import { taskRequiredMinutes } from './requirements.js';
import {
  GRID_MS,
  MINUTE_MS,
  instantToUtc,
  instantToZoned,
  parseInstant,
  partitionByLocalDate,
} from './time.js';
import { POLICIES, POLICY_NAMES } from './policies.js';
import { createPrng, type Prng } from './prng.js';
import { canonicalJson, sha256Hex } from './hash.js';

export const GENERATOR_VERSION = 'm3-02.3';

interface Interval {
  startMs: number;
  endMs: number;
  taskId: string;
}

interface SlotInfo {
  id: number;
  startMs: number;
  endMs: number;
  cellStarts: number[];
  cellDates: string[];
}

interface Placement {
  taskId: string;
  durationMin: number;
  startMs: number;
  endMs: number;
  slotId: number;
  /** True when the placement was seeded from a still-valid existing block. */
  seeded: boolean;
}

interface ReplanBlock {
  taskId: string;
  startMs: number;
  endMs: number;
}

interface ReplanPlan {
  movable: ReplanBlock[];
  baseAffectedTasks: Set<string>;
  /** Non-fixed existing blocks, used for the changedBlocks metric. */
  movableExisting: Interval[];
}

interface PlanState {
  timeZone: string;
  placements: Placement[];
  /** Sorted locked + history + candidate intervals for H1/H6 checks. */
  intervals: Interval[];
  dailyLoad: Map<string, number>;
}

interface BuildContext {
  /** Original caller input (hash + public metadata). */
  input: ScheduleInput;
  slotsByStart: SlotInfo[];
  slotsByLength: SlotInfo[];
  /** Approved locked blocks; they are audited normally and credited. */
  lockedIntervals: Interval[];
  lockedByTask: Map<string, Interval[]>;
  /** Past/in-progress existing blocks: occupy time only (06 §7.1). */
  historyBlocks: Block[];
  historyIntervals: Interval[];
  historyByTask: Map<string, Interval[]>;
  /** Keys of `input.lockedBlocks`, to exclude from changedBlocks. */
  lockedKeys: Set<string>;
  breakAfterMs: number;
  breakMs: number;
  maxDailyFocusMin: number;
  horizonStartMs: number;
  horizonEndMs: number;
  nowMs: number;
  riskLevel: 'p50' | 'p90';
}

interface Position {
  startMs: number;
  endMs: number;
  slotId: number;
  slot: SlotInfo;
  cellIndex: number;
}

interface ChunkSpec {
  chunks: number[];
  reason: string | undefined;
}

/**
 * Generate one candidate per requested policy (06 §4).
 *
 * The generator and `validate()` are deliberately separate: only candidates
 * whose blocks produce zero violations are marked feasible. Infeasible
 * candidates are still returned with their partial blocks, their own H7
 * shortfall, the separate capacity bound, validator violations and heuristic
 * reasons, so no hard violation is hidden.
 *
 * Replanning seeds still-valid existing blocks (start >= now) and re-places
 * only conflicting/affected tasks and their successors. Existing blocks whose
 * start is before `now` are history (06 §7.1): they occupy time for H1/H6 but
 * are exempt from H2/H4/H5 and do not reduce `remainingMin`. New placements
 * start at or after max(horizon.start, now).
 */
export function generate(
  input: ScheduleInput,
  options: GenerateOptions = {},
): GenerateResult {
  const seed = options.seed ?? input.seed;
  const requested = normalizePolicies(options.policies);
  const maxImprovement = Math.max(
    0,
    Math.min(200, options.maxLocalImprovement ?? 200),
  );
  const inputHash = sha256Hex(
    canonicalJson(canonicalInput(input, seed, maxImprovement)),
  );
  const issues = validateInput(input);

  if (issues.length > 0) {
    const requiredTotal = input.tasks.reduce(
      (sum, task) => sum + taskRequiredMinutes(task, input.prefs.riskLevel),
      0,
    );
    const candidates = requested.map((policy) =>
      invalidInputCandidate(policy, inputHash, issues, requiredTotal),
    );
    return finalize(candidates);
  }

  const context = buildContext(input);
  const replan = prepareReplan(context);
  const capacityDeficitMin = capacityDeficit(context);

  const candidates = requested.map((policy) =>
    generateForPolicy(
      context,
      replan,
      policy,
      seed,
      inputHash,
      capacityDeficitMin,
      maxImprovement,
    ),
  );
  return finalize(candidates);
}

function canonicalInstant(value: string): string {
  try {
    return instantToUtc(parseInstant(value));
  } catch {
    return value;
  }
}

function canonicalBlock(block: Block): {
  taskId: string;
  start: string;
  end: string;
} {
  return {
    taskId: block.taskId,
    start: canonicalInstant(block.start),
    end: canonicalInstant(block.end),
  };
}

/**
 * Hash input with the seed/max-improvement that actually drive generation and
 * all instants canonicalised to UTC ISO strings, so equivalent spellings hash
 * identically.
 */
function canonicalInput(
  input: ScheduleInput,
  seed: number,
  maxLocalImprovement: number,
): unknown {
  return {
    now: canonicalInstant(input.now),
    timeZone: input.timeZone,
    horizon: {
      start: canonicalInstant(input.horizon.start),
      end: canonicalInstant(input.horizon.end),
    },
    tasks: input.tasks.map((task) => ({
      ...task,
      ...(task.dueAt === undefined
        ? {}
        : { dueAt: canonicalInstant(task.dueAt) }),
      ...(task.earliestStartAt === undefined
        ? {}
        : { earliestStartAt: canonicalInstant(task.earliestStartAt) }),
    })),
    availability: input.availability,
    exceptions: input.exceptions,
    commitments: input.commitments.map((commitment) => ({
      start: canonicalInstant(commitment.start),
      end: canonicalInstant(commitment.end),
    })),
    lockedBlocks: input.lockedBlocks.map(canonicalBlock),
    existingBlocks: (input.existingBlocks ?? []).map(canonicalBlock),
    prefs: input.prefs,
    seed,
    maxLocalImprovement,
  };
}

function normalizePolicies(
  policies: PolicyName[] | undefined,
): PolicyName[] {
  const source = policies ?? POLICY_NAMES;
  const seen = new Set<PolicyName>();
  const result: PolicyName[] = [];
  for (const policy of source) {
    if (policy in POLICIES && !seen.has(policy)) {
      seen.add(policy);
      result.push(policy);
    }
  }
  return result;
}

function capacityDeficit(context: BuildContext): number {
  const input = context.input;
  try {
    // History occupies time for capacity purposes but is not credited work.
    const capacityInput: ScheduleInput =
      context.historyBlocks.length === 0
        ? input
        : {
            ...input,
            commitments: [...input.commitments, ...context.historyBlocks],
          };
    return deficit(capacityInput).total.deficitMin;
  } catch {
    return input.tasks.reduce(
      (sum, task) => sum + taskRequiredMinutes(task, input.prefs.riskLevel),
      0,
    );
  }
}

function invalidInputCandidate(
  policy: PolicyName,
  inputHash: string,
  issues: InputIssue[],
  requiredTotal: number,
): PlanCandidate {
  const profile = POLICIES[policy];
  return {
    policy,
    blocks: [],
    metrics: emptyMetrics(requiredTotal, requiredTotal),
    feasible: false,
    deficitMin: requiredTotal,
    capacityDeficitMin: requiredTotal,
    explanation: [
      `Policy ${policy} v${profile.version}: ${profile.summary}`,
      `Input rejected before generation: ${issues.map((issue) => issue.code).join(', ')}.`,
      ...issues.slice(0, 5).map((issue) => `${issue.code}: ${issue.message}`),
    ],
    inputHash,
    generatorVersion: GENERATOR_VERSION,
  };
}

function emptyMetrics(
  deficitMin: number,
  capacityDeficitMin: number,
): PlanMetrics {
  return {
    totalFocusMin: 0,
    minSlackMin: 0,
    maxDailyLoadMin: 0,
    avgDailyLoadMin: 0,
    contextSwitches: 0,
    changedBlocks: 0,
    deficitMin,
    capacityDeficitMin,
    p90CoverageRatio: 1,
  };
}

function buildContext(input: ScheduleInput): BuildContext {
  const horizonStartMs = parseInstant(input.horizon.start);
  const horizonEndMs = parseInstant(input.horizon.end);
  const nowMs = parseInstant(input.now);
  const slots = computeAvailableSlots(input);
  const slotsByStart: SlotInfo[] = [];

  for (const slot of slots) {
    const startMs = parseInstant(slot.start);
    const endMs = parseInstant(slot.end);
    const segments = partitionByLocalDate(startMs, endMs, input.timeZone);
    const cellStarts: number[] = [];
    const cellDates: string[] = [];
    for (let cursor = startMs; cursor + GRID_MS <= endMs; cursor += GRID_MS) {
      cellStarts.push(cursor);
      cellDates.push(dateAt(cursor, segments));
    }
    if (cellStarts.length > 0) {
      slotsByStart.push({
        id: slotsByStart.length,
        startMs,
        endMs,
        cellStarts,
        cellDates,
      });
    }
  }

  const slotsByLength = [...slotsByStart].sort(
    (a, b) =>
      b.endMs - b.startMs - (a.endMs - a.startMs) || a.startMs - b.startMs,
  );

  const lockedKeys = new Set(
    input.lockedBlocks.map((block) =>
      blockKey(block.taskId, parseInstant(block.start), parseInstant(block.end)),
    ),
  );
  const historyBlocks = (input.existingBlocks ?? []).filter((block) => {
    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    if (startMs >= nowMs || endMs <= startMs) {
      return false;
    }
    return !lockedKeys.has(blockKey(block.taskId, startMs, endMs));
  });

  const lockedIntervals = toIntervals(input.lockedBlocks);
  const lockedByTask = groupIntervalsByTask(lockedIntervals);
  const historyIntervals = toIntervals(historyBlocks);
  const historyByTask = groupIntervalsByTask(historyIntervals);

  return {
    input,
    slotsByStart,
    slotsByLength,
    lockedIntervals,
    lockedByTask,
    historyBlocks,
    historyIntervals,
    historyByTask,
    lockedKeys,
    breakAfterMs: input.prefs.breakAfterMin * MINUTE_MS,
    breakMs: input.prefs.breakMin * MINUTE_MS,
    maxDailyFocusMin: input.prefs.maxDailyFocusMin,
    horizonStartMs,
    horizonEndMs,
    nowMs,
    riskLevel: input.prefs.riskLevel,
  };
}

function toIntervals(blocks: Block[]): Interval[] {
  const intervals: Interval[] = [];
  for (const block of blocks) {
    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    if (endMs > startMs) {
      intervals.push({ startMs, endMs, taskId: block.taskId });
    }
  }
  return intervals;
}

function groupIntervalsByTask(
  intervals: Interval[],
): Map<string, Interval[]> {
  const grouped = new Map<string, Interval[]>();
  for (const interval of intervals) {
    const list = grouped.get(interval.taskId) ?? [];
    list.push(interval);
    grouped.set(interval.taskId, list);
  }
  return grouped;
}

function validatePlan(
  context: BuildContext,
  blocks: Block[],
): Violation[] {
  return validate(context.input, blocks, {
    riskLevel: context.riskLevel,
    historyBlocks: context.historyBlocks,
  });
}

function prepareReplan(context: BuildContext): ReplanPlan {
  const taskById = new Map(
    context.input.tasks.map((task) => [task.id, task]),
  );
  const movableExisting: Interval[] = [];
  const movable: ReplanBlock[] = [];

  for (const block of context.input.existingBlocks ?? []) {
    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    if (endMs <= startMs) {
      continue;
    }
    if (context.lockedKeys.has(blockKey(block.taskId, startMs, endMs))) {
      continue;
    }
    if (startMs < context.nowMs) {
      continue;
    }
    const interval = { startMs, endMs, taskId: block.taskId };
    movableExisting.push(interval);
    movable.push(interval);
  }
  movable.sort(
    (a, b) =>
      a.startMs - b.startMs ||
      compareText(a.taskId, b.taskId) ||
      a.endMs - b.endMs,
  );

  const affected = new Set<string>();
  const movableMinutesByTask = new Map<string, number>();
  for (const item of movable) {
    const task = taskById.get(item.taskId);
    const durationMin = (item.endMs - item.startMs) / MINUTE_MS;
    let valid =
      task !== undefined &&
      findContainingSlot(context, item.startMs, item.endMs) !== undefined &&
      isSessionValid(task, durationMin, context.riskLevel);
    if (task !== undefined) {
      const earliestMs =
        task.earliestStartAt === undefined
          ? context.horizonStartMs
          : parseInstant(task.earliestStartAt);
      const dueMs =
        task.dueAt === undefined
          ? context.horizonEndMs
          : parseInstant(task.dueAt);
      const windowStartMs = Math.max(
        context.horizonStartMs,
        context.nowMs,
        earliestMs,
      );
      const windowEndMs = Math.min(
        context.horizonEndMs,
        dueMs - (task.bufferBeforeDueMin ?? 0) * MINUTE_MS,
      );
      if (item.startMs < windowStartMs || item.endMs > windowEndMs) {
        valid = false;
      }
    }
    if (!valid) {
      affected.add(item.taskId);
      continue;
    }
    movableMinutesByTask.set(
      item.taskId,
      (movableMinutesByTask.get(item.taskId) ?? 0) + durationMin,
    );
  }

  for (const [taskId, movableMin] of movableMinutesByTask) {
    const task = taskById.get(taskId);
    if (task === undefined) {
      continue;
    }
    const fixedMin = minutesOf(context.lockedByTask.get(taskId) ?? []);
    if (
      fixedMin + movableMin >
      taskRequiredMinutes(task, context.riskLevel) + 1e-9
    ) {
      affected.add(taskId);
    }
  }

  return {
    movable,
    baseAffectedTasks: propagateAffected(context, affected),
    movableExisting,
  };
}

/**
 * Build seeds for the given affected set, releasing more tasks until stable.
 * A seed is invalid when it starts before a dependency's last block, when the
 * task's remainder is below `minSessionMin`/cannot fit before a seeded
 * successor, or when H1/H2/H6/daily checks reject it (06 §7.1).
 */
function buildReplanSeeds(
  context: BuildContext,
  replan: ReplanPlan,
  initialAffected: Set<string>,
): { seeds: Placement[]; affected: Set<string> } {
  const taskById = new Map(
    context.input.tasks.map((task) => [task.id, task]),
  );
  let affected = propagateAffected(context, new Set(initialAffected));

  for (
    let iteration = 0;
    iteration <= context.input.tasks.length + 2;
    iteration += 1
  ) {
    const state = createState(context);
    const seeds: Placement[] = [];
    let failedTask: string | undefined;

    for (const item of replan.movable) {
      if (affected.has(item.taskId)) {
        continue;
      }
      const slot = findContainingSlot(context, item.startMs, item.endMs);
      if (
        slot === undefined ||
        !passes(context, state, item.startMs, item.endMs)
      ) {
        failedTask = item.taskId;
        break;
      }
      const placement: Placement = {
        taskId: item.taskId,
        durationMin: (item.endMs - item.startMs) / MINUTE_MS,
        startMs: item.startMs,
        endMs: item.endMs,
        slotId: slot.id,
        seeded: true,
      };
      addPlacement(state, placement);
      seeds.push(placement);
    }

    if (failedTask !== undefined) {
      affected.add(failedTask);
      affected = propagateAffected(context, affected);
      continue;
    }

    const seedsByTask = new Map<string, Placement[]>();
    for (const seed of seeds) {
      const list = seedsByTask.get(seed.taskId) ?? [];
      list.push(seed);
      seedsByTask.set(seed.taskId, list);
    }

    const next = new Set(affected);
    for (const seed of seeds) {
      const task = taskById.get(seed.taskId);
      if (task === undefined) {
        continue;
      }
      const dependencyReady = dependencyCompletion(
        context,
        seedsByTask,
        task.dependsOn,
      );
      if (seed.startMs < dependencyReady) {
        next.add(seed.taskId);
      }
    }

    for (const [taskId, taskSeeds] of seedsByTask) {
      const task = taskById.get(taskId);
      if (task === undefined) {
        continue;
      }
      const required = taskRequiredMinutes(task, context.riskLevel);
      const lockedMin = minutesOf(context.lockedByTask.get(taskId) ?? []);
      const seededMin = taskSeeds.reduce(
        (sum, seed) => sum + seed.durationMin,
        0,
      );
      const remaining = Math.max(0, required - lockedMin - seededMin);
      if (remaining <= 0) {
        continue;
      }
      if (!task.splittable || remaining < task.minSessionMin) {
        next.add(taskId);
        continue;
      }
      const chunks = buildChunks(task, remaining);
      if (chunks.reason !== undefined) {
        next.add(taskId);
        continue;
      }
      const successorStart = earliestSeededSuccessorStart(
        context,
        seeds,
        taskId,
      );
      if (successorStart !== undefined) {
        const earliestMs =
          task.earliestStartAt === undefined
            ? context.horizonStartMs
            : parseInstant(task.earliestStartAt);
        const dueMs =
          task.dueAt === undefined
            ? context.horizonEndMs
            : parseInstant(task.dueAt);
        const windowStart = Math.max(
          context.horizonStartMs,
          context.nowMs,
          earliestMs,
          dependencyCompletion(context, seedsByTask, task.dependsOn),
        );
        const windowEnd = Math.min(
          context.horizonEndMs,
          dueMs - (task.bufferBeforeDueMin ?? 0) * MINUTE_MS,
          successorStart,
        );
        if (
          windowEnd <= windowStart ||
          freeMinutesBetween(context, state, windowStart, windowEnd) <
            remaining
        ) {
          next.add(taskId);
        }
      }
    }

    const propagated = propagateAffected(context, next);
    if (setsEqual(propagated, affected)) {
      return { seeds, affected };
    }
    affected = propagated;
  }

  return { seeds: [], affected };
}

function dependencyCompletion(
  context: BuildContext,
  seedsByTask: Map<string, Placement[]>,
  dependencies: string[],
): number {
  let ready = context.horizonStartMs;
  for (const dependencyId of dependencies) {
    for (const interval of context.lockedByTask.get(dependencyId) ?? []) {
      ready = Math.max(ready, interval.endMs);
    }
    for (const interval of context.historyByTask.get(dependencyId) ?? []) {
      ready = Math.max(ready, interval.endMs);
    }
    for (const seed of seedsByTask.get(dependencyId) ?? []) {
      ready = Math.max(ready, seed.endMs);
    }
  }
  return ready;
}

function earliestSeededSuccessorStart(
  context: BuildContext,
  seeds: Placement[],
  taskId: string,
): number | undefined {
  let earliest: number | undefined;
  for (const task of context.input.tasks) {
    if (!task.dependsOn.includes(taskId)) {
      continue;
    }
    for (const seed of seeds) {
      if (seed.taskId !== task.id) {
        continue;
      }
      earliest =
        earliest === undefined ? seed.startMs : Math.min(earliest, seed.startMs);
    }
  }
  return earliest;
}

function freeMinutesBetween(
  context: BuildContext,
  state: PlanState,
  startMs: number,
  endMs: number,
): number {
  if (endMs <= startMs) {
    return 0;
  }
  let total = 0;
  for (const slot of context.slotsByStart) {
    for (const cellStart of slot.cellStarts) {
      if (cellStart < startMs) {
        continue;
      }
      if (cellStart + GRID_MS > endMs) {
        break;
      }
      if (!overlapsAny(state.intervals, cellStart, cellStart + GRID_MS)) {
        total += 5;
      }
    }
  }
  return total;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function propagateAffected(
  context: BuildContext,
  initial: Set<string>,
): Set<string> {
  const affected = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of context.input.tasks) {
      if (affected.has(task.id)) {
        continue;
      }
      if (task.dependsOn.some((dependencyId) => affected.has(dependencyId))) {
        affected.add(task.id);
        changed = true;
      }
    }
  }
  return affected;
}

function findContainingSlot(
  context: BuildContext,
  startMs: number,
  endMs: number,
): SlotInfo | undefined {
  for (const slot of context.slotsByStart) {
    if (slot.startMs > startMs) {
      break;
    }
    if (startMs >= slot.startMs && endMs <= slot.endMs) {
      return slot;
    }
  }
  return undefined;
}

function isSessionValid(
  task: Task,
  durationMin: number,
  riskLevel: 'p50' | 'p90',
): boolean {
  if (durationMin <= 0 || durationMin % 5 !== 0) {
    return false;
  }
  if (!task.splittable) {
    return durationMin === taskRequiredMinutes(task, riskLevel);
  }
  return (
    durationMin >= task.minSessionMin && durationMin <= task.maxSessionMin
  );
}

function minutesOf(intervals: Interval[]): number {
  return intervals.reduce(
    (sum, interval) => sum + (interval.endMs - interval.startMs) / MINUTE_MS,
    0,
  );
}

function dateAt(
  epochMs: number,
  segments: Array<{ startMs: number; endMs: number; date: string }>,
): string {
  for (const segment of segments) {
    if (epochMs >= segment.startMs && epochMs < segment.endMs) {
      return segment.date;
    }
  }
  const last = segments[segments.length - 1];
  return last === undefined ? '' : last.date;
}

function createState(context: BuildContext): PlanState {
  const state: PlanState = {
    timeZone: context.input.timeZone,
    placements: [],
    intervals: [],
    dailyLoad: new Map<string, number>(),
  };
  for (const interval of [
    ...context.lockedIntervals,
    ...context.historyIntervals,
  ]) {
    insertInterval(state.intervals, interval);
    addLoads(state.dailyLoad, blockDailyLoads(
      interval.startMs,
      interval.endMs,
      state.timeZone,
    ));
  }
  return state;
}

function generateForPolicy(
  context: BuildContext,
  replan: ReplanPlan,
  policy: PolicyName,
  seed: number,
  inputHash: string,
  capacityDeficitMin: number,
  maxImprovement: number,
): PlanCandidate {
  const profile = POLICIES[policy];
  let affected = new Set(replan.baseAffectedTasks);
  let attempt = buildReplanSeeds(context, replan, affected);
  let result = runPlacementAttempt(
    context,
    policy,
    seed,
    maxImprovement,
    attempt.seeds,
  );
  let retainedSeeds = attempt.seeds.length;

  for (
    let iteration = 0;
    iteration <= context.input.tasks.length + 2 &&
    result.violations.length > 0;
    iteration += 1
  ) {
    const violating = new Set<string>();
    for (const violation of result.violations) {
      if (violation.taskId !== undefined) {
        violating.add(violation.taskId);
      }
    }
    if (violating.size === 0) {
      for (const seeded of attempt.seeds) {
        violating.add(seeded.taskId);
      }
      if (violating.size === 0) {
        break;
      }
    }
    const next = propagateAffected(context, new Set([...affected, ...violating]));
    if (setsEqual(next, affected)) {
      for (const seeded of attempt.seeds) {
        next.add(seeded.taskId);
      }
      const expanded = propagateAffected(context, next);
      if (setsEqual(expanded, affected)) {
        break;
      }
      affected = expanded;
    } else {
      affected = next;
    }
    attempt = buildReplanSeeds(context, replan, affected);
    result = runPlacementAttempt(
      context,
      policy,
      seed,
      maxImprovement,
      attempt.seeds,
    );
    retainedSeeds = attempt.seeds.length;
  }

  // Final fallback: no seeds. If a still-seeded attempt was feasible we never
  // get here, so the first feasible attempt wins.
  if (result.violations.length > 0) {
    const noSeeds = runPlacementAttempt(
      context,
      policy,
      seed,
      maxImprovement,
      [],
    );
    result = noSeeds;
    retainedSeeds = 0;
  }

  const finalState = stateFromPlacements(context, result.placements);
  const blocks = blocksFromPlacements(finalState.placements);
  const metrics = buildMetrics(
    context,
    finalState,
    replan,
    capacityDeficitMin,
  );
  const feasible = result.violations.length === 0;
  const requiredTotalMin = context.input.tasks.reduce(
    (sum, task) => sum + taskRequiredMinutes(task, context.riskLevel),
    0,
  );
  const placedTotalMin = Math.max(0, requiredTotalMin - metrics.deficitMin);

  const explanation: string[] = [
    `Policy ${policy} v${profile.version}: ${profile.summary}`,
    `Placed ${placedTotalMin} of ${requiredTotalMin} required minutes in ${blocks.length} movable block(s), retaining ${retainedSeeds} existing block(s).`,
    feasible
      ? 'All hard constraints H1-H8 satisfied.'
      : `Infeasible with ${result.violations.length} hard violation(s): ${uniqueCodes(result.violations)}.`,
  ];
  if (!feasible) {
    for (const violation of result.violations.slice(0, 4)) {
      explanation.push(violation.message);
    }
  }
  for (const reason of [...result.reasons].sort()) {
    explanation.push(`Heuristic reason: ${reason}.`);
  }
  explanation.push(
    `Unplaced minutes (H7 shortfall): ${metrics.deficitMin} min.`,
  );
  explanation.push(`Capacity deficit: ${capacityDeficitMin} min.`);

  return {
    policy,
    blocks,
    metrics,
    feasible,
    deficitMin: metrics.deficitMin,
    capacityDeficitMin,
    explanation,
    inputHash,
    generatorVersion: GENERATOR_VERSION,
  };
}

interface PlacementAttempt {
  placements: Placement[];
  violations: Violation[];
  reasons: Set<string>;
}

function runPlacementAttempt(
  context: BuildContext,
  policy: PolicyName,
  seed: number,
  maxImprovement: number,
  seeds: Placement[],
): PlacementAttempt {
  const state = createState(context);
  for (const seedPlacement of seeds) {
    addPlacement(state, { ...seedPlacement });
  }
  const seededMinutesByTask = new Map<string, number>();
  for (const placement of seeds) {
    seededMinutesByTask.set(
      placement.taskId,
      (seededMinutesByTask.get(placement.taskId) ?? 0) + placement.durationMin,
    );
  }

  const reasons = new Set<string>();
  const completionByTask = new Map<string, number>();
  for (const interval of state.intervals) {
    completionByTask.set(
      interval.taskId,
      Math.max(
        completionByTask.get(interval.taskId) ?? Number.NEGATIVE_INFINITY,
        interval.endMs,
      ),
    );
  }
  const prng = createPrng(seed + policySeedOffset(policy));

  for (const task of orderTasks(context, policy)) {
    const fixed = context.lockedByTask.get(task.id) ?? [];
    const fixedMin = fixed.reduce(
      (sum, interval) => sum + (interval.endMs - interval.startMs) / MINUTE_MS,
      0,
    );
    const seededMin = seededMinutesByTask.get(task.id) ?? 0;
    const requiredMin = taskRequiredMinutes(task, context.riskLevel);
    const remainingMin = Math.max(0, requiredMin - fixedMin - seededMin);
    const chunks = buildChunks(task, remainingMin);
    if (chunks.reason !== undefined) {
      reasons.add(chunks.reason);
    }

    let dependencyReadyMs = context.horizonStartMs;
    for (const dependencyId of task.dependsOn) {
      const completion = completionByTask.get(dependencyId);
      if (completion !== undefined) {
        dependencyReadyMs = Math.max(dependencyReadyMs, completion);
      }
    }

    const earliestMs =
      task.earliestStartAt === undefined
        ? context.horizonStartMs
        : parseInstant(task.earliestStartAt);
    const dueMs =
      task.dueAt === undefined
        ? context.horizonEndMs
        : parseInstant(task.dueAt);
    const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
    const windowStartMs = Math.max(
      context.horizonStartMs,
      context.nowMs,
      earliestMs,
      dependencyReadyMs,
    );
    const windowEndMs = Math.min(context.horizonEndMs, dueMs - bufferMs);

    let lastEndMs = Number.NEGATIVE_INFINITY;
    for (const interval of state.intervals) {
      if (interval.taskId === task.id) {
        lastEndMs = Math.max(lastEndMs, interval.endMs);
      }
    }

    if (remainingMin > 0 && windowEndMs <= windowStartMs) {
      reasons.add('insufficient_available_time');
    } else {
      for (const durationMin of chunks.chunks) {
        const position = selectPlacement(
          context,
          state,
          policy,
          task.id,
          durationMin,
          windowStartMs,
          windowEndMs,
        );
        if (position === undefined) {
          reasons.add(
            task.splittable
              ? 'insufficient_available_time'
              : 'no_contiguous_window',
          );
          break;
        }
        const placement: Placement = {
          taskId: task.id,
          durationMin,
          startMs: position.startMs,
          endMs: position.endMs,
          slotId: position.slotId,
          seeded: false,
        };
        addPlacement(state, placement);
        lastEndMs = Math.max(lastEndMs, placement.endMs);
      }
    }

    if (lastEndMs === Number.NEGATIVE_INFINITY) {
      completionByTask.set(
        task.id,
        remainingMin > 0 ? Number.POSITIVE_INFINITY : windowStartMs,
      );
    } else {
      completionByTask.set(task.id, lastEndMs);
    }
  }

  const greedyBlocks = blocksFromPlacements(state.placements);
  const greedyViolations = validatePlan(context, greedyBlocks);

  let finalPlacements = state.placements.map((placement) => ({ ...placement }));
  if (greedyViolations.length === 0 && maxImprovement > 0) {
    const improved = improvePlacements(
      context,
      policy,
      state,
      maxImprovement,
      prng,
    );
    const improvedBlocks = blocksFromPlacements(improved);
    const improvedViolations = validatePlan(context, improvedBlocks);
    if (improvedViolations.length === 0) {
      finalPlacements = improved;
    }
  }

  const blocks = blocksFromPlacements(finalPlacements);
  const violations = validatePlan(context, blocks);
  return { placements: finalPlacements, violations, reasons };
}

function policySeedOffset(policy: PolicyName): number {
  if (policy === 'front_loaded') {
    return 0;
  }
  if (policy === 'balanced') {
    return 7919;
  }
  return 15486;
}

function uniqueCodes(violations: Array<{ code: string }>): string {
  return [...new Set(violations.map((violation) => violation.code))]
    .sort()
    .join(', ');
}

function stateFromPlacements(
  context: BuildContext,
  placements: Placement[],
): PlanState {
  const state = createState(context);
  for (const placement of placements) {
    addPlacement(state, { ...placement });
  }
  return state;
}

function blocksFromPlacements(placements: Placement[]): Block[] {
  return [...placements]
    .sort(
      (a, b) =>
        a.startMs - b.startMs ||
        compareText(a.taskId, b.taskId) ||
        a.endMs - b.endMs,
    )
    .map((placement) => ({
      taskId: placement.taskId,
      start: instantToUtc(placement.startMs),
      end: instantToUtc(placement.endMs),
    }));
}

function orderTasks(context: BuildContext, policy: PolicyName): Task[] {
  const tasks = context.input.tasks;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    const known = task.dependsOn.filter((id) => byId.has(id));
    indegree.set(task.id, known.length);
    for (const dependencyId of known) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(task.id);
      dependents.set(dependencyId, list);
    }
  }

  const ready = tasks.filter((task) => (indegree.get(task.id) ?? 0) === 0);
  const ordered: Task[] = [];
  const seen = new Set<string>();
  const profile = POLICIES[policy];

  while (ready.length > 0) {
    ready.sort((a, b) =>
      compareTasks(a, b, profile.ordering, context.riskLevel),
    );
    const task = ready.shift();
    if (task === undefined || seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    ordered.push(task);
    for (const dependentId of dependents.get(task.id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        const dependent = byId.get(dependentId);
        if (dependent !== undefined) {
          ready.push(dependent);
        }
      }
    }
  }

  for (const task of tasks) {
    if (!seen.has(task.id)) {
      ordered.push(task);
    }
  }
  return ordered;
}

function compareTasks(
  a: Task,
  b: Task,
  ordering: 'edf' | 'priority_then_length' | 'longest_first',
  riskLevel: 'p50' | 'p90',
): number {
  if (ordering === 'edf') {
    return (
      compareDue(a, b) ||
      a.priority - b.priority ||
      compareText(a.id, b.id)
    );
  }
  if (ordering === 'priority_then_length') {
    return (
      a.priority - b.priority ||
      taskRequiredMinutes(b, riskLevel) - taskRequiredMinutes(a, riskLevel) ||
      compareDue(a, b) ||
      compareText(a.id, b.id)
    );
  }
  return (
    taskRequiredMinutes(b, riskLevel) - taskRequiredMinutes(a, riskLevel) ||
    a.priority - b.priority ||
    compareDue(a, b) ||
    compareText(a.id, b.id)
  );
}

function compareDue(a: Task, b: Task): number {
  const dueA = a.dueAt === undefined ? Number.POSITIVE_INFINITY : parseInstant(a.dueAt);
  const dueB = b.dueAt === undefined ? Number.POSITIVE_INFINITY : parseInstant(b.dueAt);
  return dueA - dueB;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildChunks(task: Task, remainingMin: number): ChunkSpec {
  if (remainingMin <= 0) {
    return { chunks: [], reason: undefined };
  }
  const requiredUnits = Math.floor(remainingMin / 5);
  const reason =
    remainingMin % 5 === 0 ? undefined : 'estimate_not_grid_aligned';
  if (requiredUnits <= 0) {
    return { chunks: [], reason: reason ?? 'estimate_below_grid' };
  }

  if (!task.splittable) {
    return { chunks: [requiredUnits * 5], reason };
  }

  const minUnits = Math.max(1, Math.ceil(task.minSessionMin / 5));
  const maxUnits = Math.max(minUnits, Math.floor(task.maxSessionMin / 5));
  const count = Math.max(1, Math.ceil(requiredUnits / maxUnits));

  if (count * minUnits > requiredUnits) {
    return {
      chunks: [requiredUnits * 5],
      reason: reason ?? 'session_bounds_infeasible',
    };
  }

  const base = Math.floor(requiredUnits / count);
  const remainder = requiredUnits % count;
  const chunks: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const units = base + (index < remainder ? 1 : 0);
    chunks.push(units * 5);
  }
  return { chunks, reason };
}

function selectPlacement(
  context: BuildContext,
  state: PlanState,
  policy: PolicyName,
  taskId: string,
  durationMin: number,
  minStartMs: number,
  maxEndMs: number,
): Position | undefined {
  const durationMs = durationMin * MINUTE_MS;
  if (durationMs <= 0 || durationMs % GRID_MS !== 0) {
    return undefined;
  }
  const cellCount = durationMs / GRID_MS;

  if (policy === 'front_loaded') {
    for (const slot of context.slotsByStart) {
      const position = firstPassingInSlot(
        context,
        state,
        slot,
        cellCount,
        minStartMs,
        maxEndMs,
      );
      if (position !== undefined) {
        return position;
      }
    }
    return undefined;
  }

  if (policy === 'focus_blocked') {
    for (const slot of context.slotsByLength) {
      let best: Position | undefined;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const position of passingInSlot(
        context,
        state,
        slot,
        cellCount,
        minStartMs,
        maxEndMs,
      )) {
        const delta = switchDelta(state, position.startMs, position.endMs, taskId);
        if (delta < bestDelta) {
          bestDelta = delta;
          best = position;
        }
      }
      if (best !== undefined) {
        return best;
      }
    }
    return undefined;
  }

  const best = bestBalancedPosition(
    context,
    state,
    cellCount,
    minStartMs,
    maxEndMs,
    6,
  );
  if (best !== undefined) {
    return best;
  }
  return bestBalancedPosition(
    context,
    state,
    cellCount,
    minStartMs,
    maxEndMs,
    1,
  );
}

/**
 * Balanced placement evaluates candidate days. A 30-minute stride keeps the
 * scan cheap on large horizons; when it finds nothing (tight gaps not aligned
 * to the stride) the caller retries every 5-minute cell.
 */
function bestBalancedPosition(
  context: BuildContext,
  state: PlanState,
  cellCount: number,
  minStartMs: number,
  maxEndMs: number,
  stride: number,
): Position | undefined {
  let best: Position | undefined;
  let bestMaxLoad = Number.POSITIVE_INFINITY;
  let bestSumSquares = Number.POSITIVE_INFINITY;
  for (const slot of context.slotsByStart) {
    for (const position of passingInSlot(
      context,
      state,
      slot,
      cellCount,
      minStartMs,
      maxEndMs,
      stride,
    )) {
      const loads = positionLoads(position, cellCount, state.timeZone);
      let maxLoad = 0;
      let sumSquares = 0;
      for (const [date, minutes] of state.dailyLoad) {
        const total = minutes + (loads.get(date) ?? 0);
        maxLoad = Math.max(maxLoad, total);
        sumSquares += total * total;
      }
      for (const [date, minutes] of loads) {
        if (!state.dailyLoad.has(date)) {
          maxLoad = Math.max(maxLoad, minutes);
          sumSquares += minutes * minutes;
        }
      }
      if (
        maxLoad < bestMaxLoad ||
        (maxLoad === bestMaxLoad && sumSquares < bestSumSquares)
      ) {
        bestMaxLoad = maxLoad;
        bestSumSquares = sumSquares;
        best = position;
      }
    }
  }
  return best;
}

function firstPassingInSlot(
  context: BuildContext,
  state: PlanState,
  slot: SlotInfo,
  cellCount: number,
  minStartMs: number,
  maxEndMs: number,
): Position | undefined {
  for (const position of passingInSlot(
    context,
    state,
    slot,
    cellCount,
    minStartMs,
    maxEndMs,
  )) {
    return position;
  }
  return undefined;
}

function* passingInSlot(
  context: BuildContext,
  state: PlanState,
  slot: SlotInfo,
  cellCount: number,
  minStartMs: number,
  maxEndMs: number,
  stride = 1,
): Generator<Position> {
  const limit = slot.cellStarts.length - cellCount;
  for (let index = 0; index <= limit; index += stride) {
    const startMs = slot.cellStarts[index];
    if (startMs === undefined) {
      continue;
    }
    if (startMs < minStartMs) {
      continue;
    }
    const endMs = startMs + cellCount * GRID_MS;
    if (endMs > maxEndMs || endMs > slot.endMs) {
      break;
    }
    if (!passes(context, state, startMs, endMs)) {
      continue;
    }
    yield { startMs, endMs, slotId: slot.id, slot, cellIndex: index };
  }
}

/**
 * Daily-load contribution of a candidate. Most blocks stay inside one local
 * date, so the precomputed per-cell dates avoid a `partitionByLocalDate` call
 * per candidate; boundary-straddling blocks still use the exact splitter.
 */
function positionLoads(
  position: Position,
  cellCount: number,
  timeZone: string,
): Map<string, number> {
  const dates = new Set<string>();
  for (let offset = 0; offset < cellCount; offset += 1) {
    const date = position.slot.cellDates[position.cellIndex + offset];
    if (date !== undefined) {
      dates.add(date);
    }
  }
  if (dates.size === 1) {
    const date = dates.values().next().value;
    return new Map(date === undefined ? [] : [[date, cellCount * 5]]);
  }
  return blockDailyLoads(position.startMs, position.endMs, timeZone);
}

function passes(
  context: BuildContext,
  state: PlanState,
  startMs: number,
  endMs: number,
): boolean {
  if (overlapsAny(state.intervals, startMs, endMs)) {
    return false;
  }
  if (h6WouldBreak(context, state.intervals, startMs, endMs)) {
    return false;
  }
  const loads = blockDailyLoads(startMs, endMs, state.timeZone);
  for (const [date, minutes] of loads) {
    if ((state.dailyLoad.get(date) ?? 0) + minutes > context.maxDailyFocusMin) {
      return false;
    }
  }
  return true;
}

function overlapsAny(
  intervals: Interval[],
  startMs: number,
  endMs: number,
): boolean {
  for (const interval of intervals) {
    if (interval.startMs >= endMs) {
      break;
    }
    if (interval.endMs > startMs) {
      return true;
    }
  }
  return false;
}

function h6WouldBreak(
  context: BuildContext,
  intervals: Interval[],
  startMs: number,
  endMs: number,
): boolean {
  if (context.breakAfterMs <= 0) {
    return false;
  }

  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const interval = intervals[middle];
    if (interval !== undefined && interval.startMs <= startMs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  let runStart = startMs;
  let runEnd = endMs;
  let index = low - 1;
  while (index >= 0) {
    const previous = intervals[index];
    if (previous === undefined) {
      break;
    }
    if (runStart - previous.endMs >= context.breakMs) {
      break;
    }
    runStart = Math.min(runStart, previous.startMs);
    runEnd = Math.max(runEnd, previous.endMs);
    index -= 1;
  }
  index = low;
  while (index < intervals.length) {
    const next = intervals[index];
    if (next === undefined) {
      break;
    }
    if (next.startMs - runEnd >= context.breakMs) {
      break;
    }
    runEnd = Math.max(runEnd, next.endMs);
    index += 1;
  }
  return runEnd - runStart > context.breakAfterMs;
}

function switchDelta(
  state: PlanState,
  startMs: number,
  endMs: number,
  taskId: string,
): number {
  let previous: Interval | undefined;
  let next: Interval | undefined;
  for (const interval of state.intervals) {
    if (interval.endMs <= startMs) {
      previous = interval;
    } else if (interval.startMs >= endMs) {
      next = interval;
      break;
    }
  }
  let delta = 0;
  if (previous !== undefined && previous.taskId !== taskId) {
    delta += 1;
  }
  if (next !== undefined && next.taskId !== taskId) {
    delta += 1;
  }
  return delta;
}

function addPlacement(state: PlanState, placement: Placement): void {
  state.placements.push(placement);
  insertInterval(state.intervals, {
    startMs: placement.startMs,
    endMs: placement.endMs,
    taskId: placement.taskId,
  });
  addLoads(
    state.dailyLoad,
    blockDailyLoads(placement.startMs, placement.endMs, state.timeZone),
  );
}

function removePlacement(state: PlanState, placement: Placement): void {
  const index = state.placements.findIndex(
    (candidate) =>
      candidate.taskId === placement.taskId &&
      candidate.startMs === placement.startMs &&
      candidate.endMs === placement.endMs,
  );
  if (index < 0) {
    return;
  }
  state.placements.splice(index, 1);
  removeInterval(state.intervals, placement);
  addLoads(
    state.dailyLoad,
    negateLoads(
      blockDailyLoads(placement.startMs, placement.endMs, state.timeZone),
    ),
  );
}

function insertInterval(intervals: Interval[], interval: Interval): void {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const current = intervals[middle];
    if (
      current !== undefined &&
      (current.startMs < interval.startMs ||
        (current.startMs === interval.startMs &&
          current.endMs <= interval.endMs))
    ) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  intervals.splice(low, 0, interval);
}

function removeInterval(intervals: Interval[], placement: Placement): void {
  const index = intervals.findIndex(
    (interval) =>
      interval.taskId === placement.taskId &&
      interval.startMs === placement.startMs &&
      interval.endMs === placement.endMs,
  );
  if (index >= 0) {
    intervals.splice(index, 1);
  }
}

function addLoads(
  target: Map<string, number>,
  loads: Map<string, number>,
): void {
  for (const [date, minutes] of loads) {
    const next = (target.get(date) ?? 0) + minutes;
    if (Math.abs(next) < 1e-9) {
      target.delete(date);
    } else {
      target.set(date, next);
    }
  }
}

function negateLoads(loads: Map<string, number>): Map<string, number> {
  const negated = new Map<string, number>();
  for (const [date, minutes] of loads) {
    negated.set(date, -minutes);
  }
  return negated;
}

function blockDailyLoads(
  startMs: number,
  endMs: number,
  timeZone: string,
): Map<string, number> {
  const loads = new Map<string, number>();
  for (const segment of partitionByLocalDate(startMs, endMs, timeZone)) {
    const minutes = (segment.endMs - segment.startMs) / MINUTE_MS;
    loads.set(segment.date, (loads.get(segment.date) ?? 0) + minutes);
  }
  return loads;
}

interface Window {
  minStartMs: number;
  maxEndMs: number;
}

function placementWindow(
  context: BuildContext,
  state: PlanState,
  taskId: string,
): Window {
  const task = context.input.tasks.find((candidate) => candidate.id === taskId);
  let minStartMs = Math.max(context.horizonStartMs, context.nowMs);
  let maxEndMs = context.horizonEndMs;
  if (task === undefined) {
    return { minStartMs, maxEndMs };
  }

  if (task.earliestStartAt !== undefined) {
    minStartMs = Math.max(minStartMs, parseInstant(task.earliestStartAt));
  }
  for (const dependencyId of task.dependsOn) {
    for (const interval of state.intervals) {
      if (interval.taskId === dependencyId) {
        minStartMs = Math.max(minStartMs, interval.endMs);
      }
    }
  }
  if (task.dueAt !== undefined) {
    maxEndMs = Math.min(
      maxEndMs,
      parseInstant(task.dueAt) - (task.bufferBeforeDueMin ?? 0) * MINUTE_MS,
    );
  }
  for (const other of context.input.tasks) {
    if (!other.dependsOn.includes(taskId)) {
      continue;
    }
    for (const interval of state.intervals) {
      if (interval.taskId === other.id) {
        maxEndMs = Math.min(maxEndMs, interval.startMs);
      }
    }
  }
  return { minStartMs, maxEndMs };
}

/**
 * Bounded local improvement: each new block is offered -60/-30/+30/+60 minute
 * positions inside its own slot and kept only when the policy objective
 * strictly improves. Seeded existing blocks are never moved here, preserving
 * change minimisation. At most `cap` (<= 200) block moves are tried.
 */
function improvePlacements(
  context: BuildContext,
  policy: PolicyName,
  state: PlanState,
  cap: number,
  prng: Prng,
): Placement[] {
  const targets = state.placements
    .filter((placement) => !placement.seeded)
    .map((placement) => ({ ...placement }));
  for (let index = targets.length - 1; index > 0; index -= 1) {
    const swapIndex = prng.nextInt(index + 1);
    const current = targets[index];
    const other = targets[swapIndex];
    if (current !== undefined && other !== undefined) {
      targets[index] = other;
      targets[swapIndex] = current;
    }
  }
  let evaluations = 0;

  for (const target of targets) {
    if (evaluations >= cap) {
      break;
    }
    if (!state.placements.some((placement) => samePlacement(placement, target))) {
      continue;
    }

    removePlacement(state, target);
    const window = placementWindow(context, state, target.taskId);
    evaluations += 1;

    addPlacement(state, target);
    const originalScore = objectiveScore(context, state, policy);
    removePlacement(state, target);

    let best: Placement | undefined;
    let bestScore = originalScore;
    for (const position of neighborPositions(context, state, target, window)) {
      const moved: Placement = {
        ...target,
        startMs: position.startMs,
        endMs: position.endMs,
        slotId: position.slotId,
      };
      addPlacement(state, moved);
      const movedScore = objectiveScore(context, state, policy);
      removePlacement(state, moved);
      if (movedScore > bestScore + 1e-9) {
        bestScore = movedScore;
        best = moved;
      }
    }

    addPlacement(state, best ?? target);
  }

  return state.placements.map((placement) => ({ ...placement }));
}

function* neighborPositions(
  context: BuildContext,
  state: PlanState,
  target: Placement,
  window: Window,
): Generator<Position> {
  const slot = context.slotsByStart[target.slotId];
  if (slot === undefined) {
    return;
  }
  const cellCount = (target.durationMin * MINUTE_MS) / GRID_MS;
  if (!Number.isInteger(cellCount) || cellCount <= 0) {
    return;
  }
  const currentIndex = Math.round((target.startMs - slot.startMs) / GRID_MS);
  const limit = slot.cellStarts.length - cellCount;
  const indices = new Set<number>();
  for (const offset of [-12, -6, 6, 12]) {
    const index = currentIndex + offset;
    if (index >= 0 && index <= limit) {
      indices.add(index);
    }
  }

  for (const index of [...indices].sort((a, b) => a - b)) {
    const startMs = slot.cellStarts[index];
    if (startMs === undefined || startMs === target.startMs) {
      continue;
    }
    if (startMs < window.minStartMs) {
      continue;
    }
    const endMs = startMs + cellCount * GRID_MS;
    if (endMs > window.maxEndMs || endMs > slot.endMs) {
      continue;
    }
    if (!passes(context, state, startMs, endMs)) {
      continue;
    }
    yield { startMs, endMs, slotId: slot.id, slot, cellIndex: index };
  }
}

function samePlacement(a: Placement, b: Placement): boolean {
  return (
    a.taskId === b.taskId &&
    a.startMs === b.startMs &&
    a.endMs === b.endMs
  );
}

function objectiveScore(
  context: BuildContext,
  state: PlanState,
  policy: PolicyName,
): number {
  const weights = POLICIES[policy].weights;
  const spanMin = Math.max(
    1,
    (context.horizonEndMs - context.horizonStartMs) / MINUTE_MS,
  );

  const lastEndByTask = new Map<string, number>();
  for (const interval of state.intervals) {
    lastEndByTask.set(
      interval.taskId,
      Math.max(lastEndByTask.get(interval.taskId) ?? 0, interval.endMs),
    );
  }
  let completionSum = 0;
  let completionCount = 0;
  for (const task of context.input.tasks) {
    const lastEnd = lastEndByTask.get(task.id);
    if (lastEnd === undefined) {
      continue;
    }
    completionSum += clamp(
      (lastEnd - context.horizonStartMs) / (context.horizonEndMs - context.horizonStartMs),
      0,
      1,
    );
    completionCount += 1;
  }
  const s1 = completionCount > 0 ? 1 - completionSum / completionCount : 0;

  let maxLoad = 0;
  let totalLoad = 0;
  for (const minutes of state.dailyLoad.values()) {
    maxLoad = Math.max(maxLoad, minutes);
    totalLoad += minutes;
  }
  const s2 = totalLoad > 0 ? 1 - maxLoad / totalLoad : 0;

  const taskById = new Map(context.input.tasks.map((task) => [task.id, task]));
  let preferredTotal = 0;
  let preferredFit = 0;
  for (const placement of state.placements) {
    const task = taskById.get(placement.taskId);
    const windows = task?.preferredWindows ?? [];
    if (windows.length === 0) {
      continue;
    }
    preferredTotal += placement.durationMin;
    if (matchesPreferredWindow(placement, windows, state.timeZone)) {
      preferredFit += placement.durationMin;
    }
  }
  const s3 = preferredTotal > 0 ? preferredFit / preferredTotal : 1;

  const blockCount = state.intervals.length;
  const switches = countContextSwitches(state.intervals, state.timeZone);
  const s4 = blockCount > 1 ? 1 - switches / (blockCount - 1) : 1;

  const existing = context.input.existingBlocks ?? [];
  let existingMinutes = 0;
  let retainedMinutes = 0;
  for (const block of existing) {

    const startMs = parseInstant(block.start);
    const endMs = parseInstant(block.end);
    existingMinutes += (endMs - startMs) / MINUTE_MS;
    for (const interval of state.intervals) {
      if (interval.taskId !== block.taskId) {
        continue;
      }
      retainedMinutes +=
        Math.max(
          0,
          Math.min(endMs, interval.endMs) - Math.max(startMs, interval.startMs),
        ) / MINUTE_MS;
    }
  }
  const s5 = existingMinutes > 0 ? retainedMinutes / existingMinutes : 1;
  // 06 §7: replanning triples the retain-existing (S5) weight.
  const s5Weight =
    weights.s5RetainExisting * (existingMinutes > 0 ? 3 : 1);

  const slack = minSlackMinutes(context, state);
  const s6 = clamp(slack, 0, spanMin) / spanMin;

  return (
    weights.s1EarlyCompletion * s1 +
    weights.s2DailySpread * s2 +
    weights.s3PreferredWindows * s3 +
    weights.s4ContextSwitches * s4 +
    s5Weight * s5 +
    weights.s6MinSlack * s6
  );
}

function matchesPreferredWindow(
  placement: Placement,
  windows: string[],
  timeZone: string,
): boolean {
  const local = instantToZoned(
    Math.floor((placement.startMs + placement.endMs) / 2),
    timeZone,
  );
  const hour = local.hour;
  for (const window of windows) {
    if (window === 'morning' && hour >= 6 && hour < 12) {
      return true;
    }
    if (window === 'afternoon' && hour >= 12 && hour < 18) {
      return true;
    }
    if (window === 'evening' && hour >= 18 && hour < 24) {
      return true;
    }
  }
  return false;
}

function minSlackMinutes(context: BuildContext, state: PlanState): number {
  const lastEndByTask = new Map<string, number>();
  for (const interval of state.intervals) {
    lastEndByTask.set(
      interval.taskId,
      Math.max(lastEndByTask.get(interval.taskId) ?? 0, interval.endMs),
    );
  }

  let minimum = Number.POSITIVE_INFINITY;
  let sawDeadline = false;
  for (const task of context.input.tasks) {
    if (task.dueAt === undefined) {
      continue;
    }
    sawDeadline = true;
    const lastEnd =
      lastEndByTask.get(task.id) ?? context.horizonStartMs;
    const slack =
      (parseInstant(task.dueAt) -
        (task.bufferBeforeDueMin ?? 0) * MINUTE_MS -
        lastEnd) /
      MINUTE_MS;
    minimum = Math.min(minimum, slack);
  }
  if (sawDeadline && Number.isFinite(minimum)) {
    return minimum;
  }
  let lastEnd = context.horizonStartMs;
  for (const interval of state.intervals) {
    lastEnd = Math.max(lastEnd, interval.endMs);
  }
  return (context.horizonEndMs - lastEnd) / MINUTE_MS;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

/**
 * Adjacent blocks on the same local date with different task ids. A day
 * boundary is not a context switch; the metric tracks intra-day task changes.
 */
function countContextSwitches(
  intervals: Interval[],
  timeZone: string,
): number {
  let switches = 0;
  for (let index = 1; index < intervals.length; index += 1) {
    const previous = intervals[index - 1];
    const current = intervals[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (previous.taskId === current.taskId) {
      continue;
    }
    const previousDate = instantToZoned(
      Math.max(previous.startMs, previous.endMs - 1),
      timeZone,
    )
      .toPlainDate()
      .toString();
    const currentDate = instantToZoned(current.startMs, timeZone)
      .toPlainDate()
      .toString();
    if (previousDate === currentDate) {
      switches += 1;
    }
  }
  return switches;
}

function buildMetrics(
  context: BuildContext,
  state: PlanState,
  replan: ReplanPlan,
  capacityDeficitMin: number,
): PlanMetrics {
  let totalFocusMin = 0;
  for (const interval of state.intervals) {
    totalFocusMin += (interval.endMs - interval.startMs) / MINUTE_MS;
  }

  let maxDailyLoadMin = 0;
  let dailyTotal = 0;
  for (const minutes of state.dailyLoad.values()) {
    maxDailyLoadMin = Math.max(maxDailyLoadMin, minutes);
    dailyTotal += minutes;
  }
  const activeDays = state.dailyLoad.size;
  const avgDailyLoadMin = activeDays > 0 ? dailyTotal / activeDays : 0;

  const contextSwitches = countContextSwitches(
    state.intervals,
    state.timeZone,
  );

  const candidateKeys = new Set(
    state.placements.map((placement) =>
      blockKey(placement.taskId, placement.startMs, placement.endMs),
    ),
  );
  const existingKeys = new Set(
    replan.movableExisting.map((interval) =>
      blockKey(interval.taskId, interval.startMs, interval.endMs),
    ),
  );
  let changedBlocks = 0;
  for (const key of candidateKeys) {
    if (!existingKeys.has(key)) {
      changedBlocks += 1;
    }
  }
  for (const key of existingKeys) {
    if (!candidateKeys.has(key)) {
      changedBlocks += 1;
    }
  }

  const placedByTask = new Map<string, number>();
  for (const interval of state.intervals) {
    placedByTask.set(
      interval.taskId,
      (placedByTask.get(interval.taskId) ?? 0) +
        (interval.endMs - interval.startMs) / MINUTE_MS,
    );
  }

  let shortfall = 0;
  let coverageTarget = 0;
  let coverageCovered = 0;
  for (const task of context.input.tasks) {
    const required = taskRequiredMinutes(task, context.riskLevel);
    const placed = placedByTask.get(task.id) ?? 0;
    shortfall += Math.max(0, required - placed);
    coverageTarget += required;
    coverageCovered += Math.min(required, placed);
  }

  return {
    totalFocusMin,
    minSlackMin: minSlackMinutes(context, state),
    maxDailyLoadMin,
    avgDailyLoadMin,
    contextSwitches,
    changedBlocks,
    deficitMin: shortfall,
    capacityDeficitMin,
    p90CoverageRatio:
      coverageTarget > 0 ? coverageCovered / coverageTarget : 1,
  };
}

function blockKey(taskId: string, startMs: number, endMs: number): string {
  return `${taskId}|${startMs}|${endMs}`;
}

function finalize(candidates: PlanCandidate[]): GenerateResult {
  let kept: PlanCandidate[] = [];
  let dropped = 0;
  for (const candidate of candidates) {
    const similar = kept
      .map((earlier, index) => ({
        earlier,
        index,
        close: candidateDistance(earlier.blocks, candidate.blocks) < 0.15,
      }))
      .filter((entry) => entry.close);

    if (similar.length === 0) {
      kept.push(candidate);
      continue;
    }

    if (!candidate.feasible) {
      dropped += 1;
      continue;
    }

    const hasFeasibleSimilar = similar.some((entry) => entry.earlier.feasible);
    if (hasFeasibleSimilar) {
      dropped += 1;
      continue;
    }

    // Feasible newcomer wins over every similar infeasible plan. Remove all
    // such similarities first so the kept set stays pairwise diverse.
    const removeIndices = new Set(similar.map((entry) => entry.index));
    kept = kept.filter((_, index) => {
      if (removeIndices.has(index)) {
        dropped += 1;
        return false;
      }
      return true;
    });
    kept.push(candidate);
  }

  if (dropped > 0) {
    return {
      candidates: kept,
      diversityNote: `${kept.length} distinct plan(s) from ${candidates.length} policy candidate(s); ${dropped} candidate(s) dropped as too similar (distance < 0.15).`,
    };
  }
  if (candidates.length > 1) {
    return {
      candidates: kept,
      diversityNote: `${kept.length} distinct plans from ${candidates.length} policy candidates (pairwise distance >= 0.15).`,
    };
  }
  return { candidates: kept };
}

function candidateDistance(a: Block[], b: Block[]): number {
  const byTaskA = groupTaskIntervals(a);
  const byTaskB = groupTaskIntervals(b);
  const taskIds = new Set([...byTaskA.keys(), ...byTaskB.keys()]);
  let total = 0;
  let overlap = 0;

  for (const taskId of taskIds) {
    const intervalsA = mergeIntervals(byTaskA.get(taskId) ?? []);
    const intervalsB = mergeIntervals(byTaskB.get(taskId) ?? []);
    const minutesA = sumIntervals(intervalsA);
    const minutesB = sumIntervals(intervalsB);
    total += Math.max(minutesA, minutesB);
    overlap += intersectionMinutes(intervalsA, intervalsB);
  }

  if (total <= 0) {
    return 0;
  }
  return 1 - overlap / total;
}

interface PlainInterval {
  startMs: number;
  endMs: number;
}

function groupTaskIntervals(blocks: Block[]): Map<string, PlainInterval[]> {
  const grouped = new Map<string, PlainInterval[]>();
  for (const block of blocks) {
    const list = grouped.get(block.taskId) ?? [];
    list.push({
      startMs: parseInstant(block.start),
      endMs: parseInstant(block.end),
    });
    grouped.set(block.taskId, list);
  }
  return grouped;
}

function mergeIntervals(intervals: PlainInterval[]): PlainInterval[] {
  const sorted = [...intervals].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  const merged: PlainInterval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function sumIntervals(intervals: PlainInterval[]): number {
  return intervals.reduce(
    (total, interval) => total + (interval.endMs - interval.startMs) / MINUTE_MS,
    0,
  );
}

function intersectionMinutes(
  a: PlainInterval[],
  b: PlainInterval[],
): number {
  let left = 0;
  let right = 0;
  let total = 0;
  while (left < a.length && right < b.length) {
    const first = a[left];
    const second = b[right];
    if (first === undefined || second === undefined) {
      break;
    }
    total +=
      Math.max(
        0,
        Math.min(first.endMs, second.endMs) -
          Math.max(first.startMs, second.startMs),
      ) / MINUTE_MS;
    if (first.endMs <= second.endMs) {
      left += 1;
    } else {
      right += 1;
    }
  }
  return total;
}
