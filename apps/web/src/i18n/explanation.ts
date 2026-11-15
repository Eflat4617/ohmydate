import type { components } from '../api/schema';
import { policyLabel, policySummary } from '../domain/plan';
import { formatCivilDate, formatDateTime, formatDateTimeRange, formatDuration, formatNumber } from './format';
import { t } from './index';

/**
 * Korean text for the scheduler's coded explanations and violation findings
 * (FU-62). The server keeps its English `explanation[]` / `message` for logs;
 * the screen renders `explanationItems[i]` / `messageCode` + `params` instead.
 *
 * Params carry only numbers and opaque tokens (task IDs, UTC instants, civil
 * dates, enum values). Task names are resolved here from IDs the screen
 * already has; an unknown ID reads as a generic "한 작업". A code this build
 * does not know, or a missing/ill-typed param, yields `null` so the caller
 * shows the original English line for that entry instead of a broken sentence.
 */

export type ExplanationItem = components['schemas']['ExplanationItem'];
export type ExplanationCode = ExplanationItem['code'];
type Params = ExplanationItem['params'];

export interface ExplanationContext {
  /** IANA zone for instants (the plan's zone). */
  readonly timeZone: string;
  /** Title lookup for task IDs the screen already loaded. */
  readonly taskName?: ((taskId: string) => string | undefined) | undefined;
}

/** Violation fields the renderer reads (contract `Violation`). */
export interface CodedViolation {
  readonly code: string;
  readonly message: string;
  readonly messageCode?: string | undefined;
  readonly params?: Params | undefined;
}

type TaskFallback = 'taskUnknown' | 'otherTaskUnknown' | 'dependencyUnknown';

const WEEKDAY_KEYS = [
  'availability.weekday.1',
  'availability.weekday.2',
  'availability.weekday.3',
  'availability.weekday.4',
  'availability.weekday.5',
  'availability.weekday.6',
  'availability.weekday.7',
] as const;

const AUTO_SPLIT_REASON_KEYS = {
  break_after: 'explanation.autoSplitReason.break_after',
  daily_cap: 'explanation.autoSplitReason.daily_cap',
} as const;

const PREFERENCE_FIELD_KEYS = {
  maxDailyFocusMin: 'explanation.field.maxDailyFocusMin',
  breakAfterMin: 'explanation.field.breakAfterMin',
  breakMin: 'explanation.field.breakMin',
} as const;

/** Reads typed params and remembers whether any of them was missing or invalid. */
class ParamReader {
  valid = true;

  constructor(
    private readonly params: Params,
    private readonly context: ExplanationContext,
  ) {}

  number(key: string): number {
    const value = this.params[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    this.valid = false;
    return 0;
  }

  token(key: string): string {
    const value = this.params[key];
    if (typeof value === 'string' && value.length > 0) return value;
    this.valid = false;
    return '';
  }

  duration(key: string): string {
    return formatDuration(this.number(key));
  }

  count(key: string): string {
    return formatNumber(this.number(key));
  }

  task(key: string, fallback: TaskFallback = 'taskUnknown'): string {
    const id = this.token(key);
    const title = id.length === 0 ? undefined : this.context.taskName?.(id);
    return title === undefined || title.length === 0 ? t(`explanation.${fallback}`) : t('explanation.task', { title });
  }

  timeRange(startKey: string, endKey: string): string {
    const start = this.token(startKey);
    const end = this.token(endKey);
    return this.guard(() => formatDateTimeRange(start, end, this.context.timeZone));
  }

  at(key: string): string {
    const value = this.token(key);
    return this.guard(() => formatDateTime(value, this.context.timeZone));
  }

  date(key: string): string {
    const value = this.token(key);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      this.valid = false;
      return value;
    }
    return formatCivilDate(value);
  }

  policy(key: string): { label: string; summary: string } {
    const value = this.token(key);
    const summary = policySummary(value);
    if (summary === null) this.valid = false;
    return { label: policyLabel(value), summary: summary ?? '' };
  }

  weekday(key: string): string {
    const index = this.number(key);
    const weekdayKey = Number.isInteger(index) ? WEEKDAY_KEYS[index - 1] : undefined;
    if (weekdayKey === undefined) {
      this.valid = false;
      return '';
    }
    return t(weekdayKey);
  }

