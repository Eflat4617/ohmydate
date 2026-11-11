/**
 * Pure helpers for the replan proposal screen (M5-03). No I/O and no clock:
 * the view passes the proposal, the approved blocks it loaded and the task
 * deadlines it knows about.
 *
 * Contract notes (06 §7, 08 §2.6, pg-replan-store approve):
 * - `candidate.blocks` is the complete replacement for the plan's *unlocked*
 *   future blocks (fixed ones included); approval supersedes exactly that set.
 * - Locked blocks are never part of a candidate. They stay as the same row and
 *   are shown here as "unchanged".
 * - "Future" is measured from the moment the proposal was computed
 *   (`trigger.detectedAt`), not the viewer's clock, so the diff of a pending
 *   proposal is stable while it is open.
 * - The proposal does not carry its plan id, so the plan's task set is
 *   inferred: candidate tasks ∪ affected tasks ∪ tasks of blocks written by
 *   the base plan version.
 */

export interface TimedBlock {
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
}

export interface ApprovedBlockLike extends TimedBlock {
  readonly id: string;
  readonly planVersionId: string;
  readonly locked: boolean;
  readonly status: string;
}

export type BlockChangeKind = 'moved' | 'shrunk' | 'extended' | 'added' | 'removed';

export interface BlockChange {
  readonly kind: BlockChangeKind;
  readonly taskId: string;
  readonly before?: TimedBlock;
  readonly after?: TimedBlock;
}

export interface ReplanDiffInput {
  readonly candidateBlocks: readonly TimedBlock[];
  readonly currentBlocks: readonly ApprovedBlockLike[];
  readonly affectedTaskIds: readonly string[];
  readonly basePlanVersionId: string;
  /** Instant the proposal was computed (`trigger.detectedAt`). */
  readonly since: string;
}

export interface ReplanDiff {
  /** Only the blocks that differ, in time order. */
  readonly changes: readonly BlockChange[];
  /** Locked future blocks of the plan: never moved by a replan. */
  readonly locked: readonly ApprovedBlockLike[];
  /** Unlocked blocks that stay exactly where they are. */
  readonly unchangedCount: number;
  /** The plan's current unlocked future blocks (the "before" side). */
  readonly before: readonly ApprovedBlockLike[];
  readonly planTaskIds: ReadonlySet<string>;
}

const INACTIVE = new Set(['superseded', 'done']);

function ms(instant: string): number {
  return Date.parse(instant);
}

function sameInterval(left: TimedBlock, right: TimedBlock): boolean {
  return ms(left.startAt) === ms(right.startAt) && ms(left.endAt) === ms(right.endAt);
}

function byStart<T extends TimedBlock>(left: T, right: T): number {
  return ms(left.startAt) - ms(right.startAt) || ms(left.endAt) - ms(right.endAt);
}

/** A pair that keeps its length moved; otherwise the length change wins. */
function changeKind(before: TimedBlock, after: TimedBlock): BlockChangeKind {
  const beforeLength = ms(before.endAt) - ms(before.startAt);
  const afterLength = ms(after.endAt) - ms(after.startAt);
  if (afterLength < beforeLength) return 'shrunk';
  if (afterLength > beforeLength) return 'extended';
  return 'moved';
}

function changeTime(change: BlockChange): number {
  return Math.min(
    change.before === undefined ? Number.POSITIVE_INFINITY : ms(change.before.startAt),
    change.after === undefined ? Number.POSITIVE_INFINITY : ms(change.after.startAt),
  );
}

