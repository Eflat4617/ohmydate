/**
 * Pure helpers for the replan proposal screen (M5-03, M5-03R-1 H1).
 *
 * The before side is the server's authoritative snapshot (`proposal.before`,
 * FU-70): every block of the base plan that the candidate replaces (unlocked)
 * or keeps (locked), across the whole horizon. The web never reconstructs it
 * from a calendar query, so the diff below is exact; a proposal without a
 * snapshot gets no diff at all.
 */

export interface TimedBlock {
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
}

export interface SnapshotBlock extends TimedBlock {
  readonly id: string;
  readonly locked: boolean;
}

export type BlockChangeKind = 'moved' | 'shrunk' | 'extended' | 'added' | 'removed';

export interface BlockChange {
  readonly kind: BlockChangeKind;
  readonly taskId: string;
  readonly before?: TimedBlock;
  readonly after?: TimedBlock;
}

export interface ReplanDiff<B extends SnapshotBlock = SnapshotBlock> {
  /** Only the blocks that differ, in time order. */
  readonly changes: readonly BlockChange[];
  /** Locked blocks of the snapshot: kept as they are by approval. */
  readonly locked: readonly B[];
  /** Unlocked blocks that stay exactly where they are. */
  readonly unchangedCount: number;
}

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

function plain(block: TimedBlock): TimedBlock {
  return { taskId: block.taskId, startAt: block.startAt, endAt: block.endAt };
}

/**
 * Candidate vs the before snapshot. Unlocked snapshot blocks are what approval
 * supersedes; locked ones stay. Per task, identical intervals are unchanged,
 * the rest pair up in time order (moved / shrunk / extended) and leftovers are
 * removed or added.
 */
export function replanDiff<B extends SnapshotBlock>(
  beforeBlocks: readonly B[],
  candidateBlocks: readonly TimedBlock[],
): ReplanDiff<B> {
  const replaced = beforeBlocks.filter((block) => !block.locked).sort(byStart);
  const locked = beforeBlocks.filter((block) => block.locked).sort(byStart);
  const changes: BlockChange[] = [];
  let unchangedCount = 0;
  const taskIds = [...new Set([...replaced.map((block) => block.taskId), ...candidateBlocks.map((block) => block.taskId)])];
  for (const taskId of taskIds) {
    const left = replaced.filter((block) => block.taskId === taskId);
    const unmatched = candidateBlocks.filter((block) => block.taskId === taskId).sort(byStart);
    const remaining: B[] = [];
    for (const block of left) {
      const index = unmatched.findIndex((candidate) => sameInterval(candidate, block));
      if (index === -1) {
        remaining.push(block);
      } else {
        unmatched.splice(index, 1);
        unchangedCount += 1;
      }
    }
    const pairs = Math.min(remaining.length, unmatched.length);
    for (let index = 0; index < pairs; index += 1) {
      const from = remaining[index] as B;
      const to = unmatched[index] as TimedBlock;
      changes.push({ kind: changeKind(from, to), taskId, before: plain(from), after: plain(to) });
    }
    for (const from of remaining.slice(pairs)) changes.push({ kind: 'removed', taskId, before: plain(from) });
    for (const to of unmatched.slice(pairs)) changes.push({ kind: 'added', taskId, after: plain(to) });
  }
  changes.sort((left, right) => changeTime(left) - changeTime(right) || left.taskId.localeCompare(right.taskId));
  return { changes, locked, unchangedCount };
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
