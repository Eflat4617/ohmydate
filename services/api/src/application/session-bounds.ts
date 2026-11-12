import type { Task } from '@ohmydate/domain';
import {
  autoSplitMinSessionMin,
  maxLegalSessionMin,
  type AutoSplitReason,
  type Preferences,
} from '@ohmydate/scheduler';

/** Session bounds of a splittable task without its own `session` window. */
export const DEFAULT_MIN_SESSION_MIN = 30;
export const DEFAULT_MAX_SESSION_MIN = 90;

export interface SchedulingSessionBounds {
  readonly splittable: boolean;
  readonly minSessionMin: number;
  readonly maxSessionMin: number;
  /** Set when a non-splittable task is auto-split for scheduling (FU-96). */
  readonly autoSplit?: AutoSplitReason;
}

/**
 * The one mapping from a planner task to scheduler session bounds (FU-96,
 * 06 §3). Every scheduler-input path uses it: plan create, edit preview,
 * approval and regenerate (`assembleScheduleInput`), replan proposal and
 * approval (which reuse `assembleScheduleInput`), and the today actions'
 * own assembly. Generation and every later validation therefore see the
 * same bounds, so a generated candidate stays approvable.
 *
 * - Splittable: the task's `session` window, else 30-90 minutes.
 * - Non-splittable that fits one H6-legal block: one block equal to the
 *   remaining minutes (`min = max = remainingMin`), unchanged.
 * - Non-splittable longer than one H6-legal block (`maxLegalSessionMin`: the
 *   smaller of `breakAfterMin` and `maxDailyFocusMin` on the 5-minute grid):
 *   such a block can never satisfy H6, so the task and all its successors
 *   would stay unplaced. It is scheduled as splittable in sessions of
 *   `[min(30, cap / 2), cap]` and annotated with `autoSplit` so the generator
 *   explains it. The cap is deliberately not reduced to the 90-minute
 *   splittable default: the user asked for one long block, so the sessions
 *   stay as long as H6 allows.
 *
 * Only the scheduler input changes; the stored task (Vikunja/planner) keeps
 * `splittable: false`. Out-of-scope locked/history tasks never come here.
 */
export function schedulingSessionBounds(
  task: Pick<Task, 'splittable' | 'session'> | undefined,
  remainingMin: number,
  prefs: Pick<Preferences, 'breakAfterMin' | 'maxDailyFocusMin'>,
): SchedulingSessionBounds {
  if (task === undefined || task.splittable) {
    return {
      splittable: true,
      minSessionMin: task?.session?.minMinutes ?? DEFAULT_MIN_SESSION_MIN,
      maxSessionMin: task?.session?.maxMinutes ?? DEFAULT_MAX_SESSION_MIN,
    };
  }
  const limit = maxLegalSessionMin(prefs);
  if (limit === undefined || remainingMin <= limit.capMin) {
    return { splittable: false, minSessionMin: remainingMin, maxSessionMin: remainingMin };
  }
  return {
    splittable: true,
    minSessionMin: autoSplitMinSessionMin(limit.capMin, DEFAULT_MIN_SESSION_MIN),
    maxSessionMin: limit.capMin,
    autoSplit: limit.reason,
  };
}
