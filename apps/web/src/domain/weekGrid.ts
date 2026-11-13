/**
 * 플래너 주 (HOLO-02): a run of days side by side over one time axis, and on
 * each day what is on it — approved blocks, every occurrence of every 약속,
 * and the deadlines of tasks that are not done — placed where it is on the
 * wall clock, with what overlaps set side by side.
 *
 * Pure. Civil dates are `YYYY-MM-DD`, instants are ISO strings, and every
 * wall-clock question is answered in the owner's IANA zone through
 * `localParts`. An item is placed by the wall clock, so it lines up with the
 * hour labels on a day that is 23 or 25 hours long; one that crosses midnight
 * is drawn once on each day it touches.
 */
import { dayEventDates, type MonthDayEventInput, type MonthDayLabel } from './monthGrid';
import { addDaysToDate, localParts, weekdayOfDate } from './time';

export type WeekItemKind = 'block' | 'commitment' | 'deadline';

/** The page starts at 06:00 unless something starts earlier, or the earlier hours are asked for. */
export const WEEK_GRID_FIRST_HOUR = 6;
/** The least an item is drawn tall, in minutes: a line of text has to fit. */
export const WEEK_GRID_MIN_MINUTES = 30;

const MINUTES_PER_DAY = 24 * 60;
const CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface WeekBlockInput {
  readonly id: string;
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: string;
  readonly locked?: boolean;
  readonly version?: number;
}

export interface WeekCommitmentInput {
  readonly id: string;
  readonly title: string;
  /** `google`: imported from Google Calendar; drawn the same, told apart in words. */
  readonly source?: string;
  readonly occurrences?: readonly { readonly startAt: string; readonly endAt: string }[];
}

export interface WeekTaskInput {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly projectId?: string;
  readonly dueAt?: string;
}

/** What the lock toggle of an approved block needs (composables/useBlockLock.ts). */
export interface WeekItemBlock {
  readonly id: string;
  readonly locked: boolean;
  readonly version: number;
  readonly status: string;
  readonly startAt: string;
}

export interface WeekItem {
  /** Unique in the grid: the same block on two days has two keys. */
  readonly key: string;
  readonly kind: WeekItemKind;
  /** `null`: the block's task is not in the task list (the view names it). */
  readonly title: string | null;
  /** The day column this piece is on. */
  readonly date: string;
  /** Where the piece is on this day's wall clock, in minutes since local midnight (`0 <= startMin < endMin <= 1440`; a deadline is a point: both are its minute). */
  readonly startMin: number;
  readonly endMin: number;
  /** Where it is drawn: at least WEEK_GRID_MIN_MINUTES tall, inside the day. */
  readonly top: number;
  readonly bottom: number;
  /** The whole item, not this day's piece. `endAt` is null for a deadline. */
  readonly startAt: string;
  readonly endAt: string | null;
  /** It began on an earlier day and runs into this one. */
  readonly continued: boolean;
  /** It runs on into the next day. */
  readonly continues: boolean;
  /** A finished block. */
  readonly done: boolean;
  readonly taskId: string | null;
  readonly projectId: string | null;
  readonly commitmentId: string | null;
  /** A 약속 imported from Google Calendar (read-only here). */
  readonly fromGoogle: boolean;
  /** The approved row of a block, for its lock toggle; null for the other kinds. */
  readonly block: WeekItemBlock | null;
  /** Side by side: this item's column among `lanes`, and how many columns it may take. */
  readonly lane: number;
  readonly lanes: number;
  readonly span: number;
}

export interface WeekDay {
  readonly date: string;
  /** Day of the month, 1..31. */
  readonly day: number;
  /** ISO weekday, Monday = 1. */
  readonly weekday: number;
  readonly today: boolean;
  readonly past: boolean;
  /** In time order (the order the keyboard walks them). */
  readonly items: readonly WeekItem[];
  readonly counts: Readonly<Record<WeekItemKind, number>>;
  /** All-day labels of the day (a holiday, a trip): never placed on the time axis. */
  readonly labels: readonly MonthDayLabel[];
}

export interface WeekGrid {
  readonly days: readonly WeekDay[];
  /** The hours on the page: `[startHour, endHour)`. */
  readonly startHour: number;
  readonly endHour: number;
  /** Something is drawn before 06:00 (so the early hours are on the page by themselves). */
  readonly hasEarly: boolean;
  /** No item on any day (labels do not count). */
  readonly empty: boolean;
  /** Where "now" is, when today is one of the days and now is on the page. */
  readonly now: { readonly date: string; readonly minutes: number } | null;
}

