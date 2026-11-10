/**
 * Public scheduler types.
 *
 * Wall-clock fields use one canonical IANA time zone per `ScheduleInput`.
 * Instants are ISO-8601 UTC strings (a `Z` suffix is not required by the
 * parser, but every interval returned by this package is emitted as UTC).
 */

export type Id = string;
export type Instant = string;
export type IanaTz = string;

/** ISO-8601 weekday: Monday = 1 ... Sunday = 7. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type WindowKind = 'morning' | 'afternoon' | 'evening';
export type RiskLevel = 'p50' | 'p90';
export type AvailabilityKind = 'work' | 'focus';
export type ExceptionKind = 'off' | 'extra';

export interface TaskEstimate {
  p50Min: number;
  p90Min: number;
}

export interface Task {
  id: Id;
  dueAt?: Instant;
  earliestStartAt?: Instant;
  estimate: TaskEstimate;
  /**
   * Minutes still needed going forward. When supplied it is authoritative and
   * does not include past/in-progress history blocks (06 §7.1).
   *
   * A block that started before `now` counts entirely as history, including
   * the part after `now`: callers send `remainingMin = required - history
   * minutes`, which is 0 for an in-progress non-splittable task. Omitting
   * `remainingMin` instead re-schedules the full estimate, because history is
   * not credited automatically.
   */
  remainingMin?: number;
  splittable: boolean;
  minSessionMin: number;
  maxSessionMin: number;
  priority: 1 | 2 | 3 | 4;
  dependsOn: Id[];
  /**
   * Minutes reserved before `dueAt`. Must be a whole number in
   * `[0, 100000]` like every other minute field; invalid values are rejected
   * before scheduling rather than bypassing the deadline.
   */
  bufferBeforeDueMin?: number;
  preferredWindows?: WindowKind[];
}

export interface AvailabilityRule {
  weekday: Weekday;
  /**
   * Local wall clock, `HH:mm`. Must be earlier than `endLocal`.
   * Single-rule overnight windows are not supported; split them at midnight
   * (23:00-01:00 => 23:00-24:00 on this weekday plus 00:00-01:00 on the next).
   */
  startLocal: string;
  /** Local wall clock, `HH:mm`; `24:00` means the following midnight. */
  endLocal: string;
  kind: AvailabilityKind;
}

export interface ExceptionRule {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  kind: ExceptionKind;
  startLocal?: string;
  endLocal?: string;
}

export interface Commitment {
  start: Instant;
  end: Instant;
}

export interface Block {
  taskId: Id;
  start: Instant;
  end: Instant;
}

export interface Preferences {
  maxDailyFocusMin: number;
  breakAfterMin: number;
  breakMin: number;
  riskLevel: RiskLevel;
  dayStartLocal: string;
  dayEndLocal: string;
}

export interface Horizon {
  start: Instant;
  /**
   * End of the planning horizon. The supported span is at most 366 days;
   * longer horizons (and occupied blocks longer than 366 days) are rejected as
   * `invalid_input` before transition enumeration or cell allocation.
   */
  end: Instant;
}

export interface ScheduleInput {
  now: Instant;
  timeZone: IanaTz;
  horizon: Horizon;
  tasks: Task[];
  availability: AvailabilityRule[];
  exceptions: ExceptionRule[];
  commitments: Commitment[];
  lockedBlocks: Block[];
  /**
   * Previous plan blocks. Entries whose start is before `now` are history:
   * they occupy time for H1/H6, but history-only collisions are exempt from
   * H1 and history-only days/runs are exempt from H6 (06 §7.1). They are not
   * audited for H2/H4/H5 and do not reduce `remainingMin`.
   */
  existingBlocks?: Block[];
  prefs: Preferences;
  seed: number;
}

/** A merged UTC interval on the scheduler's 5-minute grid. */
export interface Slot {
  start: Instant;
  end: Instant;
}

/**
 * Hard constraints H1-H8 plus H0 preconditions.
 *
 * `H0_horizon` rejects candidate blocks outside `ScheduleInput.horizon`.
 * `lockedBlocks` are explicitly exempt from this horizon check so historical
 * approved work can remain in the input; they are still audited by H1-H8.
 * `H0_unknown_task` rejects candidate and locked blocks whose taskId is not
 * present in `ScheduleInput.tasks`; such blocks have no task constraints.
 */
