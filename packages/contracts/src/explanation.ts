import { Type, type Static, type TLiteral } from '@sinclair/typebox';

/**
 * Stable explanation and violation codes (FU-62, 06 §6.1).
 *
 * The scheduler's English `explanation[]` lines and violation `message`s are
 * kept for logs and compatibility; clients render the closed codes below in
 * their own language. The lists mirror `@ohmydate/scheduler` (parity is
 * tested) plus the API-only `h1_active_block_overlap`, which the API reports
 * when the storage-level overlap guard rejects an approval race.
 */

/** Validator findings: one code per message template, prefixed by the H-kind. */
export const VIOLATION_MESSAGE_CODES = [
  'h0_unknown_task',
  'h0_outside_horizon',
  'h1_same_task_overlap',
  'h1_tasks_overlap',
  'h1_commitment_overlap',
  'h1_active_block_overlap',
  'h2_outside_availability',
  'h3_dependency_order',
  'h4_before_earliest_start',
  'h4_inside_due_buffer',
  'h4_after_due',
  'h5_unsplittable_no_remaining',
  'h5_unsplittable_required_out_of_bounds',
  'h5_unsplittable_single_block',
  'h5_session_out_of_bounds',
  'h6_daily_focus_exceeded',
  'h6_break_missing',
  'h7_deficit',
  'h7_overallocated',
  'h8_invalid_time_zone',
  'h8_invalid_horizon',
  'h8_invalid_instant',
  'h8_sub_millisecond',
  'h8_off_grid',
  'h8_end_before_start',
] as const;

/** Codes the API itself emits; they are not produced by the scheduler. */
export const API_VIOLATION_MESSAGE_CODES = ['h1_active_block_overlap'] as const;

/** Scheduler input issues shown in explanations of rejected-input candidates. */
export const INPUT_ISSUE_MESSAGE_CODES = [
  'input_invalid_time_zone',
  'input_invalid_horizon_instant',
  'input_horizon_not_increasing',
  'input_horizon_too_long',
  'input_invalid_now',
  'input_duplicate_task',
  'input_invalid_estimate',
  'input_invalid_buffer',
  'input_invalid_session_minutes',
  'input_invalid_session_bounds',
  'input_invalid_task_window_instant',
  'input_task_window_empty',
  'input_invalid_preference',
  'input_unknown_dependency',
  'input_dependency_cycle',
  'input_invalid_weekday',
  'input_invalid_availability_window',
  'input_invalid_exception_date',
  'input_exception_partial_window',
  'input_invalid_exception_window',
  'input_commitment_invalid_instant',
  'input_commitment_end_before_start',
  'input_commitment_too_long',
  'input_unknown_block_task',
  'input_invalid_block_instant',
  'input_block_sub_millisecond',
  'input_block_off_grid',
  'input_block_end_before_start',
  'input_block_too_long',
] as const;

/** Generator lines that are neither a violation nor an input issue. */
export const GENERATOR_EXPLANATION_CODES = [
  'policy_summary',
  'placement_summary',
  'constraints_satisfied',
  'infeasible_summary',
  'heuristic_insufficient_available_time',
  'heuristic_no_contiguous_window',
  'heuristic_estimate_not_grid_aligned',
  'heuristic_estimate_below_grid',
  'heuristic_session_bounds_infeasible',
  'unplaced_minutes',
  'capacity_deficit',
  'replan_bound_exceeded',
  'input_rejected',
] as const;

/** Every explanation item code (closed enum). */
export const EXPLANATION_CODES = [
  ...GENERATOR_EXPLANATION_CODES,
  ...INPUT_ISSUE_MESSAGE_CODES,
  ...VIOLATION_MESSAGE_CODES,
] as const;

export type ViolationMessageCode = (typeof VIOLATION_MESSAGE_CODES)[number];
export type ExplanationCode = (typeof EXPLANATION_CODES)[number];

export const ViolationMessageCodeSchema = Type.Union(
  VIOLATION_MESSAGE_CODES.map((code) => Type.Literal(code)) as TLiteral<ViolationMessageCode>[],
);

export const ExplanationCodeSchema = Type.Union(
  EXPLANATION_CODES.map((code) => Type.Literal(code)) as TLiteral<ExplanationCode>[],
);

/**
 * Opaque parameter token: task IDs, UTC ISO instants, civil `YYYY-MM-DD`
 * dates and closed enum values. Spaces, quotes and non-ASCII letters are
 * rejected, so a task title or note can never travel as a parameter.
 */
export const EXPLANATION_PARAM_TOKEN_PATTERN = '^[A-Za-z0-9_.:+-]{1,100}$';

/**
 * Parameters of one coded item: numbers (minutes, counts, limits) or opaque
 * tokens. Names are camelCase; each code documents its own names in 06 §6.1.
 */
export const ExplanationParamsSchema = Type.Record(
  Type.String({ pattern: '^[a-z][A-Za-z0-9]{0,39}$' }),
  Type.Union([
    Type.String({ minLength: 1, maxLength: 100, pattern: EXPLANATION_PARAM_TOKEN_PATTERN }),
    Type.Number(),
  ]),
  { additionalProperties: false, maxProperties: 12 },
);

/** One renderable explanation line: `explanationItems[i]` codes `explanation[i]`. */
export const ExplanationItemSchema = Type.Object(
  {
    code: ExplanationCodeSchema,
    params: ExplanationParamsSchema,
  },
  { additionalProperties: false, $id: 'ExplanationItem' },
);

/**
 * Coded form of an `explanation[]` array. Optional on the wire for backward
 * compatibility; the API always sends it and sends `[]` for rows persisted
 * before FU-62, in which case clients fall back to the English lines.
 */
export const ExplanationItemsSchema = Type.Array(ExplanationItemSchema, { maxItems: 50 });

export type ExplanationParams = Static<typeof ExplanationParamsSchema>;
export type ExplanationItem = Static<typeof ExplanationItemSchema>;

/**
 * Diversity-note codes (FU-68). `diversityNote` stays the English fallback for
 * logs and legacy rows; `diversityNoteItems` is the closed coded form. The
 * replan-bound sentence appended to a note reuses the generator code
 * `replan_bound_exceeded`, so it appears in both arrays with the same params.
 */
export const DIVERSITY_NOTE_CODES = [
  'diversity_dropped',
  'diversity_distinct',
  'replan_bound_exceeded',
] as const;

export type DiversityNoteCode = (typeof DIVERSITY_NOTE_CODES)[number];

export const DiversityNoteCodeSchema = Type.Union(
  DIVERSITY_NOTE_CODES.map((code) => Type.Literal(code)) as TLiteral<DiversityNoteCode>[],
);

/** One renderable diversity-note sentence: `{ code, params }`. */
export const DiversityNoteItemSchema = Type.Object(
  {
    code: DiversityNoteCodeSchema,
    params: ExplanationParamsSchema,
  },
  { additionalProperties: false, $id: 'DiversityNoteItem' },
);

export const DiversityNoteItemsSchema = Type.Array(DiversityNoteItemSchema, { maxItems: 10 });

export type DiversityNoteItem = Static<typeof DiversityNoteItemSchema>;