export interface WeekGridInput {
  /** The first day (a Monday for the week view; any day for a single day). */
  readonly start: string;
  /** How many days from `start` (7 by default). */
  readonly days?: number;
  readonly timeZone: string;
  /** The owner's current civil date in `timeZone`. */
  readonly today: string;
  readonly nowMs: number;
  readonly blocks: readonly WeekBlockInput[];
  readonly commitments: readonly WeekCommitmentInput[];
  readonly tasks: readonly WeekTaskInput[];
  readonly dayEvents?: readonly MonthDayEventInput[];
  /** Show the hours before 06:00 whether or not anything is there. */
  readonly showEarly?: boolean;
}

/** Blocks that still describe time on the page; skipped, moved and superseded rows do not. */
const SHOWN_BLOCK_STATUSES: ReadonlySet<string> = new Set(['planned', 'done']);
const KIND_ORDER: Readonly<Record<WeekItemKind, number>> = { commitment: 0, block: 1, deadline: 2 };

function instantMs(value: string): number {
  return CIVIL_DATE.test(value) ? Number.NaN : Date.parse(value);
}

interface Piece {
  readonly date: string;
  readonly startMin: number;
  readonly endMin: number;
  readonly continued: boolean;
  readonly continues: boolean;
}

/**
 * The pieces a span `[startAt, endAt)` leaves on the days `firstDate..lastDate`,
 * one per day it touches. An end at exactly midnight does not touch the next
 * day. On a day the clock is set back, an end that reads earlier than its
 * start (the repeated hour) is drawn as long as it really lasts.
 */
