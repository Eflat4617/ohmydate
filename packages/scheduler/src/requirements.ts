import type { RiskLevel, Task } from './types.js';

/**
 * Minutes a task still needs at the selected risk level.
 *
 * `remainingMin`, when supplied by a replanning caller, is authoritative and
 * means the minutes still needed going forward; past/in-progress history
 * blocks are not subtracted from it (06 §7.1).
 *
 * A block whose start is before `now` counts entirely as history, even when it
 * extends past `now`. Callers therefore compute
 * `remainingMin = required - history minutes` (0 for an in-progress
 * non-splittable task, whose single block is the whole requirement). Omitting
 * `remainingMin` re-schedules the full P50/P90 estimate because history is not
 * credited automatically.
 */
export function taskRequiredMinutes(task: Task, riskLevel: RiskLevel): number {
  if (task.remainingMin !== undefined) {
    return Math.max(0, task.remainingMin);
  }
  return Math.max(
    0,
    riskLevel === 'p90' ? task.estimate.p90Min : task.estimate.p50Min,
  );
}