  field(key: string): string {
    const value = this.token(key);
    const fieldKey = PREFERENCE_FIELD_KEYS[value as keyof typeof PREFERENCE_FIELD_KEYS] as
      | (typeof PREFERENCE_FIELD_KEYS)[keyof typeof PREFERENCE_FIELD_KEYS]
      | undefined;
    if (fieldKey === undefined) {
      this.valid = false;
      return value;
    }
    return t(fieldKey);
  }

  autoSplitReason(key: string): string {
    const value = this.token(key);
    const reasonKey = AUTO_SPLIT_REASON_KEYS[value as keyof typeof AUTO_SPLIT_REASON_KEYS] as
      | (typeof AUTO_SPLIT_REASON_KEYS)[keyof typeof AUTO_SPLIT_REASON_KEYS]
      | undefined;
    if (reasonKey === undefined) {
      this.valid = false;
      return value;
    }
    return t(reasonKey);
  }

  private guard(format: () => string): string {
    if (!this.valid) return '';
    try {
      return format();
    } catch {
      this.valid = false;
      return '';
    }
  }
}

type Renderer = (read: ParamReader) => string;

/**
 * One Korean renderer per contract code. Typed as an exhaustive record, so a
 * code added to the contract (and regenerated into `schema.d.ts`) without a
 * renderer here is a typecheck error.
 */
