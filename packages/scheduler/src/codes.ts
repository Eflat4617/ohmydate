import type { Id, Instant, PolicyName } from './types.js';

/**
 * Stable explanation and violation codes (FU-62, 06 §6.1).
 *
 * Every explanation line the generator writes and every violation message the
 * validator writes carries one of these closed codes plus typed parameters,
 * so a client can render its own language instead of the English text. The
 * English `explanation[]` / `message` strings are kept unchanged for logs and
 * compatibility; the codes are the contract.
 *
 * Parameter values are only numbers (minutes, counts, limits) or opaque
 * tokens: task IDs, UTC ISO instants, civil `YYYY-MM-DD` dates and closed enum
 * values (policy names, preference field names). They never carry task titles,
 * note text or other user-written strings; clients resolve names from IDs.
 */

/** A number, or an opaque ID / ISO instant / civil date / enum token. */
export type ExplanationParamValue = string | number;

type NoParams = Record<string, never>;
type TaskParams = { taskId: Id };
type TaskBlockParams = { taskId: Id; startAt: Instant; endAt: Instant };
type MaxMinuteParams = { taskId: Id; maxMin: number };

/** Preference fields `validateInput` checks as whole minutes. */
export type PreferenceMinuteField = 'maxDailyFocusMin' | 'breakAfterMin' | 'breakMin';

/**
 * Validator findings (`validate()`), one code per message template. The H-kind
 * (`Violation.code`) is the prefix: `h1_*` codes are H1 findings, and so on.
 */
export interface ViolationParamMap {
  h0_unknown_task: TaskParams;
  h0_outside_horizon: TaskBlockParams;
  h1_same_task_overlap: TaskParams;
  h1_tasks_overlap: { taskId: Id; otherTaskId: Id };
  h1_commitment_overlap: TaskBlockParams;
  h2_outside_availability: TaskBlockParams;
  h3_dependency_order: { taskId: Id; dependencyId: Id };
  h4_before_earliest_start: { taskId: Id; earliestStartAt: Instant };
  h4_inside_due_buffer: { taskId: Id; dueAt: Instant; bufferMin: number };
  h4_after_due: { taskId: Id; dueAt: Instant };
  h5_unsplittable_no_remaining: TaskParams;
  h5_unsplittable_required_out_of_bounds: {
    taskId: Id;
    requiredMin: number;
    minSessionMin: number;
    maxSessionMin: number;
  };
  h5_unsplittable_single_block: { taskId: Id; requiredMin: number };
  h5_session_out_of_bounds: {
    taskId: Id;
    durationMin: number;
    minSessionMin: number;
    maxSessionMin: number;
    startAt: Instant;
    endAt: Instant;
  };
  h6_daily_focus_exceeded: { date: string; totalMin: number; maxDailyFocusMin: number };
  h6_break_missing: { date: string; breakAfterMin: number; breakMin: number };
  h7_deficit: { taskId: Id; shortMin: number };
  h7_overallocated: { taskId: Id; excessMin: number };
  h8_invalid_time_zone: NoParams;
  h8_invalid_horizon: NoParams;
  h8_invalid_instant: TaskParams;
  h8_sub_millisecond: TaskParams;
  h8_off_grid: TaskParams;
  h8_end_before_start: TaskParams;
}

/** `validateInput()` issues, one code per message template. */
export interface InputIssueParamMap {
  input_invalid_time_zone: NoParams;
  input_invalid_horizon_instant: NoParams;
  input_horizon_not_increasing: NoParams;
  input_horizon_too_long: { maxDays: number };
  input_invalid_now: NoParams;
  input_duplicate_task: TaskParams;
  input_invalid_estimate: MaxMinuteParams;
  input_invalid_buffer: MaxMinuteParams;
  input_invalid_session_minutes: MaxMinuteParams;
  input_invalid_session_bounds: TaskParams;
  input_invalid_task_window_instant: TaskParams;
  input_task_window_empty: TaskParams;
  input_invalid_preference: { field: PreferenceMinuteField; maxMin: number };
  input_unknown_dependency: { taskId: Id; dependencyId: Id };
  input_dependency_cycle: NoParams;
  input_invalid_weekday: NoParams;
  input_invalid_availability_window: { weekday: number };
  input_invalid_exception_date: NoParams;
  input_exception_partial_window: NoParams;
  input_invalid_exception_window: NoParams;
  input_commitment_invalid_instant: NoParams;
  input_commitment_end_before_start: NoParams;
  input_commitment_too_long: { maxDays: number };
  input_unknown_block_task: TaskParams;
  input_invalid_block_instant: TaskParams;
  input_block_sub_millisecond: TaskParams;
  input_block_off_grid: TaskParams;
  input_block_end_before_start: TaskParams;
  input_block_too_long: { taskId: Id; maxDays: number };
}

/** Generator lines that are not a violation or an input issue. */
export interface GeneratorParamMap {
  policy_summary: { policy: PolicyName; policyVersion: string };
  placement_summary: {
    placedMin: number;
    requiredMin: number;
    blockCount: number;
    retainedCount: number;
  };
  constraints_satisfied: NoParams;
  infeasible_summary: { violationCount: number };
  heuristic_insufficient_available_time: NoParams;
  heuristic_no_contiguous_window: NoParams;
  heuristic_estimate_not_grid_aligned: NoParams;
  heuristic_estimate_below_grid: NoParams;
  heuristic_session_bounds_infeasible: NoParams;
  unplaced_minutes: { deficitMin: number };
  capacity_deficit: { capacityDeficitMin: number };
  replan_bound_exceeded: {
    changedBlocks: number;
    bound: number;
    affectedExistingBlocks: number;
  };
  input_rejected: { issueCount: number };
}

