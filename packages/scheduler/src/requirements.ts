import type { RiskLevel, Task } from './types.js';

/**
 * Minutes a task still needs at the selected risk level.
 *
 * `remainingMin`, when supplied by a replanning caller, is authoritative and
 * means the minutes still needed going forward; past/in-progress history
 * blocks are not subtracted from it (06 §7.1). Otherwise the task's P50/P90
 * estimate is used.
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
