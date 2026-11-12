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
  GRID_MINUTES,
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
import { itemFromMessage, type DiversityNoteItem, type ExplanationItem } from './codes.js';

export const GENERATOR_VERSION = 'm3-02.7';

/**
 * Deterministic work cap for one gap-fitted split search (`passes` checks plus
 * trial placements). The search is a fallback for fragmented free time, so it
 * must stay cheap even when no split exists. `fitSessionsIntoGaps` searches
 * at most twice per task (remainder after kept blocks, then a full re-split)
 * and each `searchGapSessions` runs `searchRuns` at most twice (policy order,
 * then time order), so a task costs at most 4 x GAP_FIT_BUDGET evaluations
 * per repair pass, each O(occupied intervals).
 */
const GAP_FIT_BUDGET = 512;

/** Explanation prefix used when a replan exceeds its 06 §7 change bound. */
const REPLAN_BOUND_PREFIX = 'Replan change bound exceeded:';

/** Generator heuristic reasons; each maps to a `heuristic_*` explanation code. */
type HeuristicReason =
  | 'insufficient_available_time'
  | 'no_contiguous_window'
  | 'estimate_not_grid_aligned'
  | 'estimate_below_grid'
  | 'session_bounds_infeasible';

const HEURISTIC_CODES = {
  insufficient_available_time: 'heuristic_insufficient_available_time',
  no_contiguous_window: 'heuristic_no_contiguous_window',
  estimate_not_grid_aligned: 'heuristic_estimate_not_grid_aligned',
  estimate_below_grid: 'heuristic_estimate_below_grid',
  session_bounds_infeasible: 'heuristic_session_bounds_infeasible',
} as const satisfies Record<HeuristicReason, ExplanationItem['code']>;

/**
 * Explanation lines are only ever built through this type (FU-62): every
 * English line travels with its coded item, so `explanation[i]` and
 * `explanationItems[i]` cannot drift apart or exist without each other.
 */
interface ExplainedLine {
  readonly item: ExplanationItem;
  readonly text: string;
}

function explainedLine(item: ExplanationItem, text: string): ExplainedLine {
  return { item, text };
}

function explanationFields(lines: readonly ExplainedLine[]): {
  explanation: string[];
  explanationItems: ExplanationItem[];
} {
  return {
    explanation: lines.map((line) => line.text),
    explanationItems: lines.map((line) => line.item),
  };
}

function policyLine(policy: PolicyName): ExplainedLine {
  const profile = POLICIES[policy];
  return explainedLine(
    { code: 'policy_summary', params: { policy, policyVersion: profile.version } },
    `Policy ${policy} v${profile.version}: ${profile.summary}`,
  );
}

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
  /** Local wall-clock hour at the placement midpoint (for preferred windows). */
  localHour: number;
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

/**
 * Frozen slice of a replan for one affected set (06 §7):
 * future existing blocks of every task outside the affected set, preserved
 * exactly, plus the affected existing block count for the change bound.
 */
interface ReplanScope {
  frozen: ReplanBlock[];
  frozenTasks: Set<string>;
  affectedExistingBlocks: number;
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
  /**
   * Future (start >= now), non-locked existing blocks per task in start order:
   * the blocks a replan may keep or move.
   */
  futureExistingByTask: Map<string, Interval[]>;
  /** Keys of `input.lockedBlocks`, to exclude from changedBlocks. */
  lockedKeys: Set<string>;
  breakAfterMs: number;
  breakMs: number;
  maxDailyFocusMin: number;
  horizonStartMs: number;
  horizonEndMs: number;
  nowMs: number;
  riskLevel: 'p50' | 'p90';
  taskById: Map<string, Task>;
  /** Direct dependents (successors) per task id; absent when there are none. */
  dependentsByTask: Map<string, Task[]>;
  /**
   * False when the unplaced work certainly exceeds the placeable time (grid
   * cells from max(horizon.start, now), capped per local date by
   * maxDailyFocusMin). No plan can be feasible then, so the repair pass of
   * `runPlacementAttempt` is skipped and the plain partial plan is reported.
   */
  repairPlausible: boolean;
  dueMsByTask: Map<string, number>;
  bufferMsByTask: Map<string, number>;
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
  reason: HeuristicReason | undefined;
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
 * only the affected tasks (trigger tasks, both endpoints of changed dependency
 * edges, and all successors) plus any predecessors released by the staged
 * feasibility expansion (06 §7). Existing blocks whose start is before `now`
 * are history (06 §7.1): they occupy time for H1/H6 but are exempt from
 * H2/H4/H5 and do not reduce `remainingMin`. New placements start at or after
 * max(horizon.start, now).
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
    const requiredTotal = finiteRequiredTotal(input);
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
  const result = finalize(candidates);
  const boundLines = new Map<string, DiversityNoteItem>();
  for (const candidate of candidates) {
    candidate.explanation.forEach((line, index) => {
      if (!line.startsWith(REPLAN_BOUND_PREFIX)) return;
      const item = candidate.explanationItems[index];
      if (item !== undefined) boundLines.set(line, item as DiversityNoteItem);
    });
  }
  if (boundLines.size > 0) {
    const note = [...boundLines.keys()].join(' ');
    const boundItems = [...boundLines.values()];
    result.diversityNote =
      result.diversityNote === undefined
        ? note
        : `${result.diversityNote} ${note}`;
    result.diversityNoteItems = [
      ...(result.diversityNoteItems ?? []),
      ...boundItems,
    ];
  }
  return result;
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
    // FU-59: hashed only when supplied, so pre-M5 inputs keep their hash.
    ...(input.affectedTaskIds === undefined
      ? {}
      : { affectedTaskIds: [...new Set(input.affectedTaskIds)].sort() }),
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
    let total = 0;
    for (const task of input.tasks) {
      total = boundedMinuteAdd(
        total,
        taskRequiredMinutes(task, input.prefs.riskLevel),
      );
    }
    return total;
  }
}

/**
 * Finite fallback total for rejected inputs. Invalid estimates (Infinity/NaN)
 * must not leak into candidate metrics, so only finite non-negative values are
 * summed.
 */
function finiteRequiredTotal(input: ScheduleInput): number {
  let total = 0;
  for (const task of input.tasks) {
    total = boundedMinuteAdd(
      total,
      taskRequiredMinutes(task, input.prefs.riskLevel),
    );
  }
  return total;
}

/**
 * Saturating addition for minute totals. Finite inputs individual values can
 * still overflow when summed (FU-43); the result stays finite and
 * JSON-serializable instead of becoming Infinity.
 */
function boundedMinuteAdd(total: number, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return total;
  }
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER - value) {
    return Number.MAX_SAFE_INTEGER;
  }
  return total + value;
}