/** Before/after difference of a replan candidate against the approved schedule. */
export function replanDiff(input: ReplanDiffInput): ReplanDiff {
  const sinceMs = ms(input.since);
  const planTaskIds = new Set<string>([
    ...input.candidateBlocks.map((block) => block.taskId),
    ...input.affectedTaskIds,
    ...input.currentBlocks
      .filter((block) => block.planVersionId === input.basePlanVersionId)
      .map((block) => block.taskId),
  ]);
  const future = input.currentBlocks.filter(
    (block) =>
      planTaskIds.has(block.taskId) && !INACTIVE.has(block.status) && ms(block.startAt) >= sinceMs,
  );
  const before = future.filter((block) => !block.locked).sort(byStart);
  const locked = future.filter((block) => block.locked).sort(byStart);

  const changes: BlockChange[] = [];
  let unchangedCount = 0;
  const taskIds = [...new Set([...before.map((b) => b.taskId), ...input.candidateBlocks.map((b) => b.taskId)])];
  for (const taskId of taskIds) {
    const left = before.filter((block) => block.taskId === taskId);
    const right = [...input.candidateBlocks.filter((block) => block.taskId === taskId)].sort(byStart);
    const remainingLeft: ApprovedBlockLike[] = [];
    const unmatchedRight = [...right];
    for (const block of left) {
      const index = unmatchedRight.findIndex((candidate) => sameInterval(candidate, block));
      if (index === -1) {
        remainingLeft.push(block);
      } else {
        unmatchedRight.splice(index, 1);
        unchangedCount += 1;
      }
    }
    const pairs = Math.min(remainingLeft.length, unmatchedRight.length);
    for (let index = 0; index < pairs; index += 1) {
      const from = remainingLeft[index] as ApprovedBlockLike;
      const to = unmatchedRight[index] as TimedBlock;
      changes.push({
        kind: changeKind(from, to),
        taskId,
        before: { taskId, startAt: from.startAt, endAt: from.endAt },
        after: { taskId, startAt: to.startAt, endAt: to.endAt },
      });
    }
    for (const from of remainingLeft.slice(pairs)) {
      changes.push({ kind: 'removed', taskId, before: { taskId, startAt: from.startAt, endAt: from.endAt } });
    }
    for (const to of unmatchedRight.slice(pairs)) {
      changes.push({ kind: 'added', taskId, after: { taskId, startAt: to.startAt, endAt: to.endAt } });
    }
  }
  changes.sort((left, right) => changeTime(left) - changeTime(right) || left.taskId.localeCompare(right.taskId));
  return { changes, locked, unchangedCount, before, planTaskIds };
}

/** Planned focus minutes of a block set. */
export function plannedMinutes(blocks: readonly TimedBlock[]): number {
  return blocks.reduce(
    (sum, block) => sum + Math.max(0, Math.round((ms(block.endAt) - ms(block.startAt)) / 60_000)),
    0,
  );
}

/**
 * Smallest deadline slack in minutes (due − end of the task's last block),
 * the scheduler's `minSlackMin` definition without per-task buffers. Tasks
 * without a deadline or without blocks are ignored; `null` when none count.
 */
export function deadlineSlackMinutes(
  blocks: readonly TimedBlock[],
  dueByTask: ReadonlyMap<string, string>,
): number | null {
  const lastEnd = new Map<string, number>();
  for (const block of blocks) {
    lastEnd.set(block.taskId, Math.max(lastEnd.get(block.taskId) ?? Number.NEGATIVE_INFINITY, ms(block.endAt)));
  }
  let minimum: number | null = null;
  for (const [taskId, due] of dueByTask) {
    const end = lastEnd.get(taskId);
    const dueMs = ms(due);
    if (end === undefined || !Number.isFinite(dueMs)) continue;
    const slack = Math.floor((dueMs - end) / 60_000);
    minimum = minimum === null ? slack : Math.min(minimum, slack);
  }
  return minimum;
}

export interface RetryWait {
  /** Whole minutes to wait, rounded up (never 0 for a positive wait). */
  readonly minutes: number;
  /** Instant after which a retry is allowed. */
  readonly untilMs: number;
}

/** Human-sized wait from a Retry-After header value (seconds). */
export function retryWait(retryAfterSeconds: number, nowMs: number): RetryWait | null {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds <= 0) return null;
  return {
    minutes: Math.max(1, Math.ceil(retryAfterSeconds / 60)),
    untilMs: nowMs + Math.ceil(retryAfterSeconds * 1000),
  };
}

/** Time window that covers both sides of a proposal (for `GET /schedule-blocks`). */
export function proposalWindow(
  candidateBlocks: readonly TimedBlock[],
  since: string,
  maxDays = 366,
): { from: string; to: string } {
  // Minute-aligned like every other list query; the diff itself filters by `since`.
  const fromMs = Math.floor(ms(since) / 60_000) * 60_000;
  const lastEnd = candidateBlocks.reduce((max, block) => Math.max(max, ms(block.endAt)), fromMs);
  const dayMs = 24 * 60 * 60 * 1000;
  const toMs = Math.min(fromMs + maxDays * dayMs, Math.ceil(lastEnd / 60_000) * 60_000 + 14 * dayMs);
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}
