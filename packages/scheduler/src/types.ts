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
  remainingMin?: number;
  splittable: boolean;
  minSessionMin: number;
  maxSessionMin: number;
  priority: 1 | 2 | 3 | 4;
  dependsOn: Id[];
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