function invalidInputCandidate(
  policy: PolicyName,
  inputHash: string,
  issues: InputIssue[],
  requiredTotal: number,
): PlanCandidate {
  const lines: ExplainedLine[] = [
    policyLine(policy),
    explainedLine(
      { code: 'input_rejected', params: { issueCount: issues.length } },
      `Input rejected before generation: ${issues.map((issue) => issue.code).join(', ')}.`,
    ),
    ...issues
      .slice(0, 5)
      .map((issue) =>
        explainedLine(itemFromMessage(issue), `${issue.code}: ${issue.message}`),
      ),
  ];
  return {
    policy,
    blocks: [],
    metrics: emptyMetrics(requiredTotal, requiredTotal),
    feasible: false,
    deficitMin: requiredTotal,
    capacityDeficitMin: requiredTotal,
    ...explanationFields(lines),
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
  const placementStartMs = Math.max(horizonStartMs, nowMs);
  const placeableCellsByDate = new Map<string, number>();

  for (const slot of slots) {
    const startMs = parseInstant(slot.start);
    const endMs = parseInstant(slot.end);
    const segments = partitionByLocalDate(startMs, endMs, input.timeZone);
    const cellStarts: number[] = [];
    const cellDates: string[] = [];
    for (let cursor = startMs; cursor + GRID_MS <= endMs; cursor += GRID_MS) {
      const date = dateAt(cursor, segments);
      cellStarts.push(cursor);
      cellDates.push(date);
      if (cursor >= placementStartMs) {
        placeableCellsByDate.set(
          date,
          (placeableCellsByDate.get(date) ?? 0) + 1,
        );
      }
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
  const futureExistingByTask = groupIntervalsByTask(
    toIntervals(input.existingBlocks ?? [])
      .filter(
        (interval) =>
          interval.startMs >= nowMs &&
          !lockedKeys.has(
            blockKey(interval.taskId, interval.startMs, interval.endMs),
          ),
      )
      .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs),
  );

  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const dependentsByTask = new Map<string, Task[]>();
  for (const task of input.tasks) {
    for (const dependencyId of task.dependsOn) {
      if (!taskById.has(dependencyId)) {
        continue;
      }
      const list = dependentsByTask.get(dependencyId) ?? [];
      list.push(task);
      dependentsByTask.set(dependencyId, list);
    }
  }
  const dueMsByTask = new Map<string, number>();
  const bufferMsByTask = new Map<string, number>();
  let unplacedMin = 0;
  for (const task of input.tasks) {
    if (task.dueAt !== undefined) {
      dueMsByTask.set(task.id, parseInstant(task.dueAt));
    }
    bufferMsByTask.set(task.id, (task.bufferBeforeDueMin ?? 0) * MINUTE_MS);
    unplacedMin = boundedMinuteAdd(
      unplacedMin,
      taskRequiredMinutes(task, input.prefs.riskLevel) -
        minutesOf(lockedByTask.get(task.id) ?? []),
    );
  }
  // One grid step of slack per date: a cell is dated by its start and may
  // reach under one step into the next local date.
  let placeableMin = 0;
  for (const cells of placeableCellsByDate.values()) {
    placeableMin += Math.min(
      (cells + 1) * GRID_MINUTES,
      input.prefs.maxDailyFocusMin + GRID_MINUTES,
    );
  }

  return {
    input,
    slotsByStart,
    slotsByLength,
    lockedIntervals,
    lockedByTask,
    historyBlocks,
    historyIntervals,
    historyByTask,
    futureExistingByTask,
    lockedKeys,
    breakAfterMs: input.prefs.breakAfterMin * MINUTE_MS,
    breakMs: input.prefs.breakMin * MINUTE_MS,
    maxDailyFocusMin: input.prefs.maxDailyFocusMin,
    horizonStartMs,
    horizonEndMs,
    nowMs,
    riskLevel: input.prefs.riskLevel,
    taskById,
    dependentsByTask,
    repairPlausible: unplacedMin <= placeableMin,
    dueMsByTask,
    bufferMsByTask,
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
  // FU-59: explicit caller scope. Unknown ids are ignored: the caller may pass
  // tasks that disappeared between its read and generation, and an unknown task
  // has no blocks to release anyway.
  for (const taskId of context.input.affectedTaskIds ?? []) {
    if (taskById.has(taskId)) {
      affected.add(taskId);
    }
  }
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
    const requiredMin = taskRequiredMinutes(task, context.riskLevel);
    if (
      Math.abs(fixedMin + movableMin - requiredMin) > 1e-9
    ) {
      // An existing-block set that does not exactly cover the requirement is
      // not a complete seed: release the task so the remainder can be placed
      // (or the whole task rescheduled when the seed blocks the optimum).
      affected.add(taskId);
    }
  }

  // Dry-run seed validation to learn which tasks genuinely have to be
  // released (invalid commitment-overlapping seed, changed dependency,
  // unrepresentable remainder). Everything else is frozen exactly.
  const dryRun = buildReplanSeeds(
    context,
    { movable, frozenTasks: new Set() },
    affected,
  );
  const baseAffectedTasks = propagateAffected(context, dryRun.affected);
  return {
    movable,
    baseAffectedTasks,
    movableExisting,
  };
}

/**
 * Split a replan into the frozen (unaffected) existing blocks and the affected
 * block count for the current affected set. Releasing more tasks (the staged
 * predecessor expansion in 06 §7) only ever unfreezes their own blocks.
 */
function scopeForReplan(
  replan: ReplanPlan,
  affected: Set<string>,
): ReplanScope {
  const frozen = replan.movable.filter(
    (item) => !affected.has(item.taskId),
  );
  return {
    frozen,
    frozenTasks: new Set(frozen.map((item) => item.taskId)),
    affectedExistingBlocks: replan.movable.length - frozen.length,
  };
}

/** Direct dependency ids of the affected tasks that are not yet affected. */
function directPredecessors(
  context: BuildContext,
  affected: Set<string>,
): Set<string> {
  const predecessors = new Set<string>();
  for (const task of context.input.tasks) {
    if (!affected.has(task.id)) {
      continue;
    }
    for (const dependencyId of task.dependsOn) {
      if (!affected.has(dependencyId)) {
        predecessors.add(dependencyId);
      }
    }
  }
  return predecessors;
}

/**
 * Build seeds for the given affected set, releasing more tasks until stable.
 * A seed is invalid when it starts before a dependency's last block, when the
 * task's remainder is below `minSessionMin`/cannot fit before a seeded
 * successor, or when H1/H2/H6/daily checks reject it (06 §7.1).
 */
function buildReplanSeeds(
  context: BuildContext,
  replan: Pick<ReplanPlan, 'movable'> & { frozenTasks: Set<string> },
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
      const frozenSeed = replan.frozenTasks.has(item.taskId);
      if (affected.has(item.taskId) && !frozenSeed) {
        continue;
      }
      const slot = findContainingSlot(context, item.startMs, item.endMs);
      if (
        !frozenSeed &&
        (slot === undefined ||
          !passes(context, state, item.startMs, item.endMs))
      ) {
        failedTask = item.taskId;
        break;
      }
      const placement: Placement = {
        taskId: item.taskId,
        durationMin: (item.endMs - item.startMs) / MINUTE_MS,
        startMs: item.startMs,
        endMs: item.endMs,
        slotId: slot?.id ?? -1,
        localHour: localHourOf(
          item.startMs,
          item.endMs,
          context.input.timeZone,
        ),
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
        // A dependency edge whose existing blocks are out of order has been
        // added or changed; 06 §7 keeps BOTH endpoints in the affected set so
        // the predecessor is not permanently frozen.
        next.add(seed.taskId);
        for (const dependencyId of task.dependsOn) {
          next.add(dependencyId);
        }
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
    // Unaffected tasks stay frozen even if a seed-level check wanted to
    // release them; the caller reports an infeasible/flagged candidate rather
    // than silently moving untouched blocks (06 §7).
    for (const taskId of replan.frozenTasks) {
      propagated.delete(taskId);
    }
    if (setsEqual(propagated, affected)) {
      return { seeds, affected };
    }
    affected = propagated;
  }

  return { seeds: [], affected };
}

/** Frozen, unaffected existing blocks as seeds; never released. */
function frozenSeeds(
  context: BuildContext,
  scope: ReplanScope,
): Placement[] {
  return scope.frozen.map((item) => ({
    taskId: item.taskId,
    durationMin: (item.endMs - item.startMs) / MINUTE_MS,
    startMs: item.startMs,
    endMs: item.endMs,
    slotId: findContainingSlot(context, item.startMs, item.endMs)?.id ?? -1,
    localHour: localHourOf(item.startMs, item.endMs, context.input.timeZone),
    seeded: true,
  }));
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

interface ReplanLevelAttempt {
  affected: Set<string>;
  scope: ReplanScope;
  result: PlacementAttempt;
  retainedSeeds: number;
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
  let affected = new Set(replan.baseAffectedTasks);
  let best: ReplanLevelAttempt | undefined;
  const maxExpansion = context.input.tasks.length + 2;

  for (let level = 0; level <= maxExpansion; level += 1) {
    const attempt = runReplanLevel(
      context,
      replan,
      affected,
      policy,
      seed,
      maxImprovement,
    );
    if (
      best === undefined ||
      isBetterAttempt(
        attempt.result,
        attempt.retainedSeeds,
        best.result,
        best.retainedSeeds,
      )
    ) {
      best = attempt;
    }
    if (attempt.result.violations.length === 0) {
      best = attempt;
      break;
    }
    // 06 §7: an affected task that cannot be fully placed because frozen
    // blocks are in the way releases its direct predecessors, one dependency
    // level per retry; successors of the expanded set join the scope. If the
    // set stops growing, the explained infeasible candidate is final.
    const predecessors = directPredecessors(context, attempt.affected);
    const expanded = propagateAffected(
      context,
      new Set([...attempt.affected, ...predecessors]),
    );
    if (setsEqual(expanded, attempt.affected)) {
      break;
    }
    affected = expanded;
  }

  const chosen = best ?? {
    affected,
    scope: scopeForReplan(replan, affected),
    result: runPlacementAttempt(context, policy, seed, maxImprovement, []),
    retainedSeeds: 0,
  };
  const result = chosen.result;
  // Existing blocks emitted unchanged: the attempt's seeds plus any own block
  // a gap-fitted split kept (`fitSessionsIntoGaps`).
  const retainedSeeds = result.placements.filter(
    (placement) => placement.seeded,
  ).length;

  const finalState = stateFromPlacements(context, result.placements);
  const blocks = blocksFromPlacements(finalState.placements);
  const metrics = buildMetrics(
    context,
    finalState,
    replan,
    capacityDeficitMin,
  );
  const feasible = result.violations.length === 0;
  let requiredTotalMin = 0;
  for (const task of context.input.tasks) {
    requiredTotalMin = boundedMinuteAdd(
      requiredTotalMin,
      taskRequiredMinutes(task, context.riskLevel),
    );
  }
  const placedTotalMin = Math.max(0, requiredTotalMin - metrics.deficitMin);

  const lines: ExplainedLine[] = [
    policyLine(policy),
    explainedLine(
      {
        code: 'placement_summary',
        params: {
          placedMin: placedTotalMin,
          requiredMin: requiredTotalMin,
          blockCount: blocks.length,
          retainedCount: retainedSeeds,
        },
      },
      `Placed ${placedTotalMin} of ${requiredTotalMin} required minutes in ${blocks.length} movable block(s), retaining ${retainedSeeds} existing block(s).`,
    ),
    feasible
      ? explainedLine(
          { code: 'constraints_satisfied', params: {} },
          'All hard constraints H1-H8 satisfied.',
        )
      : explainedLine(
          {
            code: 'infeasible_summary',
            params: { violationCount: result.violations.length },
          },
          `Infeasible with ${result.violations.length} hard violation(s): ${uniqueCodes(result.violations)}.`,
        ),
  ];
  if (!feasible) {
    for (const violation of result.violations.slice(0, 4)) {
      lines.push(explainedLine(itemFromMessage(violation), violation.message));
    }
  }
  for (const reason of [...result.reasons].sort()) {
    lines.push(
      explainedLine(
        { code: HEURISTIC_CODES[reason], params: {} },
        `Heuristic reason: ${reason}.`,
      ),
    );
  }
  lines.push(
    explainedLine(
      { code: 'unplaced_minutes', params: { deficitMin: metrics.deficitMin } },
      `Unplaced minutes (H7 shortfall): ${metrics.deficitMin} min.`,
    ),
  );
  lines.push(
    explainedLine(
      { code: 'capacity_deficit', params: { capacityDeficitMin } },
      `Capacity deficit: ${capacityDeficitMin} min.`,
    ),
  );

  if (replan.movableExisting.length > 0) {
    const bound = chosen.scope.affectedExistingBlocks * 2 + 2;
    if (metrics.changedBlocks > bound) {
      lines.push(
        explainedLine(
          {
            code: 'replan_bound_exceeded',
            params: {
              changedBlocks: metrics.changedBlocks,
              bound,
              affectedExistingBlocks: chosen.scope.affectedExistingBlocks,
            },
          },
          `${REPLAN_BOUND_PREFIX} ${metrics.changedBlocks} changed block(s) > ${bound} (2 × ${chosen.scope.affectedExistingBlocks} affected existing block(s) + 2). Unaffected blocks were preserved; this candidate is the best available.`,
        ),
      );
    }
  }

  return {
    policy,
    blocks,
    metrics,
    feasible,
    deficitMin: metrics.deficitMin,
    capacityDeficitMin,
    ...explanationFields(lines),
    inputHash,
    generatorVersion: GENERATOR_VERSION,
  };
}

/**
 * One affected-scope attempt (06 §7): freeze every task outside `affected`,
 * seed the rest, then release tasks that still raise hard violations. Never
 * releases a frozen (unaffected) task.
 */
function runReplanLevel(
  context: BuildContext,
  replan: ReplanPlan,
  affected: Set<string>,
  policy: PolicyName,
  seed: number,
  maxImprovement: number,
): ReplanLevelAttempt {
  const scope = scopeForReplan(replan, affected);
  let levelAffected = new Set(affected);
  let attempt = buildReplanSeeds(
    context,
    { movable: replan.movable, frozenTasks: scope.frozenTasks },
    levelAffected,
  );
  levelAffected = new Set(attempt.affected);
  let result = runPlacementAttempt(
    context,
    policy,
    seed,
    maxImprovement,
    attempt.seeds,
  );
  let retainedSeeds = attempt.seeds.length;
  let bestResult = result;
  let bestRetainedSeeds = retainedSeeds;
  let bestAffected = new Set(levelAffected);

  for (
    let iteration = 0;
    iteration <= context.input.tasks.length + 2 &&
    result.violations.length > 0;
    iteration += 1
  ) {
    const violating = new Set<string>();
    for (const violation of result.violations) {
      if (
        violation.taskId !== undefined &&
        !scope.frozenTasks.has(violation.taskId)
      ) {
        violating.add(violation.taskId);
      }
    }
    // A violation without a movable task owner (for example H6) or one that
    // only touches frozen/unaffected blocks cannot be repaired by releasing
    // more tasks; keep the best candidate and flag it instead of moving
    // untouched blocks (06 §7).
    if (violating.size === 0) {
      break;
    }
    const next = propagateAffected(
      context,
      new Set([...levelAffected, ...violating]),
    );
    for (const taskId of scope.frozenTasks) {
      next.delete(taskId);
    }
    if (setsEqual(next, levelAffected)) {
      break;
    }
    levelAffected = next;
    attempt = buildReplanSeeds(
      context,
      { movable: replan.movable, frozenTasks: scope.frozenTasks },
      levelAffected,
    );
    levelAffected = new Set(attempt.affected);
    result = runPlacementAttempt(
      context,
      policy,
      seed,
      maxImprovement,
      attempt.seeds,
    );
    retainedSeeds = attempt.seeds.length;
    if (
      isBetterAttempt(
        result,
        retainedSeeds,
        bestResult,
        bestRetainedSeeds,
      )
    ) {
      bestResult = result;
      bestRetainedSeeds = retainedSeeds;
      bestAffected = new Set(levelAffected);
    }
  }

  // Final fallback: release every affected task but keep frozen/unaffected
  // blocks. If a still-seeded attempt was feasible we never get here, so the
  // first feasible attempt wins. When every attempt is infeasible, rank by the
  // smallest H7 deficit, then the fewest violations, and only then by retained
  // seeds (plan continuity). Partial plans should first place as much required
  // work as possible. Unaffected blocks are never released (06 §7).
  if (result.violations.length > 0) {
    const frozen = frozenSeeds(context, scope);
    const fresh = runPlacementAttempt(
      context,
      policy,
      seed,
      maxImprovement,
      frozen,
    );
    if (isBetterAttempt(fresh, frozen.length, bestResult, bestRetainedSeeds)) {
      bestResult = fresh;
      bestRetainedSeeds = frozen.length;
      bestAffected = new Set(levelAffected);
    }
  }

  // Last resort for a frozen-block dead end: regenerate from scratch (no
  // seeds) and accept it only when every frozen/unaffected block is reproduced
  // exactly. This keeps 06 §7 preservation while allowing the unconstrained
  // greedy order that originally produced the frozen plan to find a feasible
  // placement for the affected tasks.
  if (bestResult.violations.length > 0) {
    const fromScratch = runPlacementAttempt(
      context,
      policy,
      seed,
      maxImprovement,
      [],
    );
    if (
      preservesFrozen(fromScratch.placements, scope.frozen) &&
      isBetterAttempt(fromScratch, 0, bestResult, bestRetainedSeeds)
    ) {
      bestResult = fromScratch;
      bestRetainedSeeds = 0;
      bestAffected = new Set(levelAffected);
    }
  }

  return {
    affected: bestAffected,
    scope: scopeForReplan(replan, bestAffected),
    result: bestResult,
    retainedSeeds: bestRetainedSeeds,
  };
}

/**
 * True when the placements reproduce every frozen (unaffected) existing block
 * exactly, with no extra block for that task.
 */
function preservesFrozen(
  placements: Placement[],
  frozen: ReplanBlock[],
): boolean {
  const expected = new Map<string, Set<string>>();
  for (const item of frozen) {
    const keys = expected.get(item.taskId) ?? new Set<string>();
    keys.add(blockKey(item.taskId, item.startMs, item.endMs));
    expected.set(item.taskId, keys);
  }
  const actual = new Map<string, Set<string>>();
  for (const placement of placements) {
    if (!expected.has(placement.taskId)) {
      continue;
    }
    const keys = actual.get(placement.taskId) ?? new Set<string>();
    keys.add(
      blockKey(placement.taskId, placement.startMs, placement.endMs),
    );
    actual.set(placement.taskId, keys);
  }
  for (const [taskId, keys] of expected) {
    const produced = actual.get(taskId);
    if (produced === undefined || produced.size !== keys.size) {
      return false;
    }
    for (const key of keys) {
      if (!produced.has(key)) {
        return false;
      }
    }
  }
  return true;
}

interface PlacementAttempt {
  placements: Placement[];
  violations: Violation[];
  reasons: Set<HeuristicReason>;
  /** H7 shortfall of this attempt, including locked minutes as placed. */
  deficitMin: number;
  /**
   * Plain pass only: a dead end the repair aids target was seen (a splittable
   * task without contiguous room for its equal chunks, a task that could not
   * follow its dependencies, or an H3 violation).
   */
  repairable: boolean;
  /** A task with dependencies could not be placed completely. */
  starved: boolean;
}

/** Settings of a repair pass of `placeTasks`. */
interface RepairAids {
  /** Extra time kept free before the room each dependent still needs. */
  successorSlackMs: number;
  /**
   * Whether a gap-fitted split first keeps the task's own still-valid blocks
   * (minimal change) before it re-splits the whole task.
   */
  keepOwnBlocks: boolean;
}

/**
 * Greedy placement plus bounded improvement for one seed set.
 *
 * The plain pass is the versioned policy greedy; a feasible plain plan is
 * returned as is. Otherwise, when the plan is repairable and the work is not
 * certainly over capacity, a repair pass repeats the greedy with two
 * feasibility aids (FU-69): the successor bound (`successorBound`) keeps a
 * task from ending so late that its dependents can no longer fit, and the
 * gap-fitted split (`fitSessionsIntoGaps`) covers a splittable task whose
 * equal chunks find no contiguous room. The successor bound ignores H6 and
 * keeping a task's own blocks can hold it too late for its dependents, so
 * when a dependent is still short one more repair pass keeps a break free
 * before every dependent's room and re-splits tasks from scratch.
 *
 * A repaired plan replaces the plain one only when it ranks strictly better
 * (feasible, then smaller H7 deficit, then fewer violations): an aided task
 * can cost a later task its room, and a partial plan must never get worse.
 */
function runPlacementAttempt(
  context: BuildContext,
  policy: PolicyName,
  seed: number,
  maxImprovement: number,
  seeds: Placement[],
): PlacementAttempt {
  const pass = (repair: RepairAids | undefined): PlacementAttempt =>
    placeTasks(context, policy, seed, maxImprovement, seeds, repair);
  const plain = pass(undefined);
  if (
    plain.violations.length === 0 ||
    !plain.repairable ||
    !context.repairPlausible
  ) {
    return plain;
  }
  let best = plain;
  const repaired = pass({ successorSlackMs: 0, keepOwnBlocks: true });
  if (isBetterAttempt(repaired, 0, best, 0)) {
    best = repaired;
  }
  if (best.violations.length > 0 && repaired.starved) {
    const spaced = pass({
      successorSlackMs: context.breakAfterMs > 0 ? context.breakMs : 0,
      keepOwnBlocks: false,
    });
    if (isBetterAttempt(spaced, 0, best, 0)) {
      best = spaced;
    }
  }
  return best;
}

function placeTasks(
  context: BuildContext,
  policy: PolicyName,
  seed: number,
  maxImprovement: number,
  seeds: Placement[],
  repair: RepairAids | undefined,
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

  const reasons = new Set<HeuristicReason>();
  let repairable = false;
  let starved = false;
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

  const ordered = orderTasks(context, policy);
  for (let taskIndex = 0; taskIndex < ordered.length; taskIndex += 1) {
    const task = ordered[taskIndex];
    if (task === undefined) {
      continue;
    }
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
    let windowEndMs = Math.min(context.horizonEndMs, dueMs - bufferMs);
    if (
      repair !== undefined &&
      remainingMin > 0 &&
      context.dependentsByTask.has(task.id)
    ) {
      // Leave room for the dependents: without this a policy can park the
      // task at the tail of the horizon and starve every successor (H3).
      windowEndMs = Math.min(
        windowEndMs,
        successorBound(
          context,
          state,
          ordered,
          taskIndex,
          repair.successorSlackMs,
        ),
      );
    }

    let lastEndMs = Number.NEGATIVE_INFINITY;
    for (const interval of state.intervals) {
      if (interval.taskId === task.id) {
        lastEndMs = Math.max(lastEndMs, interval.endMs);
      }
    }

    if (remainingMin > 0 && windowEndMs <= windowStartMs) {
      reasons.add('insufficient_available_time');
      starved ||= task.dependsOn.length > 0;
    } else {
      let placed: Placement[] = [];
      let unplaced = false;
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
          unplaced = true;
          break;
        }
        const placement: Placement = {
          taskId: task.id,
          durationMin,
          startMs: position.startMs,
          endMs: position.endMs,
          slotId: position.slotId,
          localHour: localHourOf(
            position.startMs,
            position.endMs,
            context.input.timeZone,
          ),
          seeded: false,
        };
        addPlacement(state, placement);
        placed.push(placement);
      }
      if (unplaced) {
        // The equal-size chunks need contiguous room that fragmented free time
        // (frozen replan blocks, commitments, locked blocks) may not offer
        // even though the task is splittable and the gaps add up. Fit the
        // sessions to the gaps before declaring a shortfall (06 §3 H5, §7.1).
        const fitted =
          repair !== undefined && chunks.reason === undefined
            ? fitSessionsIntoGaps(
                context,
                state,
                policy,
                task,
                remainingMin,
                windowStartMs,
                windowEndMs,
                placed,
                repair.keepOwnBlocks,
              )
            : undefined;
        if (fitted === undefined) {
          reasons.add(
            task.splittable
              ? 'insufficient_available_time'
              : 'no_contiguous_window',
          );
          starved ||= task.dependsOn.length > 0;
          repairable ||= task.splittable && chunks.reason === undefined;
        } else {
          placed = fitted;
        }
      }
      for (const placement of placed) {
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
  return {
    placements: finalPlacements,
    violations,
    reasons,
    deficitMin: attemptDeficitMin(context, finalPlacements),
    repairable:
      repairable ||
      starved ||
      violations.some((violation) => violation.code === 'H3'),
    starved,
  };
}

/** H7 shortfall for an attempt: required minutes minus live placements. */
function attemptDeficitMin(
  context: BuildContext,
  placements: Placement[],
): number {
  const placedByTask = new Map<string, number>();
  for (const placement of placements) {
    placedByTask.set(
      placement.taskId,
      (placedByTask.get(placement.taskId) ?? 0) + placement.durationMin,
    );
  }
  for (const interval of context.lockedIntervals) {
    placedByTask.set(
      interval.taskId,
      (placedByTask.get(interval.taskId) ?? 0) +
        (interval.endMs - interval.startMs) / MINUTE_MS,
    );
  }
  let shortfall = 0;
  for (const task of context.input.tasks) {
    const required = taskRequiredMinutes(task, context.riskLevel);
    const placed = placedByTask.get(task.id) ?? 0;
    shortfall += Math.max(0, required - placed);
  }
  return shortfall;
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

function isBetterAttempt(
  candidate: PlacementAttempt,
  candidateSeeds: number,
  current: PlacementAttempt,
  currentSeeds: number,
): boolean {
  const candidateFeasible = candidate.violations.length === 0;
  const currentFeasible = current.violations.length === 0;
  if (candidateFeasible !== currentFeasible) {
    return candidateFeasible;
  }
  if (candidate.deficitMin !== current.deficitMin) {
    return candidate.deficitMin < current.deficitMin;
  }
  if (candidate.violations.length !== current.violations.length) {
    return candidate.violations.length < current.violations.length;
  }
  return candidateSeeds > currentSeeds;
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

function localHourOf(
  startMs: number,
  endMs: number,
  timeZone: string,
): number {
  return instantToZoned(Math.floor((startMs + endMs) / 2), timeZone).hour;
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

interface SessionBounds {
  minUnits: number;
  maxUnits: number;
}

/** Contiguous free grid cells of one slot on one local date. */
interface FreeRun {
  slot: SlotInfo;
  firstCell: number;
  cellCount: number;
  startMs: number;
  /** Upper bound on the cells this run can host under the daily focus cap. */
  usableCells: number;
  /** Focus minutes already on the run's local date (balanced ordering). */
  dayLoadMin: number;
}

/**
 * True when `units` grid cells can be covered by whole sessions inside the
 * task's session bounds (zero cells need no session).
 */
function isRepresentable(units: number, bounds: SessionBounds): boolean {
  if (units === 0) {
    return true;
  }
  if (units < bounds.minUnits) {
    return false;
  }
  return Math.ceil(units / bounds.maxUnits) * bounds.minUnits <= units;
}

function cloneState(state: PlanState): PlanState {
  return {
    timeZone: state.timeZone,
    placements: [...state.placements],
    intervals: [...state.intervals],
    dailyLoad: new Map(state.dailyLoad),
  };
}

/**
 * Gap-fitted split for a splittable task whose equal-size chunks do not all
 * fit (FU-69). `buildChunks` asks for `ceil(required / maxSession)` equal
 * sessions, each needing its own contiguous room; when frozen replan blocks or
 * commitments fragment the free time, that fails although shorter sessions
 * inside [minSessionMin, maxSessionMin] would cover the requirement.
 *
 * The search runs on a copy of the state and commits only a COMPLETE split, so
 * a failed search leaves the partial equal-chunk placement untouched. With
 * `keepOwnBlocks` the task's own still-valid future blocks are kept first and
 * only the remainder is fitted (06 §7 S5, §7.1); then a full re-split is
 * tried.
 */
function fitSessionsIntoGaps(
  context: BuildContext,
  state: PlanState,
  policy: PolicyName,
  task: Task,
  remainingMin: number,
  windowStartMs: number,
  windowEndMs: number,
  nominal: Placement[],
  keepOwnBlocks: boolean,
): Placement[] | undefined {
  if (
    !task.splittable ||
    remainingMin <= 0 ||
    remainingMin % GRID_MINUTES !== 0
  ) {
    return undefined;
  }
  const bounds: SessionBounds = {
    minUnits: Math.max(1, Math.ceil(task.minSessionMin / GRID_MINUTES)),
    maxUnits: Math.floor(task.maxSessionMin / GRID_MINUTES),
  };
  const requiredUnits = remainingMin / GRID_MINUTES;
  if (
    bounds.maxUnits < bounds.minUnits ||
    !isRepresentable(requiredUnits, bounds)
  ) {
    return undefined;
  }

  const scratch = cloneState(state);
  for (const placement of nominal) {
    removePlacement(scratch, placement);
  }

  let sessions: Placement[] | undefined;
  const retained = keepOwnBlocks
    ? retainOwnBlocks(
        context,
        scratch,
        task,
        requiredUnits,
        bounds,
        windowStartMs,
        windowEndMs,
      )
    : [];
  if (retained.length > 0) {
    const retainedUnits = retained.reduce(
      (sum, placement) => sum + placement.durationMin / GRID_MINUTES,
      0,
    );
    const rest = searchGapSessions(
      context,
      scratch,
      policy,
      task,
      requiredUnits - retainedUnits,
      bounds,
      windowStartMs,
      windowEndMs,
    );
    if (rest === undefined) {
      for (const placement of retained) {
        removePlacement(scratch, placement);
      }
    } else {
      sessions = [...retained, ...rest];
    }
  }
  sessions ??= searchGapSessions(
    context,
    scratch,
    policy,
    task,
    requiredUnits,
    bounds,
    windowStartMs,
    windowEndMs,
  );
  if (sessions === undefined) {
    return undefined;
  }

  for (const placement of nominal) {
    removePlacement(state, placement);
  }
  for (const placement of sessions) {
    addPlacement(state, placement);
  }
  return sessions;
}

/**
 * Keep the task's own future existing blocks that are still valid sessions in
 * the current window and state, as long as the remainder stays representable.
 * The kept blocks are added to `state` as seeded placements.
 */
function retainOwnBlocks(
  context: BuildContext,
  state: PlanState,
  task: Task,
  requiredUnits: number,
  bounds: SessionBounds,
  windowStartMs: number,
  windowEndMs: number,
): Placement[] {
  const retained: Placement[] = [];
  let retainedUnits = 0;
  for (const block of context.futureExistingByTask.get(task.id) ?? []) {
    const units = (block.endMs - block.startMs) / GRID_MS;
    if (
      !Number.isInteger(units) ||
      units < bounds.minUnits ||
      units > bounds.maxUnits ||
      block.startMs < windowStartMs ||
      block.endMs > windowEndMs ||
      retainedUnits + units > requiredUnits ||
      !isRepresentable(requiredUnits - retainedUnits - units, bounds)
    ) {
      continue;
    }
    const slot = findContainingSlot(context, block.startMs, block.endMs);
    if (
      slot === undefined ||
      !passes(context, state, block.startMs, block.endMs)
    ) {
      continue;
    }
    const placement: Placement = {
      taskId: task.id,
      durationMin: units * GRID_MINUTES,
      startMs: block.startMs,
      endMs: block.endMs,
      slotId: slot.id,
      localHour: localHourOf(
        block.startMs,
        block.endMs,
        context.input.timeZone,
      ),
      seeded: true,
    };
    addPlacement(state, placement);
    retained.push(placement);
    retainedUnits += units;
  }
  return retained;
}

/** Maximal run of free grid cells `[firstCell, endCell)` of one slot. */
interface CellRange {
  slot: SlotInfo;
  firstCell: number;
  endCell: number;
}

/**
 * Free whole grid cells inside [windowStartMs, windowEndMs) in time order:
 * every slot minus the occupied intervals of `state`.
 */
function freeCellRanges(
  context: BuildContext,
  state: PlanState,
  windowStartMs: number,
  windowEndMs: number,
): CellRange[] {
  const busy: Array<{ startMs: number; endMs: number }> = [];
  for (const interval of state.intervals) {
    const last = busy[busy.length - 1];
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      busy.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }

  const ranges: CellRange[] = [];
  const pushRange = (slot: SlotInfo, fromMs: number, toMs: number) => {
    const firstCell = Math.max(
      0,
      Math.ceil((fromMs - slot.startMs) / GRID_MS),
    );
    const endCell = Math.min(
      slot.cellStarts.length,
      Math.floor((toMs - slot.startMs) / GRID_MS),
    );
    if (endCell > firstCell) {
      ranges.push({ slot, firstCell, endCell });
    }
  };
  for (const slot of context.slotsByStart) {
    const lowMs = Math.max(slot.startMs, windowStartMs);
    const highMs = Math.min(slot.endMs, windowEndMs);
    let freeFromMs = lowMs;
    for (const occupied of busy) {
      if (freeFromMs >= highMs || occupied.startMs >= highMs) {
        break;
      }
      if (occupied.endMs <= freeFromMs) {
        continue;
      }
      pushRange(slot, freeFromMs, occupied.startMs);
      freeFromMs = occupied.endMs;
    }
    pushRange(slot, freeFromMs, highMs);
  }
  return ranges;
}

/**
 * Most focus cells that `cellCount` consecutive free cells can hold under the
 * H6 continuous-focus rule alone: stretches of at most breakAfterMin separated
 * by breakMin. An upper bound (neighbouring focus only lowers it).
 */
function focusCellsWithBreaks(context: BuildContext, cellCount: number): number {
  if (cellCount <= 0) {
    return 0;
  }
  const stretchCells = Math.floor(context.breakAfterMs / GRID_MS);
  if (context.breakAfterMs <= 0 || stretchCells < 1) {
    return cellCount;
  }
  const cycleCells = stretchCells + Math.ceil(context.breakMs / GRID_MS);
  const cycles = Math.floor(cellCount / cycleCells);
  return (
    cycles * stretchCells +
    Math.min(cellCount - cycles * cycleCells, stretchCells)
  );
}

interface FocusStretch {
  startMs: number;
  endMs: number;
}

/** Occupied intervals merged while they are closer than breakMin (H6). */
function focusStretches(
  context: BuildContext,
  state: PlanState,
): FocusStretch[] {
  const stretches: FocusStretch[] = [];
  for (const interval of state.intervals) {
    const last = stretches[stretches.length - 1];
    if (
      last !== undefined &&
      interval.startMs - last.endMs < context.breakMs
    ) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      stretches.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  return stretches;
}

/**
 * Upper bound on the focus cells a free run can hold under H6 given the focus
 * stretches next to it. At either end the run's focus joins the neighbour
 * (then that stretch is limited by what the neighbour leaves of
 * breakAfterMin, and a break follows) or stays a break away from it (then
 * those cells are lost). Each end alone gives a valid bound; the smaller wins.
 */
function focusCellsInRun(
  context: BuildContext,
  stretches: FocusStretch[],
  startMs: number,
  cellCount: number,
): number {
  if (context.breakAfterMs <= 0) {
    return cellCount;
  }
  const endMs = startMs + cellCount * GRID_MS;
  let before: FocusStretch | undefined;
  let after: FocusStretch | undefined;
  for (const stretch of stretches) {
    if (stretch.endMs <= startMs) {
      before = stretch;
    } else if (stretch.startMs >= endMs) {
      after = stretch;
      break;
    }
  }
  const breakCells = Math.ceil(context.breakMs / GRID_MS);
  const besideNeighbour = (skipMs: number, joinedMs: number): number => {
    const joined = Math.min(cellCount, Math.floor(joinedMs / GRID_MS));
    return Math.max(
      focusCellsWithBreaks(context, cellCount - Math.ceil(skipMs / GRID_MS)),
      joined < 1
        ? 0
        : joined +
            focusCellsWithBreaks(context, cellCount - joined - breakCells),
    );
  };
  let bound = focusCellsWithBreaks(context, cellCount);
  if (before !== undefined && before.endMs + context.breakMs > startMs) {
    bound = Math.min(
      bound,
      besideNeighbour(
        before.endMs + context.breakMs - startMs,
        before.startMs + context.breakAfterMs - startMs,
      ),
    );
  }
  if (after !== undefined && after.startMs - context.breakMs < endMs) {
    bound = Math.min(
      bound,
      besideNeighbour(
        endMs - (after.startMs - context.breakMs),
        endMs - (after.endMs - context.breakAfterMs),
      ),
    );
  }
  return bound;
}

/**
 * Free runs for a gap-fitted split, in time order: the free cell ranges split
 * at local-date changes so the daily focus cap bounds each run on its own.
 * Runs that cannot host one minimum session are dropped.
 */
function freeRuns(
  context: BuildContext,
  state: PlanState,
  windowStartMs: number,
  windowEndMs: number,
  minUnits: number,
): FreeRun[] {
  const runs: FreeRun[] = [];
  const stretches = focusStretches(context, state);
  const pushRun = (slot: SlotInfo, firstCell: number, endCell: number) => {
    const cellCount = endCell - firstCell;
    const startMs = slot.cellStarts[firstCell];
    if (cellCount < minUnits || startMs === undefined) {
      return;
    }
    const date = slot.cellDates[firstCell] ?? '';
    const dayLoadMin = state.dailyLoad.get(date) ?? 0;
    // A cell may straddle local midnight by under one grid step when the slot
    // is not grid-aligned to it, so round the cap up to stay an upper bound.
    const usableCells = Math.min(
      focusCellsInRun(context, stretches, startMs, cellCount),
      Math.ceil((context.maxDailyFocusMin - dayLoadMin) / GRID_MINUTES),
    );
    if (usableCells < minUnits) {
      return;
    }
    runs.push({
      slot,
      firstCell,
      cellCount,
      startMs,
      usableCells,
      dayLoadMin,
    });
  };
  for (const range of freeCellRanges(
    context,
    state,
    windowStartMs,
    windowEndMs,
  )) {
    const { slot } = range;
    let runStart = range.firstCell;
    for (let cell = runStart + 1; cell <= range.endCell; cell += 1) {
      if (
        cell === range.endCell ||
        slot.cellDates[cell] !== slot.cellDates[runStart]
      ) {
        pushRun(slot, runStart, cell);
        runStart = cell;
      }
    }
  }
  return runs;
}

/**
 * Latest instant from which `needUnits` free cells are still usable before
 * `limitMs`: scanning the ranges backwards, a range counts only when the part
 * inside [fromMs, limitMs) holds one `pieceUnits` session (the whole need when
 * `contiguous`). Undefined when the need does not fit at all.
 */
function latestStartWithRoom(
  ranges: CellRange[],
  fromMs: number,
  limitMs: number,
  needUnits: number,
  pieceUnits: number,
  contiguous: boolean,
): number | undefined {
  let gathered = 0;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index];
    if (range === undefined) {
      continue;
    }
    const { slot } = range;
    const firstCell = Math.max(
      range.firstCell,
      Math.ceil((fromMs - slot.startMs) / GRID_MS),
    );
    const endCell = Math.min(
      range.endCell,
      Math.floor((limitMs - slot.startMs) / GRID_MS),
    );
    const length = endCell - firstCell;
    if (length < pieceUnits) {
      continue;
    }
    if (contiguous) {
      return slot.startMs + (endCell - needUnits) * GRID_MS;
    }
    if (gathered + length >= needUnits) {
      const take = Math.max(needUnits - gathered, pieceUnits);
      return slot.startMs + (endCell - take) * GRID_MS;
    }
    gathered += length;
  }
  return undefined;
}

/**
 * Latest end the task `ordered[taskIndex]` may have so that its dependents
 * can still be placed (FU-69): for every transitive dependent, the latest
 * instant from which its still-unplaced minutes fit into the free cells before
 * its own deadline and its own dependents' bounds, and the start of any block
 * it already has. Positive infinity when nothing constrains the task.
 *
 * With `slackMs` 0 this is a necessary condition for H3 + H7 only (it ignores
 * H6 and the room other tasks will take), so it never removes a position that
 * a valid greedy plan uses; a dependent that cannot be placed at all imposes
 * no bound. A positive `slackMs` keeps that much time free before each
 * dependent's room as well (the break H6 may demand after its dependency),
 * which is a heuristic and may be stricter than necessary.
 */
function successorBound(
  context: BuildContext,
  state: PlanState,
  ordered: Task[],
  taskIndex: number,
  slackMs: number,
): number {
  const task = ordered[taskIndex];
  const direct =
    task === undefined ? undefined : context.dependentsByTask.get(task.id);
  if (direct === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  const reachable = new Set<string>();
  const queue = [...direct];
  for (let head = 0; head < queue.length; head += 1) {
    const dependent = queue[head];
    if (dependent === undefined || reachable.has(dependent.id)) {
      continue;
    }
    reachable.add(dependent.id);
    queue.push(...(context.dependentsByTask.get(dependent.id) ?? []));
  }

  const placementStartMs = Math.max(context.horizonStartMs, context.nowMs);
  const ranges = freeCellRanges(
    context,
    state,
    placementStartMs,
    context.horizonEndMs,
  );
  const placedMinByTask = new Map<string, number>();
  const firstStartByTask = new Map<string, number>();
  const noteBlock = (taskId: string, startMs: number, minutes: number) => {
    placedMinByTask.set(taskId, (placedMinByTask.get(taskId) ?? 0) + minutes);
    const knownStartMs = firstStartByTask.get(taskId);
    firstStartByTask.set(
      taskId,
      knownStartMs === undefined ? startMs : Math.min(knownStartMs, startMs),
    );
  };
  for (const placement of state.placements) {
    noteBlock(placement.taskId, placement.startMs, placement.durationMin);
  }
  for (const interval of context.lockedIntervals) {
    noteBlock(
      interval.taskId,
      interval.startMs,
      (interval.endMs - interval.startMs) / MINUTE_MS,
    );
  }

  // `ordered` is topological, so walking it backwards visits every dependent
  // before the task it depends on.
  const latestStart = new Map<string, number>();
  for (let index = ordered.length - 1; index > taskIndex; index -= 1) {
    const dependent = ordered[index];
    if (dependent === undefined || !reachable.has(dependent.id)) {
      continue;
    }
    let limitMs = Math.min(
      context.horizonEndMs,
      (context.dueMsByTask.get(dependent.id) ?? Number.POSITIVE_INFINITY) -
        (context.bufferMsByTask.get(dependent.id) ?? 0),
    );
    for (const next of context.dependentsByTask.get(dependent.id) ?? []) {
      limitMs = Math.min(
        limitMs,
        latestStart.get(next.id) ?? Number.POSITIVE_INFINITY,
      );
    }
    let boundMs =
      firstStartByTask.get(dependent.id) ?? Number.POSITIVE_INFINITY;
    const needMin = Math.max(
      0,
      taskRequiredMinutes(dependent, context.riskLevel) -
        (placedMinByTask.get(dependent.id) ?? 0),
    );
    if (needMin > 0) {
      const needUnits = Math.ceil(needMin / GRID_MINUTES);
      const pieceUnits = dependent.splittable
        ? Math.min(
            needUnits,
            Math.max(1, Math.ceil(dependent.minSessionMin / GRID_MINUTES)),
          )
        : needUnits;
      const earliestMs =
        dependent.earliestStartAt === undefined
          ? placementStartMs
          : Math.max(placementStartMs, parseInstant(dependent.earliestStartAt));
      const roomMs = latestStartWithRoom(
        ranges,
        earliestMs,
        limitMs,
        needUnits,
        pieceUnits,
        !dependent.splittable,
      );
      if (roomMs !== undefined) {
        boundMs = Math.min(boundMs, roomMs - slackMs);
      }
    }
    latestStart.set(dependent.id, boundMs);
  }

  let boundMs = Number.POSITIVE_INFINITY;
  for (const dependent of direct) {
    boundMs = Math.min(
      boundMs,
      latestStart.get(dependent.id) ?? Number.POSITIVE_INFINITY,
    );
  }
  return boundMs;
}

/**
 * Policy order in which a gap-fitted split consumes free runs: earliest first
 * (front_loaded), longest first (focus_blocked), least-loaded day first
 * (balanced). `runs` is in time order, which also breaks ties.
 */
function orderFreeRuns(runs: FreeRun[], policy: PolicyName): FreeRun[] {
  if (policy === 'front_loaded') {
    return runs;
  }
  if (policy === 'focus_blocked') {
    return [...runs].sort(
      (a, b) => b.cellCount - a.cellCount || a.startMs - b.startMs,
    );
  }
  return [...runs].sort(
    (a, b) => a.dayLoadMin - b.dayLoadMin || a.startMs - b.startMs,
  );
}

/**
 * Cover exactly `units` grid cells with sessions inside the session bounds:
 * `searchRuns` over the free runs in policy order and, when that order is not
 * chronological and finds nothing, once more in time order. Only the
 * chronological search sees every session's preceding focus when it picks a
 * start, so only it can leave the H6 break after a session in an earlier gap.
 *
 * Work is bounded and deterministic: at most two `searchRuns` calls of
 * `GAP_FIT_BUDGET` evaluations each. Successful sessions stay in `state`; a
 * failed search leaves it unchanged and returns undefined.
 */
function searchGapSessions(
  context: BuildContext,
  state: PlanState,
  policy: PolicyName,
  task: Task,
  units: number,
  bounds: SessionBounds,
  windowStartMs: number,
  windowEndMs: number,
): Placement[] | undefined {
  if (units === 0) {
    return [];
  }
  const chronological = freeRuns(
    context,
    state,
    windowStartMs,
    windowEndMs,
    bounds.minUnits,
  );
  const preferred = orderFreeRuns(chronological, policy);
  const found = searchRuns(context, state, task, units, bounds, preferred);
  if (
    found !== undefined ||
    preferred.every((run, index) => run === chronological[index])
  ) {
    return found;
  }
  return searchRuns(context, state, task, units, bounds, chronological);
}

/**
 * Depth-first search for sessions that cover exactly `units` cells, visiting
 * `runs` in the given order and filling each run left to right. For the next
 * session in a run H6 makes three starts distinct (`startOffsets`); every
 * passing (start, length) whose remainder is still representable is tried,
 * longest session first. Every session is checked with `passes` against the
 * live state, so H1/H6 hold by construction.
 *
 * `GAP_FIT_BUDGET` evaluations (`passes` checks plus trial placements) bound
 * the work and the recursion depth; an exhausted budget is a failed search.
 */
function searchRuns(
  context: BuildContext,
  state: PlanState,
  task: Task,
  units: number,
  bounds: SessionBounds,
  runs: FreeRun[],
): Placement[] | undefined {
  // usableAfter[k]: upper bound on the cells runs k.. can still host.
  const usableAfter: number[] = new Array<number>(runs.length + 1).fill(0);
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    usableAfter[index] =
      (usableAfter[index + 1] ?? 0) + (runs[index]?.usableCells ?? 0);
  }
  if (units > (usableAfter[0] ?? 0)) {
    return undefined;
  }

  let budget = GAP_FIT_BUDGET;
  const sessions: Placement[] = [];

  const fits = (run: FreeRun, offset: number, length: number): boolean => {
    if (budget <= 0) {
      return false;
    }
    budget -= 1;
    const startMs = run.startMs + offset * GRID_MS;
    return passes(context, state, startMs, startMs + length * GRID_MS);
  };
  // `passes` is monotone in the session length for a fixed start (a shorter
  // block overlaps less, loads less and joins no longer run), so the longest
  // passing length is found by bisection.
  const longestFitting = (
    run: FreeRun,
    offset: number,
    cap: number,
  ): number => {
    if (cap < bounds.minUnits || !fits(run, offset, bounds.minUnits)) {
      return 0;
    }
    let low = bounds.minUnits;
    let high = cap;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(run, offset, middle)) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return low;
  };

  const search = (
    index: number,
    offset: number,
    remaining: number,
  ): boolean => {
    if (remaining === 0) {
      return true;
    }
    for (let k = index; k < runs.length; k += 1) {
      const run = runs[k];
      if (run === undefined) {
        continue;
      }
      const from = k === index ? offset : 0;
      const leftCells = run.cellCount - from;
      const usableHere =
        leftCells < bounds.minUnits ? 0 : Math.min(run.usableCells, leftCells);
      if (remaining > usableHere + (usableAfter[k + 1] ?? 0)) {
        return false;
      }
      if (usableHere === 0) {
        continue;
      }
      const starts = startOffsets(context, state, run, from);
      const longest = starts.map((start) =>
        longestFitting(
          run,
          start,
          Math.min(bounds.maxUnits, remaining, run.cellCount - start),
        ),
      );
      // Longest session first across the starts (earliest start on ties): a
      // start that only admits short sessions is then tried last instead of
      // draining the budget before the next start is reached.
      for (
        let length = Math.max(...longest);
        length >= bounds.minUnits;
        length -= 1
      ) {
        if (!isRepresentable(remaining - length, bounds)) {
          continue;
        }
        for (let choice = 0; choice < starts.length; choice += 1) {
          const start = starts[choice];
          if (start === undefined || length > (longest[choice] ?? 0)) {
            continue;
          }
          if (budget <= 0) {
            return false;
          }
          budget -= 1;
          const startMs = run.startMs + start * GRID_MS;
          const endMs = startMs + length * GRID_MS;
          const placement: Placement = {
            taskId: task.id,
            durationMin: length * GRID_MINUTES,
            startMs,
            endMs,
            slotId: run.slot.id,
            localHour: localHourOf(startMs, endMs, context.input.timeZone),
            seeded: false,
          };
          addPlacement(state, placement);
          sessions.push(placement);
          if (search(k, start + length, remaining - length)) {
            return true;
          }
          sessions.pop();
          removePlacement(state, placement);
        }
      }
    }
    return false;
  };

  return search(0, 0, units) ? sessions : undefined;
}

/**
 * Start offsets worth trying for the next session of a run whose cells from
 * `from` on are free. With P the focus run that ends before `from` and S the
 * one that starts after the run, a session joins P when it starts within
 * breakMin of it and joins S when it ends within breakMin of it, and the
 * joined stretch may not exceed breakAfterMin (H6). That makes three starts
 * distinct, each the earliest of its class (an earlier start admits every
 * length a later start of the same class does and leaves more room):
 *   1. `from`: joins P when P is that close;
 *   2. the first cell a full break after P: joins nothing before it;
 *   3. the first cell from which a session may run into S, that is no earlier
 *      than S's end minus breakAfterMin: a session starting between 2 and 3
 *      has to stop a break short of S.
 * H1 holds on free cells and the daily cap does not depend on the start, so
 * `passes` covers the rest.
 */
function startOffsets(
  context: BuildContext,
  state: PlanState,
  run: FreeRun,
  from: number,
): number[] {
  const starts = [from];
  if (context.breakAfterMs <= 0) {
    return starts;
  }
  const fromMs = run.startMs + from * GRID_MS;
  const runEndMs = run.startMs + run.cellCount * GRID_MS;
  let beforeEndMs = Number.NEGATIVE_INFINITY;
  let afterStartMs = Number.POSITIVE_INFINITY;
  let afterEndMs = Number.NEGATIVE_INFINITY;
  for (const interval of state.intervals) {
    if (interval.endMs <= fromMs) {
      beforeEndMs = Math.max(beforeEndMs, interval.endMs);
    } else if (interval.startMs >= runEndMs) {
      if (afterStartMs === Number.POSITIVE_INFINITY) {
        afterStartMs = interval.startMs;
      } else if (interval.startMs - afterEndMs >= context.breakMs) {
        break;
      }
      afterEndMs = Math.max(afterEndMs, interval.endMs);
    }
  }

  const offsetOf = (epochMs: number): number =>
    Math.ceil((epochMs - run.startMs) / GRID_MS);
  let detached = from;
  if (beforeEndMs + context.breakMs > fromMs) {
    detached = offsetOf(beforeEndMs + context.breakMs);
    starts.push(detached);
  }
  if (afterStartMs - runEndMs < context.breakMs) {
    const anchored = offsetOf(afterEndMs - context.breakAfterMs);
    if (anchored > detached) {
      starts.push(anchored);
    }
  }
  return starts;
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

  // Occupied intervals may nest or overlap (legitimate history under 06 §7.1),
  // so a backward scan cannot stop at the first gap: an earlier interval can
  // extend past the nearest one. Grow the run union until no interval joins
  // within breakMin on either side.
  let runStart = startMs;
  let runEnd = endMs;
  let changed = true;
  while (changed) {
    changed = false;
    for (const interval of intervals) {
      const joins =
        interval.endMs <= runStart
          ? runStart - interval.endMs < context.breakMs
          : interval.startMs >= runEnd
            ? interval.startMs - runEnd < context.breakMs
            : interval.startMs < runEnd && interval.endMs > runStart;
      if (!joins) {
        continue;
      }
      const nextStart = Math.min(runStart, interval.startMs);
      const nextEnd = Math.max(runEnd, interval.endMs);
      if (nextStart !== runStart || nextEnd !== runEnd) {
        runStart = nextStart;
        runEnd = nextEnd;
        changed = true;
      }
    }
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
        localHour: localHourOf(
          position.startMs,
          position.endMs,
          context.input.timeZone,
        ),
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

  let preferredTotal = 0;
  let preferredFit = 0;
  for (const placement of state.placements) {
    const task = context.taskById.get(placement.taskId);
    const windows = task?.preferredWindows ?? [];
    if (windows.length === 0) {
      continue;
    }
    preferredTotal += placement.durationMin;
    if (matchesPreferredWindow(placement, windows)) {
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
): boolean {
  const hour = placement.localHour;
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
    const dueMs = context.dueMsByTask.get(task.id);
    if (dueMs === undefined) {
      continue;
    }
    sawDeadline = true;
    const lastEnd =
      lastEndByTask.get(task.id) ?? context.horizonStartMs;
    const slack =
      (dueMs - (context.bufferMsByTask.get(task.id) ?? 0) - lastEnd) /
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
  replan: Pick<ReplanPlan, 'movableExisting'>,
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

  // H7, deficitMin and p90CoverageRatio cover the live plan only: candidate
  // placements plus locked blocks. Past/in-progress history occupies time for
  // H1/H6 but must not be credited as placed work (06 §7.1).
  const placedByTask = new Map<string, number>();
  for (const placement of state.placements) {
    placedByTask.set(
      placement.taskId,
      (placedByTask.get(placement.taskId) ?? 0) + placement.durationMin,
    );
  }
  for (const interval of context.lockedIntervals) {
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
      diversityNoteItems: [
        {
          code: 'diversity_dropped',
          params: { kept: kept.length, total: candidates.length, dropped },
        },
      ],
    };
  }
  if (candidates.length > 1) {
    return {
      candidates: kept,
      diversityNote: `${kept.length} distinct plans from ${candidates.length} policy candidates (pairwise distance >= 0.15).`,
      diversityNoteItems: [
        { code: 'diversity_distinct', params: { total: candidates.length } },
      ],
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
