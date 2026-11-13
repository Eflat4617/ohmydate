/**
 * The month page of the planner: one row per week that touches the month
 * (Monday first, as on the availability grid), and in each day what is on it
 * in time order — approved blocks, every occurrence of every 약속, and the
 * deadlines of tasks that are not done.
 *
 * Pure. Civil dates are `YYYY-MM-DD`, a month is `YYYY-MM`, instants are ISO
 * strings, and every wall-clock question is answered in the owner's IANA zone
 * through `localParts`, so a block at 23:30–00:30 or an occurrence near
 * midnight lands on the day the owner sees on the wall.
 */
import { addDaysToDate, localParts, startOfWeek, weekdayOfDate, zonedWallClockToInstant } from './time';

/** `YYYY-MM`. */
export type MonthKey = string;

export type MonthItemKind = 'block' | 'commitment' | 'deadline';

/** Kinds in the order they are counted and named (블록, 약속, 마감). */
export const MONTH_ITEM_KINDS: readonly MonthItemKind[] = ['block', 'commitment', 'deadline'];

/** Lines a day cell holds before the rest folds into "+N개". */
export const MONTH_CELL_LINES = 4;

const MONTH_KEY = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A month from the URL (`?m=2026-11`), or `null` when it is not one. */
export function parseMonthKey(value: unknown): MonthKey | null {
  if (typeof value !== 'string') return null;
  const match = MONTH_KEY.exec(value);
  if (match === null) return null;
  return Number(match[1]) >= 1000 ? value : null;
}

/** The month a civil date belongs to. */
export function monthOfDate(date: string): MonthKey {
  return date.slice(0, 7);
}