export function spanPieces(startAt: string, endAt: string, timeZone: string, firstDate: string, lastDate: string): Piece[] {
  const startMs = instantMs(startAt);
  const endMs = instantMs(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const start = localParts(startAt, timeZone);
  const end = localParts(endAt, timeZone);
  const lastTouched = end.minutes === 0 && end.date > start.date ? addDaysToDate(end.date, -1) : end.date;
  const pieces: Piece[] = [];
  let date = start.date < firstDate ? firstDate : start.date;
  const until = lastTouched > lastDate ? lastDate : lastTouched;
  while (date <= until) {
    const startMin = date === start.date ? start.minutes : 0;
    let endMin = date === end.date ? end.minutes : MINUTES_PER_DAY;
    if (endMin <= startMin) {
      const lasting = Math.max(1, Math.round((endMs - startMs) / 60_000));
      endMin = Math.min(MINUTES_PER_DAY, startMin + lasting);
    }
    if (endMin > startMin) {
      pieces.push({
        date,
        startMin,
        endMin,
        continued: date !== start.date,
        continues: date !== lastTouched,
      });
    }
    date = addDaysToDate(date, 1);
  }
  return pieces;
}

/** Where a piece is drawn: never shorter than the floor, never past the day's end. */
function drawnExtent(startMin: number, endMin: number): { top: number; bottom: number } {
  const bottom = Math.min(MINUTES_PER_DAY, Math.max(endMin, startMin + WEEK_GRID_MIN_MINUTES));
  const top = Math.min(startMin, bottom - WEEK_GRID_MIN_MINUTES);
  return { top: Math.max(0, top), bottom };
}

type Unplaced = Omit<WeekItem, 'lane' | 'lanes' | 'span'>;

/** Time order; at the same minute a continued item first, then 약속, 블록, 마감; then the longer one; then by title. */
export function compareWeekItems(left: Unplaced, right: Unplaced): number {
  if (left.top !== right.top) return left.top - right.top;
  if (left.continued !== right.continued) return left.continued ? -1 : 1;
  if (left.kind !== right.kind) return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  if (left.bottom !== right.bottom) return right.bottom - left.bottom;
  const byTitle = (left.title ?? '').localeCompare(right.title ?? '', 'ko');
  if (byTitle !== 0) return byTitle;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function overlaps(left: { top: number; bottom: number }, right: { top: number; bottom: number }): boolean {
  return left.top < right.bottom && right.top < left.bottom;
}

/**
 * Set what overlaps side by side. Items that touch each other (directly or
 * through a third) form a group that shares one number of columns; each item
 * takes the first column that is free for it, and widens over the columns to
 * its right that nothing of its own time is in.
 */
export function placeInLanes(items: readonly Unplaced[]): WeekItem[] {
  const sorted = [...items].sort(compareWeekItems);
  const placed: WeekItem[] = [];
  let group: { item: Unplaced; lane: number }[] = [];
  let groupBottom = -1;

  const flush = (): void => {
    if (group.length === 0) return;
    const lanes = group.reduce((max, entry) => Math.max(max, entry.lane + 1), 1);
    for (const entry of group) {
      let span = 1;
      for (let lane = entry.lane + 1; lane < lanes; lane += 1) {
        if (group.some((other) => other.lane === lane && overlaps(other.item, entry.item))) break;
        span += 1;
      }
      placed.push({ ...entry.item, lane: entry.lane, lanes, span });
    }
    group = [];
    groupBottom = -1;
  };

  for (const item of sorted) {
    if (item.top >= groupBottom) flush();
    let lane = 0;
    while (group.some((entry) => entry.lane === lane && overlaps(entry.item, item))) lane += 1;
    group.push({ item, lane });
    groupBottom = Math.max(groupBottom, item.bottom);
  }
  flush();
  return placed.sort(compareWeekItems);
}

/** Lay the three lists out on the days from `start`. */
export function buildWeekGrid(input: WeekGridInput): WeekGrid {
  const count = Math.max(1, Math.floor(input.days ?? 7));
  const dates = Array.from({ length: count }, (_, index) => addDaysToDate(input.start, index));
  const firstDate = dates[0] ?? input.start;
  const lastDate = dates[dates.length - 1] ?? firstDate;
  const byDate = new Map<string, Unplaced[]>(dates.map((date) => [date, []]));
  const add = (item: Unplaced): void => {
    byDate.get(item.date)?.push(item);
  };

  const tasks = new Map(input.tasks.map((task) => [task.id, task]));

  for (const block of input.blocks) {
    if (!SHOWN_BLOCK_STATUSES.has(block.status)) continue;
    const task = tasks.get(block.taskId);
    for (const piece of spanPieces(block.startAt, block.endAt, input.timeZone, firstDate, lastDate)) {
      add({
        key: `block:${block.id}@${piece.date}`,
        kind: 'block',
        title: task?.title ?? null,
        ...piece,
        ...drawnExtent(piece.startMin, piece.endMin),
        startAt: block.startAt,
        endAt: block.endAt,
        done: block.status === 'done',
        taskId: block.taskId,
        projectId: task?.projectId ?? null,
        commitmentId: null,
        fromGoogle: false,
        block: {
          id: block.id,
          locked: block.locked ?? false,
          version: block.version ?? 0,
          status: block.status,
          startAt: block.startAt,
        },
      });
    }
  }

  for (const commitment of input.commitments) {
    for (const occurrence of commitment.occurrences ?? []) {
      for (const piece of spanPieces(occurrence.startAt, occurrence.endAt, input.timeZone, firstDate, lastDate)) {
        add({
          key: `commitment:${commitment.id}:${occurrence.startAt}@${piece.date}`,
          kind: 'commitment',
          title: commitment.title,
          ...piece,
          ...drawnExtent(piece.startMin, piece.endMin),
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
          done: false,
          taskId: null,
          projectId: null,
          commitmentId: commitment.id,
          fromGoogle: commitment.source === 'google',
          block: null,
        });
      }
    }
  }

  for (const task of input.tasks) {
    if (task.status === 'done' || task.dueAt === undefined) continue;
    if (!Number.isFinite(instantMs(task.dueAt))) continue;
    const due = localParts(task.dueAt, input.timeZone);
    if (due.date < firstDate || due.date > lastDate) continue;
    add({
      key: `deadline:${task.id}@${due.date}`,
      kind: 'deadline',
      title: task.title,
      date: due.date,
      startMin: due.minutes,
      endMin: due.minutes,
      ...drawnExtent(due.minutes, due.minutes),
      startAt: task.dueAt,
      endAt: null,
      continued: false,
      continues: false,
      done: false,
      taskId: task.id,
      projectId: task.projectId ?? null,
      commitmentId: null,
      fromGoogle: false,
      block: null,
    });
  }

  const labelsByDate = new Map<string, MonthDayLabel[]>();
  for (const event of input.dayEvents ?? []) {
    const lastDay = addDaysToDate(event.endDate, -1);
    for (const date of dayEventDates(event, firstDate, lastDate)) {
      const label: MonthDayLabel = {
        key: `day:${event.id}`,
        title: event.title,
        calendarName: event.calendarName,
        firstDate: event.startDate,
        lastDate: lastDay,
        multiDay: lastDay > event.startDate,
      };
      const list = labelsByDate.get(date);
      if (list === undefined) labelsByDate.set(date, [label]);
      else list.push(label);
    }
  }

  let empty = true;
  let earliest = MINUTES_PER_DAY;
  const days = dates.map((date): WeekDay => {
    const items = placeInLanes(byDate.get(date) ?? []);
    const counts: Record<WeekItemKind, number> = { block: 0, commitment: 0, deadline: 0 };
    for (const item of items) {
      counts[item.kind] += 1;
      earliest = Math.min(earliest, item.top);
    }
    if (items.length > 0) empty = false;
    return {
      date,
      day: Number(date.slice(8, 10)),
      weekday: weekdayOfDate(date),
      today: date === input.today,
      past: date < input.today,
      items,
      counts,
      labels: (labelsByDate.get(date) ?? []).sort(
        (left, right) => left.firstDate.localeCompare(right.firstDate) || left.title.localeCompare(right.title, 'ko'),
      ),
    };
  });

  const hasEarly = earliest < WEEK_GRID_FIRST_HOUR * 60;
  const startHour = input.showEarly === true ? 0 : Math.min(WEEK_GRID_FIRST_HOUR, Math.floor(earliest / 60));

  let now: WeekGrid['now'] = null;
  if (Number.isFinite(input.nowMs) && dates.includes(input.today)) {
    const parts = localParts(new Date(input.nowMs).toISOString(), input.timeZone);
    if (parts.date === input.today && parts.minutes >= startHour * 60) now = { date: parts.date, minutes: parts.minutes };
  }

  return { days, startHour, endHour: 24, hasEarly, empty, now };
}

/** Keys that move the grid's focus. */
export type WeekGridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End';

const GRID_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);

export function isWeekGridKey(key: string): key is WeekGridKey {
  return GRID_KEYS.has(key);
}

/**
 * Where focus goes from the item `key`: up and down walk the day's items in
 * time order (its slots), Home and End go to the day's first and last, left
 * and right go to the nearest day on that side that holds anything, landing
 * on the item whose start is closest. Null: there is nowhere to go (the edge
 * of the day or of the grid), and focus stays.
 */
export function itemAfterKey(days: readonly WeekDay[], key: string, pressed: WeekGridKey): string | null {
  const dayIndex = days.findIndex((day) => day.items.some((item) => item.key === key));
  const day = days[dayIndex];
  if (day === undefined) return null;
  const index = day.items.findIndex((item) => item.key === key);
  const current = day.items[index];
  if (current === undefined) return null;
  switch (pressed) {
    case 'ArrowUp':
      return day.items[index - 1]?.key ?? null;
    case 'ArrowDown':
      return day.items[index + 1]?.key ?? null;
    case 'Home':
      return index === 0 ? null : (day.items[0]?.key ?? null);
    case 'End':
      return index === day.items.length - 1 ? null : (day.items[day.items.length - 1]?.key ?? null);
    case 'ArrowLeft':
    case 'ArrowRight': {
      const step = pressed === 'ArrowLeft' ? -1 : 1;
      for (let at = dayIndex + step; at >= 0 && at < days.length; at += step) {
        const items = days[at]?.items ?? [];
        if (items.length === 0) continue;
        let best = items[0];
        for (const item of items) {
          if (best === undefined || Math.abs(item.startMin - current.startMin) < Math.abs(best.startMin - current.startMin)) {
            best = item;
          }
        }
        return best?.key ?? null;
      }
      return null;
    }
  }
}

/**
 * The item the grid's one tab stop starts on: today's next item that has not
 * ended (else today's last), else the first item of the first day that has one.
 */
export function initialItemKey(grid: WeekGrid): string | null {
  const today = grid.days.find((day) => day.today);
  if (today !== undefined && today.items.length > 0) {
    const nowMin = grid.now?.minutes ?? 0;
    const upcoming = today.items.find((item) => item.bottom > nowMin);
    return (upcoming ?? today.items[today.items.length - 1])?.key ?? null;
  }
  for (const day of grid.days) {
    const first = day.items[0];
    if (first !== undefined) return first.key;
  }
  return null;
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface CardPlacement {
  readonly left: number;
  readonly top: number;
  /** Which side of its anchor the card stands on. */
  readonly side: 'right' | 'left' | 'below' | 'above';
}

/**
 * Where a floating card of `card` size stands so it is anchored to `anchor`
 * and stays inside `frame` (all three in the same coordinates): to the right
 * of its anchor when it fits, else to the left, else under it, else over it;
 * then slid along the other axis until it is inside the frame.
 */
export function placeCard(anchor: Rect, card: { width: number; height: number }, frame: Rect, gap = 8): CardPlacement {
  const frameRight = frame.left + frame.width;
  const frameBottom = frame.top + frame.height;
  const clampX = (left: number): number => Math.max(frame.left + gap, Math.min(left, frameRight - card.width - gap));
  const clampY = (top: number): number => Math.max(frame.top + gap, Math.min(top, frameBottom - card.height - gap));

  const right = anchor.left + anchor.width + gap;
  if (right + card.width + gap <= frameRight) return { left: right, top: clampY(anchor.top), side: 'right' };
  const left = anchor.left - gap - card.width;
  if (left >= frame.left + gap) return { left, top: clampY(anchor.top), side: 'left' };
  const below = anchor.top + anchor.height + gap;
  if (below + card.height + gap <= frameBottom) return { left: clampX(anchor.left), top: below, side: 'below' };
  const above = anchor.top - gap - card.height;
  if (above >= frame.top + gap) return { left: clampX(anchor.left), top: above, side: 'above' };
  // Nowhere fits whole: under the anchor, as far inside the frame as it goes.
  return { left: clampX(anchor.left), top: Math.max(frame.top + gap, Math.min(below, frameBottom - card.height - gap)), side: 'below' };
}
