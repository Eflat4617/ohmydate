import type { ReplanBefore, ReplanBeforeMetrics, ReplanTaskSlack } from '@ohmydate/contracts';
import type { ScheduleInput } from '@ohmydate/scheduler';
import type { ApprovedBlock } from './planning-ports.js';

/**
 * FU-70 / M5-03R-1 H1: the authoritative "before" side of a replan proposal.
 *
 * Blocks: every non-done block of the replanned plan that starts at or after
 * the proposal instant — the unlocked ones the candidate replaces on approval
 * (pg-replan-store supersedes exactly those) and the locked ones it keeps —
 * across the whole plan horizon, so a client never reconstructs the set from
 * a calendar window.
 *
 * Metrics: the scheduler's candidate rules (06 §6, generate.ts buildMetrics /
 * minSlackMinutes) applied to the before intervals:
 * - `totalFocusMin` = Σ minutes of every occupied interval (locked and other
 *   live blocks, history, the plan's future blocks);
 * - per deadline task, slack = due − buffer − end of its last interval (the
 *   horizon start when it has none); `minSlackMin` is the smallest, or
 *   horizon end − last end when no task has a deadline.
 */

const MINUTE_MS = 60_000;

export interface MetricInterval {
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
}

type MetricInput = Pick<ScheduleInput, 'tasks' | 'horizon'>;

function iso(value: string): string {
  return new Date(Date.parse(value)).toISOString();
}

export function beforeMetrics(input: MetricInput, intervals: readonly MetricInterval[]): ReplanBeforeMetrics {
  let totalFocusMin = 0;
  const lastEndByTask = new Map<string, number>();
  let lastEnd = Date.parse(input.horizon.start);
  for (const interval of intervals) {
    const startMs = Date.parse(interval.startAt);
    const endMs = Date.parse(interval.endAt);
    // The scheduler drops empty/invalid intervals before counting them.
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    totalFocusMin += (endMs - startMs) / MINUTE_MS;
    lastEndByTask.set(interval.taskId, Math.max(lastEndByTask.get(interval.taskId) ?? 0, endMs));
    lastEnd = Math.max(lastEnd, endMs);
  }

  const horizonStartMs = Date.parse(input.horizon.start);
  const taskSlack: ReplanTaskSlack[] = [];
  let minimum = Number.POSITIVE_INFINITY;
  for (const task of input.tasks) {
    if (task.dueAt === undefined) continue;
    const dueMs = Date.parse(task.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
    const end = lastEndByTask.get(task.id) ?? horizonStartMs;
    const slackMin = (dueMs - bufferMs - end) / MINUTE_MS;
    taskSlack.push({ taskId: task.id, dueAt: iso(task.dueAt), slackMin });
    minimum = Math.min(minimum, slackMin);
  }
  const minSlackMin = Number.isFinite(minimum)
    ? minimum
    : (Date.parse(input.horizon.end) - lastEnd) / MINUTE_MS;
  return { totalFocusMin, minSlackMin, taskSlack };
}

function blockKey(block: MetricInterval): string {
  return `${block.taskId}|${Date.parse(block.startAt)}|${Date.parse(block.endAt)}`;
}

/**
 * Snapshot of the plan's future blocks and the before metrics.
 * `scheduleInput` and `historyBlocks` are the assembled scheduler input the
 * candidate was generated from, so both sides see the same tasks, deadlines
 * and occupied time.
 */
export function buildBeforeSnapshot(source: {
  readonly now: string;
  readonly planBlocks: readonly ApprovedBlock[];
  readonly scheduleInput: Pick<ScheduleInput, 'tasks' | 'horizon' | 'lockedBlocks'>;
  readonly historyBlocks: readonly { readonly taskId: string; readonly start: string; readonly end: string }[];
}): ReplanBefore {
  const nowMs = Date.parse(source.now);
  const blocks = source.planBlocks
    .filter((block) => block.status !== 'done' && block.status !== 'superseded' && Date.parse(block.startAt) >= nowMs)
    .map((block) => ({
      id: block.id,
      planVersionId: block.planVersionId,
      taskId: block.taskId,
      startAt: iso(block.startAt),
      endAt: iso(block.endAt),
      locked: block.locked,
      status: block.status as ReplanBefore['blocks'][number]['status'],
      version: block.version,
    }))
    .sort(
      (left, right) =>
        Date.parse(left.startAt) - Date.parse(right.startAt) ||
        Date.parse(left.endAt) - Date.parse(right.endAt) ||
        left.id.localeCompare(right.id),
    );
  const planKeys = new Set(blocks.map(blockKey));
  // Other live (and locked) intervals the scheduler also counts; the plan's
  // own future blocks come from the snapshot so nothing is counted twice.
  const others = (source.scheduleInput.lockedBlocks ?? [])
    .map((block) => ({ taskId: block.taskId, startAt: block.start, endAt: block.end }))
    .filter((block) => !planKeys.has(blockKey(block)));
  const history = source.historyBlocks.map((block) => ({ taskId: block.taskId, startAt: block.start, endAt: block.end }));
  return {
    capturedAt: iso(source.now),
    blocks,
    metrics: beforeMetrics(source.scheduleInput, [...others, ...history, ...blocks]),
  };
}