function monthParts(month: MonthKey): { year: number; month: number } {
  const match = MONTH_KEY.exec(month);
  if (match === null) throw new RangeError(`Invalid month: ${month}`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

function monthFromIndex(index: number): MonthKey {
  const year = Math.floor(index / 12);
  const month = index - year * 12 + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/** The month `delta` months after `month` (negative: before). */
export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const parts = monthParts(month);
  return monthFromIndex(parts.year * 12 + (parts.month - 1) + delta);
}

export function firstDateOfMonth(month: MonthKey): string {
  monthParts(month);
  return `${month}-01`;
}

export function daysInMonth(month: MonthKey): number {
  const parts = monthParts(month);
  return new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
}

/** The same day of the month in another month, clamped to its last day (31 → 30). */
export function sameDayInMonth(date: string, month: MonthKey): string {
  const day = Number(date.slice(8, 10));
  const clamped = Math.min(Math.max(1, Number.isFinite(day) ? day : 1), daysInMonth(month));
  return `${month}-${String(clamped).padStart(2, '0')}`;
}

/**
 * Monday-first weeks that touch the month: 4 rows (a February that starts on
 * a Monday in a common year), usually 5, at most 6. Days of the neighbouring
 * months fill the first and last rows.
 */
export function monthWeeks(month: MonthKey): string[][] {
  const first = firstDateOfMonth(month);
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const weeks: string[][] = [];
  for (let start = startOfWeek(first); start <= last; start = addDaysToDate(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDaysToDate(start, index)));
  }
  return weeks;
}

/** The instants that bound the visible grid (first Monday 00:00 to the day after the last Sunday). */
export function monthGridRange(month: MonthKey, timeZone: string): { from: string; to: string } {
  const weeks = monthWeeks(month);
  const first = weeks[0]?.[0] ?? firstDateOfMonth(month);
  const lastWeek = weeks[weeks.length - 1] ?? [];
  const last = lastWeek[lastWeek.length - 1] ?? first;
  return {
    from: zonedWallClockToInstant(first, 0, timeZone),
    to: zonedWallClockToInstant(addDaysToDate(last, 1), 0, timeZone),
  };
}

export interface MonthBlockInput {
  readonly id: string;
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: string;
}

export interface MonthCommitmentInput {
  readonly id: string;
  readonly title: string;
  /** `google`: imported from Google Calendar (CAL-03); drawn the same, told apart in words. */
  readonly source?: string;
  readonly occurrences?: readonly { readonly commitmentId: string; readonly startAt: string; readonly endAt: string }[];
}

/** CAL-04: an all-day event imported from Google (`GET /calendar-day-events`). */
export interface MonthDayEventInput {
  readonly id: string;
  readonly title: string;
  /** First day, `YYYY-MM-DD`. */
  readonly startDate: string;
  /** The day after the last one (exclusive, as Google's all-day `end.date`). */
  readonly endDate: string;
  readonly calendarName: string | null;
}

/**
 * A plain label at the top of a day (a holiday, a trip). It is not a block or
 * a 약속: it takes no time, is not counted and does not make a day busy.
 */
export interface MonthDayLabel {
  /** Unique within a day. */
  readonly key: string;
  readonly title: string;
  readonly calendarName: string | null;
  readonly firstDate: string;
  /** Inclusive. */
  readonly lastDate: string;
  readonly multiDay: boolean;
}

export interface MonthTaskInput {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly dueAt?: string;
}

export interface MonthItem {
  /** Unique within a day. */
  readonly key: string;
  readonly kind: MonthItemKind;
  /** `null`: the block's task is not in the task list (the view names it). */
  readonly title: string | null;
  /** Where it starts on this day, in minutes since local midnight (0 when it began the day before). */
  readonly minutes: number;
  readonly startAt: string;
  /** `null` for a deadline, which is a point in time. */
  readonly endAt: string | null;
  /** It began on an earlier day and runs into this one. */
  readonly continued: boolean;
  /** A finished block. */
  readonly done: boolean;
  readonly taskId: string | null;
  readonly commitmentId: string | null;
  /** A 약속 imported from Google Calendar (read-only here). */
  readonly fromGoogle: boolean;
}

export interface MonthDay {
  readonly date: string;
  /** Day of the month, 1..31. */
  readonly day: number;
  /** ISO weekday, Monday = 1. */
  readonly weekday: number;
  readonly inMonth: boolean;
  readonly today: boolean;
  readonly past: boolean;
  readonly items: readonly MonthItem[];
  readonly counts: Readonly<Record<MonthItemKind, number>>;
  /** All-day labels of the day, in start order (never counted with the items). */
  readonly labels: readonly MonthDayLabel[];
}

export interface MonthGrid {
  readonly month: MonthKey;
  readonly weeks: readonly (readonly MonthDay[])[];
  /** Nothing at all on the month's own days (neighbouring days do not count). */
  readonly empty: boolean;
}

export interface MonthGridInput {
  readonly month: MonthKey;
  readonly timeZone: string;
  /** The owner's current civil date in `timeZone`. */
  readonly today: string;
  readonly blocks: readonly MonthBlockInput[];
  readonly commitments: readonly MonthCommitmentInput[];
  readonly tasks: readonly MonthTaskInput[];
  /** CAL-04: imported all-day events; absent when they could not be read. */
  readonly dayEvents?: readonly MonthDayEventInput[];
}

/** Blocks that still describe time on the page; skipped, moved and superseded rows do not. */
const SHOWN_BLOCK_STATUSES: ReadonlySet<string> = new Set(['planned', 'done']);
const KIND_ORDER: Readonly<Record<MonthItemKind, number>> = { commitment: 0, block: 1, deadline: 2 };

function instantMs(value: string): number {
  return CIVIL_DATE.test(value) ? Number.NaN : Date.parse(value);
}

/**
 * The days a span `[startAt, endAt)` touches in `timeZone`, with where it
 * starts on each: the first day at its start time, later days at midnight.
 * An end at exactly midnight does not touch the next day.
 */
function spanDays(
  startAt: string,
  endAt: string,
  timeZone: string,
  firstDate: string,
  lastDate: string,
): { date: string; minutes: number; continued: boolean }[] {
  const startMs = instantMs(startAt);
  const endMs = instantMs(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
  const start = localParts(startAt, timeZone);
  const end = localParts(endAt, timeZone);
  const lastTouched = end.minutes === 0 && end.date > start.date ? addDaysToDate(end.date, -1) : end.date;
  const days: { date: string; minutes: number; continued: boolean }[] = [];
  let date = start.date < firstDate ? firstDate : start.date;
  const until = lastTouched > lastDate ? lastDate : lastTouched;
  while (date <= until) {
    days.push({ date, minutes: date === start.date ? start.minutes : 0, continued: date !== start.date });
    date = addDaysToDate(date, 1);
  }
  return days;
}

/**
 * The days of the visible grid an all-day event covers: `startDate` up to the
 * day before `endDate` (exclusive), clipped to `firstDate..lastDate`. A
 * malformed or empty span covers nothing.
 */
export function dayEventDates(
  event: { readonly startDate: string; readonly endDate: string },
  firstDate: string,
  lastDate: string,
): string[] {
  if (!CIVIL_DATE.test(event.startDate) || !CIVIL_DATE.test(event.endDate) || event.endDate <= event.startDate) return [];
  const dates: string[] = [];
  let date = event.startDate < firstDate ? firstDate : event.startDate;
  const last = addDaysToDate(event.endDate, -1);
  const until = last > lastDate ? lastDate : last;
  while (date <= until) {
    dates.push(date);
    date = addDaysToDate(date, 1);
  }
  return dates;
}

/** Time order; at the same minute a continued item first, then 약속, 블록, 마감; then by title. */
export function compareMonthItems(left: MonthItem, right: MonthItem): number {
  if (left.minutes !== right.minutes) return left.minutes - right.minutes;
  if (left.continued !== right.continued) return left.continued ? -1 : 1;
  if (left.kind !== right.kind) return KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  const byTitle = (left.title ?? '').localeCompare(right.title ?? '', 'ko');
  if (byTitle !== 0) return byTitle;
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

/** Lay the three lists out on the month's grid. */
export function buildMonthGrid(input: MonthGridInput): MonthGrid {
  const weeks = monthWeeks(input.month);
  const firstDate = weeks[0]?.[0] ?? firstDateOfMonth(input.month);
  const lastWeek = weeks[weeks.length - 1] ?? [];
  const lastDate = lastWeek[lastWeek.length - 1] ?? firstDate;
  const byDate = new Map<string, MonthItem[]>();
  const add = (date: string, item: MonthItem): void => {
    const list = byDate.get(date);
    if (list === undefined) byDate.set(date, [item]);
    else list.push(item);
  };

  const titles = new Map(input.tasks.map((task) => [task.id, task.title]));
  for (const block of input.blocks) {
    if (!SHOWN_BLOCK_STATUSES.has(block.status)) continue;
    for (const day of spanDays(block.startAt, block.endAt, input.timeZone, firstDate, lastDate)) {
      add(day.date, {
        key: `block:${block.id}`,
        kind: 'block',
        title: titles.get(block.taskId) ?? null,
        minutes: day.minutes,
        startAt: block.startAt,
        endAt: block.endAt,
        continued: day.continued,
        done: block.status === 'done',
        taskId: block.taskId,
        commitmentId: null,
        fromGoogle: false,
      });
    }
  }

  // Every source is drawn the same way (a later Google import included).
  for (const commitment of input.commitments) {
    for (const occurrence of commitment.occurrences ?? []) {
      for (const day of spanDays(occurrence.startAt, occurrence.endAt, input.timeZone, firstDate, lastDate)) {
        add(day.date, {
          key: `commitment:${commitment.id}:${occurrence.startAt}`,
          kind: 'commitment',
          title: commitment.title,
          minutes: day.minutes,
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
          continued: day.continued,
          done: false,
          taskId: null,
          commitmentId: commitment.id,
          fromGoogle: commitment.source === 'google',
        });
      }
    }
  }

  for (const task of input.tasks) {
    if (task.status === 'done' || task.dueAt === undefined) continue;
    if (!Number.isFinite(instantMs(task.dueAt))) continue;
    const due = localParts(task.dueAt, input.timeZone);
    if (due.date < firstDate || due.date > lastDate) continue;
    add(due.date, {
      key: `deadline:${task.id}`,
      kind: 'deadline',
      title: task.title,
      minutes: due.minutes,
      startAt: task.dueAt,
      endAt: null,
      continued: false,
      done: false,
      taskId: task.id,
      commitmentId: null,
      fromGoogle: false,
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
  const grid = weeks.map((week) =>
    week.map((date): MonthDay => {
      const items = (byDate.get(date) ?? []).sort(compareMonthItems);
      const counts: Record<MonthItemKind, number> = { block: 0, commitment: 0, deadline: 0 };
      for (const item of items) counts[item.kind] += 1;
      const inMonth = monthOfDate(date) === input.month;
      if (inMonth && items.length > 0) empty = false;
      return {
        date,
        day: Number(date.slice(8, 10)),
        weekday: weekdayOfDate(date),
        inMonth,
        today: date === input.today,
        past: date < input.today,
        items,
        counts,
        labels: (labelsByDate.get(date) ?? []).sort(
          (left, right) => left.firstDate.localeCompare(right.firstDate) || left.title.localeCompare(right.title, 'ko'),
        ),
      };
    }),
  );
  return { month: input.month, weeks: grid, empty };
}

/**
 * What a cell shows: every item when they fit in `lines`, otherwise one line
 * fewer and a "+N개" line for the rest.
 */
export function cellOverflow<T>(items: readonly T[], lines: number = MONTH_CELL_LINES): { shown: readonly T[]; hidden: number } {
  const room = Math.max(1, Math.floor(lines));
  if (items.length <= room) return { shown: items, hidden: 0 };
  const shown = items.slice(0, room - 1);
  return { shown, hidden: items.length - shown.length };
}

/** Keys that move the grid's focus. */
export type MonthGridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'PageUp' | 'PageDown';

const GRID_KEYS: ReadonlySet<string> = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

export function isMonthGridKey(key: string): key is MonthGridKey {
  return GRID_KEYS.has(key);
}

/**
 * Where focus goes from `date`: arrows move a day or a week, Home and End go
 * to the ends of the week (Monday, Sunday), PageUp and PageDown to the same
 * day of the previous or next month.
 */
export function dateAfterKey(date: string, key: MonthGridKey): string {
  switch (key) {
    case 'ArrowLeft':
      return addDaysToDate(date, -1);
    case 'ArrowRight':
      return addDaysToDate(date, 1);
    case 'ArrowUp':
      return addDaysToDate(date, -7);
    case 'ArrowDown':
      return addDaysToDate(date, 7);
    case 'Home':
      return startOfWeek(date);
    case 'End':
      return addDaysToDate(startOfWeek(date), 6);
    case 'PageUp':
      return sameDayInMonth(date, shiftMonth(monthOfDate(date), -1));
    case 'PageDown':
      return sameDayInMonth(date, shiftMonth(monthOfDate(date), 1));
  }
}