export type ExplanationParamMap = GeneratorParamMap & InputIssueParamMap & ViolationParamMap;

export type ViolationMessageCode = keyof ViolationParamMap;
export type InputIssueMessageCode = keyof InputIssueParamMap;
export type GeneratorExplanationCode = keyof GeneratorParamMap;
export type ExplanationCode = keyof ExplanationParamMap;

/**
 * Diversity-note sentences (FU-68). `diversityNote` stays the English text;
 * `diversityNoteItems` codes each sentence. The replan change-bound sentence
 * appended to a note reuses the generator's `replan_bound_exceeded` params.
 */
export interface DiversityNoteParamMap {
  diversity_dropped: { kept: number; total: number; dropped: number };
  diversity_distinct: { total: number };
  replan_bound_exceeded: GeneratorParamMap['replan_bound_exceeded'];
}

export type DiversityNoteCode = keyof DiversityNoteParamMap;
export type DiversityNoteItem = CodedItem<DiversityNoteParamMap>;

/** `{ code, params }` with the parameter shape of that code. */
export type CodedItem<M> = { [C in keyof M]: { code: C; params: M[C] } }[keyof M];

/** One explanation line as a code; an unknown code is a type error. */
export type ExplanationItem = CodedItem<ExplanationParamMap>;

/** `{ messageCode, params }` fields shared by violations and input issues. */
export type MessageCodeFields<M> = {
  [C in keyof M]: { messageCode: C; params: M[C] };
}[keyof M];

const GENERATOR_CODE_SET: Record<GeneratorExplanationCode, true> = {
  policy_summary: true,
  placement_summary: true,
  constraints_satisfied: true,
  infeasible_summary: true,
  heuristic_insufficient_available_time: true,
  heuristic_no_contiguous_window: true,
  heuristic_estimate_not_grid_aligned: true,
  heuristic_estimate_below_grid: true,
  heuristic_session_bounds_infeasible: true,
  unplaced_minutes: true,
  capacity_deficit: true,
  replan_bound_exceeded: true,
  input_rejected: true,
};

const INPUT_ISSUE_CODE_SET: Record<InputIssueMessageCode, true> = {
  input_invalid_time_zone: true,
  input_invalid_horizon_instant: true,
  input_horizon_not_increasing: true,
  input_horizon_too_long: true,
  input_invalid_now: true,
  input_duplicate_task: true,
  input_invalid_estimate: true,
  input_invalid_buffer: true,
  input_invalid_session_minutes: true,
  input_invalid_session_bounds: true,
  input_invalid_task_window_instant: true,
  input_task_window_empty: true,
  input_invalid_preference: true,
  input_unknown_dependency: true,
  input_dependency_cycle: true,
  input_invalid_weekday: true,
  input_invalid_availability_window: true,
  input_invalid_exception_date: true,
  input_exception_partial_window: true,
  input_invalid_exception_window: true,
  input_commitment_invalid_instant: true,
  input_commitment_end_before_start: true,
  input_commitment_too_long: true,
  input_unknown_block_task: true,
  input_invalid_block_instant: true,
  input_block_sub_millisecond: true,
  input_block_off_grid: true,
  input_block_end_before_start: true,
  input_block_too_long: true,
};

const VIOLATION_CODE_SET: Record<ViolationMessageCode, true> = {
  h0_unknown_task: true,
  h0_outside_horizon: true,
  h1_same_task_overlap: true,
  h1_tasks_overlap: true,
  h1_commitment_overlap: true,
  h2_outside_availability: true,
  h3_dependency_order: true,
  h4_before_earliest_start: true,
  h4_inside_due_buffer: true,
  h4_after_due: true,
  h5_unsplittable_no_remaining: true,
  h5_unsplittable_required_out_of_bounds: true,
  h5_unsplittable_single_block: true,
  h5_session_out_of_bounds: true,
  h6_daily_focus_exceeded: true,
  h6_break_missing: true,
  h7_deficit: true,
  h7_overallocated: true,
  h8_invalid_time_zone: true,
  h8_invalid_horizon: true,
  h8_invalid_instant: true,
  h8_sub_millisecond: true,
  h8_off_grid: true,
  h8_end_before_start: true,
};

/** Every validator message code (closed; mirrored by `@ohmydate/contracts`). */
export const VIOLATION_MESSAGE_CODES = Object.freeze(
  Object.keys(VIOLATION_CODE_SET) as ViolationMessageCode[],
);

/** Every `validateInput()` issue message code. */
export const INPUT_ISSUE_MESSAGE_CODES = Object.freeze(
  Object.keys(INPUT_ISSUE_CODE_SET) as InputIssueMessageCode[],
);

/** Every explanation code, in contract order: generator, input issues, violations. */
export const EXPLANATION_CODES = Object.freeze([
  ...(Object.keys(GENERATOR_CODE_SET) as GeneratorExplanationCode[]),
  ...INPUT_ISSUE_MESSAGE_CODES,
  ...VIOLATION_MESSAGE_CODES,
] as ExplanationCode[]);

/** Every diversity-note code in contract order. */
export const DIVERSITY_NOTE_CODES = Object.freeze([
  'diversity_dropped',
  'diversity_distinct',
  'replan_bound_exceeded',
] as DiversityNoteCode[]);

/** The coded item for a violation or input issue (same code and params). */
export function itemFromMessage(
  message: MessageCodeFields<ViolationParamMap> | MessageCodeFields<InputIssueParamMap>,
): ExplanationItem {
  // The mapped unions correlate `messageCode` with `params` per member; TS
  // cannot carry that correlation through a property rename, hence the cast.
  return { code: message.messageCode, params: message.params } as ExplanationItem;
}