export type ViolationCode =
  | 'H0_horizon'
  | 'H0_unknown_task'
  | 'H1'
  | 'H2'
  | 'H3'
  | 'H4'
  | 'H5'
  | 'H6'
  | 'H7'
  | 'H8';

export interface Violation {
  code: ViolationCode;
  message: string;
  taskId?: Id;
  blocks?: Block[];
}

export interface ValidateOptions {
  riskLevel: RiskLevel;
  /**
   * Past/in-progress history blocks: audited for H1 only against candidate
   * blocks, and counted for H6 only on days/runs that contain an audited
   * minute. History-vs-history, history-vs-commitment and history-vs-locked
   * collisions are exempt, as are history-only days/runs; history is also
   * exempt from H2, H4, H5 and H7 (06 §7.1).
   */
  historyBlocks?: Block[];
}

export interface InputIssue {
  code: string;
  message: string;
  taskId?: Id;
}

export interface TaskDeficit {
  taskId: Id;
  requiredMin: number;
  availableBeforeDueMin: number;
  deficitMin: number;
}

export interface DeficitReport {
  riskLevel: RiskLevel;
  tasks: TaskDeficit[];
  total: {
    requiredMin: number;
    availableBeforeDueMin: number;
    deficitMin: number;
  };
}

/** Published generator policy names (06 §4). */
export type PolicyName = 'front_loaded' | 'balanced' | 'focus_blocked';

/**
 * Deterministic metrics for one generated candidate (06 §6).
 *
 * Daily loads use the ADR-017 local-date semantics, including locked blocks.
 * `minSlackMin` is the smallest due-buffer slack in the final plan; when no
 * task has a deadline it falls back to the horizon end minus the last block.
 * `p90CoverageRatio` compares each task's placed minutes with its effective
 * requirement (`remainingMin` when supplied, else P90), capped per task.
 * `changedBlocks` is the symmetric difference between the returned (movable)
 * blocks and the non-fixed `ScheduleInput.existingBlocks`; locked and
 * past/in-progress fixed blocks are excluded. `deficitMin` is the candidate's
 * own H7 shortfall, while `capacityDeficitMin` is the pre-generation capacity
 * upper bound from `deficit()`.
 *
 * When every attempt is infeasible, the generator picks the attempt with the
 * smallest `deficitMin`, then the fewest violations, then the most retained
 * seeds, so a partial plan still favours placed work before plan continuity.
 */
export interface PlanMetrics {
  totalFocusMin: number;
  minSlackMin: number;
  maxDailyLoadMin: number;
  avgDailyLoadMin: number;
  contextSwitches: number;
  changedBlocks: number;
  deficitMin: number;
  capacityDeficitMin: number;
  p90CoverageRatio: number;
}

export interface PlanCandidate {
  policy: PolicyName;
  /**
   * Movable/seeded blocks only. `ScheduleInput.lockedBlocks` are audited
   * separately; existing blocks whose start is before `now` are history
   * (06 §7.1), so neither kind is repeated here. Re-validate with
   * `ValidateOptions.historyBlocks` for the full-plan H1/H6 audit.
   */
  blocks: Block[];
  metrics: PlanMetrics;
  feasible: boolean;
  /**
   * This candidate's own H7 shortfall in minutes (unplaced work). When every
   * attempt is infeasible the smallest shortfall wins before violation count
   * and retained seeds.
   */
  deficitMin: number;
  /** Capacity upper bound from `deficit()` before generation. */
  capacityDeficitMin: number;
  explanation: string[];
  /**
   * SHA-256 of canonical JSON covering the effective seed and
   * `maxLocalImprovement`, with all instants canonicalised to UTC ISO strings.
   */
  inputHash: string;
  generatorVersion: string;
}

export interface GenerateOptions {
  policies?: PolicyName[];
  /** Overrides `ScheduleInput.seed` when supplied. */
  seed?: number;
  /** Local-improvement evaluation cap; defaults to 200 (06 §4). */
  maxLocalImprovement?: number;
}

export interface GenerateResult {
  candidates: PlanCandidate[];
  diversityNote?: string;
}
