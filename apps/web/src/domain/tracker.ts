/**
 * 타임 트래커 (HOLO-02): what the screen shows is computed here from what
 * the API already returns — the week's focus sessions as rows, filtered,
 * grouped by day with a subtotal each, and the list the task picker offers.
 * Pure: "now" and the owner's time zone are always passed in.
 */
import { sessionFocusedSec, type OverviewSession } from './overview';
import { localDateOf } from './time';

export type SessionState = OverviewSession['state'];

/** The states in the order the filter lists them. */
export const SESSION_STATES: readonly SessionState[] = ['active', 'paused', 'completed', 'abandoned'];

export interface TrackerTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly projectId: string;
}

export interface TrackerRow {
  readonly id: string;
  readonly taskId: string;
  /** `null`: the session's task is not in the task list any more. */
  readonly title: string | null;
  readonly projectId: string | null;
  /** The local day it started on (`YYYY-MM-DD`): the day it is counted on. */
  readonly date: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /** Focused seconds as of now (a running session keeps counting). */
  readonly focusedSec: number;
  readonly state: SessionState;
}

/** The sessions as rows, newest first. One with an unreadable start is left out. */
export function trackerRows(
  sessions: readonly OverviewSession[],
  tasks: ReadonlyMap<string, TrackerTask>,
  timeZone: string,
  nowMs: number,
): TrackerRow[] {
  return sessions
    .filter((session) => Number.isFinite(Date.parse(session.startedAt)))
    .map((session): TrackerRow => {
      const task = tasks.get(session.taskId);
      return {
        id: session.id,
        taskId: session.taskId,
        title: task?.title ?? null,
        projectId: task?.projectId ?? null,
        date: localDateOf(session.startedAt, timeZone),
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
        focusedSec: sessionFocusedSec(session, nowMs),
        state: session.state,
      };
    })
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export interface TrackerFilter {
  /** A project id, or `all`. */
  readonly project: string;
  /** A session state, or `all`. */
  readonly state: SessionState | 'all';
}

export const NO_FILTER: TrackerFilter = { project: 'all', state: 'all' };

export function isFiltered(filter: TrackerFilter): boolean {
  return filter.project !== 'all' || filter.state !== 'all';
}

/** The rows a filter lets through (a row whose task is gone belongs to no project). */
export function filterRows(rows: readonly TrackerRow[], filter: TrackerFilter): TrackerRow[] {
  return rows.filter(
    (row) =>
      (filter.project === 'all' || row.projectId === filter.project) &&
      (filter.state === 'all' || row.state === filter.state),
  );
}

export function focusedTotal(rows: readonly TrackerRow[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.focusedSec), 0);
}

export interface TrackerDay {
  readonly date: string;
  readonly rows: readonly TrackerRow[];
  /** The day's subtotal, in focused seconds. */
  readonly focusedSec: number;
}

/** The rows by the day they started on, newest day first; inside a day, newest first. */
export function groupByDay(rows: readonly TrackerRow[]): TrackerDay[] {
  const byDate = new Map<string, TrackerRow[]>();
  for (const row of rows) {
    const list = byDate.get(row.date);
    if (list === undefined) byDate.set(row.date, [row]);
    else list.push(row);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => (left < right ? 1 : left > right ? -1 : 0))
    .map(([date, list]) => ({ date, rows: list, focusedSec: focusedTotal(list) }));
}

/** The projects the rows belong to, each once, in the order given by `order` (ids not in it go last). */
export function projectsOf(rows: readonly TrackerRow[], order: readonly string[]): string[] {
  const present = new Set(rows.flatMap((row) => (row.projectId === null ? [] : [row.projectId])));
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...present].sort((left, right) => (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length));
}

/** How many options the picker lists before it asks for a narrower search. */
export const PICKER_LIMIT = 8;

function folded(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('ko').replace(/\s+/g, ' ').trim();
}

export interface PickerResult {
  readonly options: readonly TrackerTask[];
  /** Open tasks that match but are not listed. */
  readonly more: number;
}

/**
 * What the task picker offers for `query`: the open tasks (not done) whose
 * title holds every word typed, the task of the next block first, then by
 * title. An empty query lists them all (up to the limit).
 */
export function pickerOptions(
  tasks: readonly TrackerTask[],
  query: string,
  nextTaskId: string | null = null,
  limit: number = PICKER_LIMIT,
): PickerResult {
  const words = folded(query).split(' ').filter((word) => word.length > 0);
  const matches = tasks
    .filter((task) => task.status !== 'done')
    .filter((task) => {
      const title = folded(task.title);
      return words.every((word) => title.includes(word));
    })
    .sort((left, right) => {
      if ((left.id === nextTaskId) !== (right.id === nextTaskId)) return left.id === nextTaskId ? -1 : 1;
      return left.title.localeCompare(right.title, 'ko') || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    });
  const room = Math.max(1, Math.floor(limit));
  return { options: matches.slice(0, room), more: Math.max(0, matches.length - room) };
}

/** The task the picker starts on: the next planned block's, when it is still open. */
export function defaultPickerTask(
  nextBlockTaskId: string | null,
  tasks: ReadonlyMap<string, TrackerTask>,
): string | null {
  if (nextBlockTaskId === null) return null;
  const task = tasks.get(nextBlockTaskId);
  return task !== undefined && task.status !== 'done' ? task.id : null;
}