const RENDERERS: { readonly [C in ExplanationCode]: Renderer } = {
  policy_summary: (r) => {
    const policy = r.policy('policy');
    // The scheduler's version (`policyVersion`) is for logs; a person reads the way and what it does.
    return t('explain.policy_summary', { policy: policy.label, summary: policy.summary });
  },
  placement_summary: (r) =>
    t('explain.placement_summary', {
      required: r.duration('requiredMin'),
      placed: r.duration('placedMin'),
      blocks: r.count('blockCount'),
      retained: r.count('retainedCount'),
    }),
  constraints_satisfied: () => t('explain.constraints_satisfied'),
  infeasible_summary: (r) => t('explain.infeasible_summary', { count: r.count('violationCount') }),
  heuristic_insufficient_available_time: () => t('explain.heuristic_insufficient_available_time'),
  heuristic_no_contiguous_window: () => t('explain.heuristic_no_contiguous_window'),
  heuristic_estimate_not_grid_aligned: () => t('explain.heuristic_estimate_not_grid_aligned'),
  heuristic_estimate_below_grid: () => t('explain.heuristic_estimate_below_grid'),
  heuristic_session_bounds_infeasible: () => t('explain.heuristic_session_bounds_infeasible'),
  unplaced_minutes: (r) => t('explain.unplaced_minutes', { duration: r.duration('deficitMin') }),
  capacity_deficit: (r) => t('explain.capacity_deficit', { duration: r.duration('capacityDeficitMin') }),
  replan_bound_exceeded: (r) =>
    t('explain.replan_bound_exceeded', {
      changed: r.count('changedBlocks'),
      bound: r.count('bound'),
      affected: r.count('affectedExistingBlocks'),
    }),
  input_rejected: (r) => t('explain.input_rejected', { count: r.count('issueCount') }),
  heuristic_blocked_by_predecessor: () => t('explain.heuristic_blocked_by_predecessor'),
  auto_split_long_task: (r) =>
    t('explain.auto_split_long_task', {
      task: r.task('taskId'),
      reason: r.autoSplitReason('reason'),
      duration: r.duration('sessionMaxMin'),
    }),

  input_invalid_time_zone: () => t('explain.input_invalid_time_zone'),
  input_invalid_horizon_instant: () => t('explain.input_invalid_horizon_instant'),
  input_horizon_not_increasing: () => t('explain.input_horizon_not_increasing'),
  input_horizon_too_long: (r) => t('explain.input_horizon_too_long', { days: r.count('maxDays') }),
  input_invalid_now: () => t('explain.input_invalid_now'),
  input_duplicate_task: (r) => t('explain.input_duplicate_task', { task: r.task('taskId') }),
  input_invalid_estimate: (r) => t('explain.input_invalid_estimate', { task: r.task('taskId'), max: r.count('maxMin') }),
  input_invalid_buffer: (r) => t('explain.input_invalid_buffer', { task: r.task('taskId'), max: r.count('maxMin') }),
  input_invalid_session_minutes: (r) =>
    t('explain.input_invalid_session_minutes', { task: r.task('taskId'), max: r.count('maxMin') }),
  input_invalid_session_bounds: (r) => t('explain.input_invalid_session_bounds', { task: r.task('taskId') }),
  input_invalid_task_window_instant: (r) => t('explain.input_invalid_task_window_instant', { task: r.task('taskId') }),
  input_task_window_empty: (r) => t('explain.input_task_window_empty', { task: r.task('taskId') }),
  input_invalid_preference: (r) => t('explain.input_invalid_preference', { field: r.field('field'), max: r.count('maxMin') }),
  input_unknown_dependency: (r) => t('explain.input_unknown_dependency', { task: r.task('taskId') }),
  input_dependency_cycle: () => t('explain.input_dependency_cycle'),
  input_invalid_weekday: () => t('explain.input_invalid_weekday'),
  input_invalid_availability_window: (r) =>
    t('explain.input_invalid_availability_window', { weekday: r.weekday('weekday') }),
  input_invalid_exception_date: () => t('explain.input_invalid_exception_date'),
  input_exception_partial_window: () => t('explain.input_exception_partial_window'),
  input_invalid_exception_window: () => t('explain.input_invalid_exception_window'),
  input_commitment_invalid_instant: () => t('explain.input_commitment_invalid_instant'),
  input_commitment_end_before_start: () => t('explain.input_commitment_end_before_start'),
  input_commitment_too_long: (r) => t('explain.input_commitment_too_long', { days: r.count('maxDays') }),
  input_unknown_block_task: () => t('explain.input_unknown_block_task'),
  input_invalid_block_instant: (r) => t('explain.input_invalid_block_instant', { task: r.task('taskId') }),
  input_block_sub_millisecond: (r) => t('explain.input_block_sub_millisecond', { task: r.task('taskId') }),
  input_block_off_grid: (r) => t('explain.input_block_off_grid', { task: r.task('taskId') }),
  input_block_end_before_start: (r) => t('explain.input_block_end_before_start', { task: r.task('taskId') }),
  input_block_too_long: (r) => t('explain.input_block_too_long', { task: r.task('taskId'), days: r.count('maxDays') }),

  h0_unknown_task: () => t('explain.h0_unknown_task'),
  h0_outside_horizon: (r) =>
    t('explain.h0_outside_horizon', { task: r.task('taskId'), time: r.timeRange('startAt', 'endAt') }),
  h1_same_task_overlap: (r) => t('explain.h1_same_task_overlap', { task: r.task('taskId') }),
  h1_tasks_overlap: (r) =>
    t('explain.h1_tasks_overlap', { task: r.task('taskId'), other: r.task('otherTaskId', 'otherTaskUnknown') }),
  h1_commitment_overlap: (r) =>
    t('explain.h1_commitment_overlap', { task: r.task('taskId'), time: r.timeRange('startAt', 'endAt') }),
  h1_active_block_overlap: () => t('explain.h1_active_block_overlap'),
  h2_outside_availability: (r) =>
    t('explain.h2_outside_availability', { task: r.task('taskId'), time: r.timeRange('startAt', 'endAt') }),
  h3_dependency_order: (r) =>
    t('explain.h3_dependency_order', {
      task: r.task('taskId'),
      dependency: r.task('dependencyId', 'dependencyUnknown'),
    }),
  h4_before_earliest_start: (r) =>
    t('explain.h4_before_earliest_start', { task: r.task('taskId'), at: r.at('earliestStartAt') }),
  h4_inside_due_buffer: (r) =>
    t('explain.h4_inside_due_buffer', { task: r.task('taskId'), at: r.at('dueAt'), buffer: r.duration('bufferMin') }),
  h4_after_due: (r) => t('explain.h4_after_due', { task: r.task('taskId'), at: r.at('dueAt') }),
  h5_unsplittable_no_remaining: (r) => t('explain.h5_unsplittable_no_remaining', { task: r.task('taskId') }),
  h5_unsplittable_required_out_of_bounds: (r) =>
    t('explain.h5_unsplittable_required_out_of_bounds', {
      task: r.task('taskId'),
      required: r.duration('requiredMin'),
      min: r.duration('minSessionMin'),
      max: r.duration('maxSessionMin'),
    }),
  h5_unsplittable_single_block: (r) =>
    t('explain.h5_unsplittable_single_block', { task: r.task('taskId'), required: r.duration('requiredMin') }),
  h5_session_out_of_bounds: (r) =>
    t('explain.h5_session_out_of_bounds', {
      task: r.task('taskId'),
      duration: r.duration('durationMin'),
      time: r.timeRange('startAt', 'endAt'),
      min: r.duration('minSessionMin'),
      max: r.duration('maxSessionMin'),
    }),
  h6_daily_focus_exceeded: (r) =>
    t('explain.h6_daily_focus_exceeded', {
      date: r.date('date'),
      total: r.duration('totalMin'),
      max: r.duration('maxDailyFocusMin'),
    }),
  h6_break_missing: (r) =>
    t('explain.h6_break_missing', {
      date: r.date('date'),
      breakAfter: r.duration('breakAfterMin'),
      breakLength: r.duration('breakMin'),
    }),
  h7_deficit: (r) => t('explain.h7_deficit', { task: r.task('taskId'), duration: r.duration('shortMin') }),
  h7_overallocated: (r) => t('explain.h7_overallocated', { task: r.task('taskId'), duration: r.duration('excessMin') }),
  h8_invalid_time_zone: () => t('explain.h8_invalid_time_zone'),
  h8_invalid_horizon: () => t('explain.h8_invalid_horizon'),
  h8_invalid_instant: (r) => t('explain.h8_invalid_instant', { task: r.task('taskId') }),
  h8_sub_millisecond: (r) => t('explain.h8_sub_millisecond', { task: r.task('taskId') }),
  h8_off_grid: (r) => t('explain.h8_off_grid', { task: r.task('taskId') }),
  h8_end_before_start: (r) => t('explain.h8_end_before_start', { task: r.task('taskId') }),
};

