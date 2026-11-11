import type { ReplanReasonCode, ReplanTriggerKind } from '@ohmydate/contracts';
import type { Id, Instant, TaskStatus } from '@ohmydate/domain';

/**
 * Pure M5 replan trigger detection (05 §11, 06 §7). No I/O and no clock: the
 * detection job loads the active plan snapshot and passes it in.
 *
 * Rules
 * - History: a block that started before `now`, or whose status is `done`, is
 *   spent work (06 §7.1). Everything else on the active plan is future work.
 * - P90 slack (`deadline_risk`): for an open task with a future `dueAt`,
 *   `remainingP90 = max(0, P90 - history minutes)`. Future blocks that end by
 *   the due instant are accumulated in start order. When they cover the
 *   remainder, slack = due - (end of the covering block) >= 0; otherwise
 *   slack = -(uncovered minutes), i.e. the approved plan cannot finish the P90
 *   requirement before the deadline. slack < 0 triggers a proposal.
 * - `commitment_conflict`: a future approved block overlaps a commitment
 *   occurrence (a commitment added or moved after approval).
 * - `early_completion`: a task is done but still owns future blocks, or its
 *   future blocks exceed the remaining requirement at the owner's risk level by
 *   at least `earlyCompletionMarginMin` (default 30). The freed time is only
 *   proposed back, never reassigned (G08).
 */

const MINUTE_MS = 60_000;
export const EARLY_COMPLETION_MARGIN_MIN = 30;

export interface DetectionTask {
  readonly id: Id;
  readonly dueAt?: Instant | undefined;
  readonly status: TaskStatus;
}

export interface DetectionBlock {
  readonly taskId: Id;
  readonly startAt: Instant;
  readonly endAt: Instant;
  readonly status: string;
}

export interface DetectionInput {
  readonly now: Instant;
  readonly riskLevel: 'p50' | 'p90';
  readonly tasks: readonly DetectionTask[];
  /** Non-superseded blocks of the active plan. */
  readonly blocks: readonly DetectionBlock[];
  readonly estimates: ReadonlyMap<string, { readonly p50Min: number; readonly p90Min: number }>;
  /** Commitment occurrences (already expanded) inside the plan horizon. */
  readonly commitments: readonly { readonly start: string; readonly end: string }[];
  readonly earlyCompletionMarginMin?: number;
}

export interface TaskSlack {
  readonly taskId: Id;
  readonly slackMin: number;
  readonly remainingP90Min: number;
  readonly plannedBeforeDueMin: number;
}

export interface DetectedTrigger {
  readonly kind: Exclude<ReplanTriggerKind, 'user_request'>;
  readonly reason: ReplanReasonCode;
  readonly affectedTaskIds: readonly Id[];
}

function minutes(block: { readonly startAt: string; readonly endAt: string }): number {
  return Math.max(0, Math.round((Date.parse(block.endAt) - Date.parse(block.startAt)) / MINUTE_MS));
}

function isHistory(block: DetectionBlock, nowMs: number): boolean {
  return block.status === 'done' || Date.parse(block.startAt) < nowMs;
}

function sortedFuture(blocks: readonly DetectionBlock[], taskId: string, nowMs: number): DetectionBlock[] {
  return blocks
    .filter((block) => block.taskId === taskId && !isHistory(block, nowMs))
    .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt) || Date.parse(a.endAt) - Date.parse(b.endAt));
}

function historyMinutes(blocks: readonly DetectionBlock[], taskId: string, nowMs: number): number {
  return blocks
    .filter((block) => block.taskId === taskId && isHistory(block, nowMs))
    .reduce((sum, block) => sum + minutes(block), 0);
}

/** P90-based slack for one open task with a future deadline, else null. */
export function p90Slack(input: DetectionInput, task: DetectionTask): TaskSlack | null {
  const nowMs = Date.parse(input.now);
  if (task.status === 'done' || task.dueAt === undefined) return null;
  const dueMs = Date.parse(task.dueAt);
  if (!Number.isFinite(dueMs) || dueMs <= nowMs) return null;
  const estimate = input.estimates.get(task.id);
  if (estimate === undefined) return null;
  const remaining = Math.max(0, estimate.p90Min - historyMinutes(input.blocks, task.id, nowMs));
  let covered = 0;
  let finishMs = nowMs;
  for (const block of sortedFuture(input.blocks, task.id, nowMs)) {
    if (covered >= remaining) break;
    const endMs = Date.parse(block.endAt);
    if (endMs > dueMs) break;
    covered += minutes(block);
    finishMs = endMs;
  }
  const slackMin =
    covered >= remaining
      ? Math.floor((dueMs - (remaining === 0 ? nowMs : finishMs)) / MINUTE_MS)
      : -(remaining - covered);
  return {
    taskId: task.id,
    slackMin,
    remainingP90Min: remaining,
    plannedBeforeDueMin: covered,
  };
}

function sortedIds(ids: Iterable<Id>): Id[] {
  return [...new Set(ids)].sort();
}

export function detectTriggers(input: DetectionInput): DetectedTrigger[] {
  const nowMs = Date.parse(input.now);
  const triggers: DetectedTrigger[] = [];
  const byId = new Map(input.tasks.map((task) => [task.id, task]));

  const conflicted = new Set<Id>();
  for (const block of input.blocks) {
    if (isHistory(block, nowMs)) continue;
    if (!byId.has(block.taskId) || byId.get(block.taskId)?.status === 'done') continue;
    const startMs = Date.parse(block.startAt);
    const endMs = Date.parse(block.endAt);
    for (const commitment of input.commitments) {
      if (Date.parse(commitment.start) < endMs && Date.parse(commitment.end) > startMs) {
        conflicted.add(block.taskId);
        break;
      }
    }
  }
  if (conflicted.size > 0) {
    triggers.push({
      kind: 'commitment_conflict',
      reason: 'commitment_overlap',
      affectedTaskIds: sortedIds(conflicted),
    });
  }

  const atRisk = new Set<Id>();
  for (const task of input.tasks) {
    const slack = p90Slack(input, task);
    if (slack !== null && slack.slackMin < 0) atRisk.add(task.id);
  }
  if (atRisk.size > 0) {
    triggers.push({
      kind: 'deadline_risk',
      reason: 'deadline_slack_negative',
      affectedTaskIds: sortedIds(atRisk),
    });
  }

  const margin = input.earlyCompletionMarginMin ?? EARLY_COMPLETION_MARGIN_MIN;
  const early = new Set<Id>();
  for (const task of input.tasks) {
    const future = sortedFuture(input.blocks, task.id, nowMs);
    if (future.length === 0) continue;
    const planned = future.reduce((sum, block) => sum + minutes(block), 0);
    if (task.status === 'done') {
      early.add(task.id);
      continue;
    }
    if (atRisk.has(task.id) || conflicted.has(task.id)) continue;
    const estimate = input.estimates.get(task.id);
    if (estimate === undefined) continue;
    const required = input.riskLevel === 'p90' ? estimate.p90Min : estimate.p50Min;
    const remaining = Math.max(0, required - historyMinutes(input.blocks, task.id, nowMs));
    if (planned - remaining >= margin) early.add(task.id);
  }
  if (early.size > 0) {
    triggers.push({
      kind: 'early_completion',
      reason: 'early_completion_capacity',
      affectedTaskIds: sortedIds(early),
    });
  }
  return triggers;
}
