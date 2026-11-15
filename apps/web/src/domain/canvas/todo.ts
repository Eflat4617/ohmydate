import { localDateOf, todayInZone } from '../time';
import { DAY_MS, byUrgency, depthOf, type Depth } from './layout';

/**
 * What a to-do on the 할 일 canvas says about itself (HOLO-05), worked out
 * from the task alone: how near it is drawn, and its deadline in the fewest
 * words. Pure; the words themselves come from the catalog.
 */
export interface TodoSource {
  readonly id: string;
  readonly title: string;
  readonly status: 'todo' | 'in_progress' | 'done';
  readonly projectId: string;
  readonly dueAt?: string | undefined;
  readonly createdAt: string;
}

/** A deadline as the capsule says it. `days` is whole calendar days in the owner's zone. */
export type DueChip =
  | { readonly kind: 'overdue'; readonly days: number }
  | { readonly kind: 'today' }
  | { readonly kind: 'tomorrow' }
  | { readonly kind: 'days'; readonly days: number }
  | { readonly kind: 'date' };

/** Deadlines further away than this are said as a date. */
export const DUE_DAYS_LIMIT = 14;

function civilDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * How a deadline is said: past it (and by how many days), today, tomorrow,
 * in N days, or — far off — as its date. Null without a deadline. "Past" is
 * by the clock; the days are calendar days where the owner lives.
 */
export function dueChipOf(dueAt: string | undefined, nowMs: number, timeZone: string): DueChip | null {
  if (dueAt === undefined) return null;
  const due = Date.parse(dueAt);
  if (!Number.isFinite(due)) return null;
  const days = civilDays(todayInZone(timeZone, nowMs), localDateOf(dueAt, timeZone));
  if (due < nowMs) return { kind: 'overdue', days: Math.max(0, -days) };
  if (days <= 0) return { kind: 'today' };
  if (days === 1) return { kind: 'tomorrow' };
  return days <= DUE_DAYS_LIMIT ? { kind: 'days', days } : { kind: 'date' };
}

/** How loud a deadline is said: past it, within the week, or further off. */
export type DueTone = 'overdue' | 'soon' | 'far';

export function dueToneOf(chip: DueChip): DueTone {
  if (chip.kind === 'overdue') return 'overdue';
  if (chip.kind === 'today' || chip.kind === 'tomorrow') return 'soon';
  return chip.kind === 'days' && chip.days <= 7 ? 'soon' : 'far';
}

export interface CanvasTodo<T extends TodoSource = TodoSource> {
  readonly task: T;
  /** The folder it is filed in; null in the inbox (the open water). */
  readonly folderId: string | null;
  readonly depth: Depth;
  readonly due: DueChip | null;
  readonly overdue: boolean;
  /** It has a block to come in a confirmed plan. */
  readonly planned: boolean;
}

/**
 * The open to-dos of the canvas, most urgent first. A to-do belongs to the
 * open water when its project is the inbox, and to a folder when its project
 * is one of `folderIds`; a to-do of any other project (an archived folder, a
 * project the list no longer returns) is not drawn.
 */
export function canvasTodos<T extends TodoSource>(
  tasks: readonly T[],
  input: {
    readonly inboxId: string | null;
    readonly folderIds: ReadonlySet<string>;
    readonly plannedIds: ReadonlySet<string>;
    readonly nowMs: number;
    readonly timeZone: string;
  },
): CanvasTodo<T>[] {
  const open = tasks.filter(
    (task) => task.status !== 'done' && (task.projectId === input.inboxId || input.folderIds.has(task.projectId)),
  );
  return byUrgency(open).map((task) => {
    const due = dueChipOf(task.dueAt, input.nowMs, input.timeZone);
    return {
      task,
      folderId: task.projectId === input.inboxId ? null : task.projectId,
      depth: depthOf(task.dueAt, input.nowMs),
      due,
      overdue: due?.kind === 'overdue',
      planned: input.plannedIds.has(task.id),
    };
  });
}