/** Every code this build renders (for catalog-completeness tests). */
export const RENDERED_EXPLANATION_CODES: readonly ExplanationCode[] = Object.keys(RENDERERS) as ExplanationCode[];

function render(code: string, params: Params | undefined, context: ExplanationContext): string | null {
  if (!Object.prototype.hasOwnProperty.call(RENDERERS, code) || params === undefined || params === null) return null;
  const reader = new ParamReader(params, context);
  const text = RENDERERS[code as ExplanationCode](reader);
  return reader.valid ? text : null;
}

/** Korean text for one coded item, or `null` to fall back to the English line. */
export function explanationItemText(item: ExplanationItem, context: ExplanationContext): string | null {
  return render(item.code, item.params, context);
}

/** Korean text for a coded violation finding, or `null` for a legacy/unknown one. */
export function violationMessageText(violation: CodedViolation, context: ExplanationContext): string | null {
  return violation.messageCode === undefined ? null : render(violation.messageCode, violation.params, context);
}

export interface ExplanationEntry {
  readonly text: string;
  /** `false` when the English server line is shown for this entry. */
  readonly translated: boolean;
}

export interface RenderedExplanation {
  /** `true` when items pair 1:1 with the lines (otherwise the original text is shown). */
  readonly coded: boolean;
  readonly entries: readonly ExplanationEntry[];
}

/**
 * Pair `explanationItems[i]` with `explanation[i]`. Items that are missing
 * (rows written before FU-62) or misaligned mean `coded: false` and the
 * original lines; a single unrenderable item falls back to its own line.
 */
export function renderExplanation(
  lines: readonly string[],
  items: readonly ExplanationItem[] | undefined,
  context: ExplanationContext,
): RenderedExplanation {
  if (items === undefined || items.length === 0 || items.length !== lines.length) {
    return { coded: false, entries: lines.map((text) => ({ text, translated: false })) };
  }
  return {
    coded: true,
    entries: items.map((item, index) => {
      const text = explanationItemText(item, context);
      return text === null ? { text: lines[index] ?? '', translated: false } : { text, translated: true };
    }),
  };
}
