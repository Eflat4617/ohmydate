/**
 * 플래너 (HOLO-02): which view and which stretch of time an address means,
 * and the address of a view and a date. Pure.
 *
 *   /planner                      this week (주 is the default view; a phone that
 *                                 arrives here is sent on to its day, `plannerPhoneEntry`)
 *   /planner?w=2026-11-16         the week that starts on that Monday
 *   /planner?view=day&d=…         one day (without `d`: today)
 *   /planner?view=month&m=2026-12 a month (without `m`: this month)
 *   /planner?view=list&w=…        the 약속 of a week, as a list (HOLO-04; was the 약속 screen)
 *   /month, /month?m=2026-12      the month view, as before (CAL-01)
 *
 * What is the default is left out of the query, so today's address stays short.
 */
import { monthOfDate, parseMonthKey, type MonthKey } from './monthGrid';
import { startOfWeek } from './time';

export type PlannerViewKind = 'day' | 'week' | 'month' | 'list';

export const PLANNER_VIEWS: readonly PlannerViewKind[] = ['day', 'week', 'month', 'list'];
export const DEFAULT_PLANNER_VIEW: PlannerViewKind = 'week';

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real civil date from the URL (`2026-11-14`), or null (`2026-02-30`, `x`, a list). */
export function parseCivilDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CIVIL_DATE.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1000) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return value;
}

/** The `view` of a query, or null when it names none. */
export function parsePlannerView(value: unknown): PlannerViewKind | null {
  return typeof value === 'string' && (PLANNER_VIEWS as readonly string[]).includes(value)
    ? (value as PlannerViewKind)
    : null;
}

type Query = Readonly<Record<string, unknown>>;

/** `/month` is always the month view; `/planner` reads `view` and falls back to 주. */
export function plannerViewOf(routeName: unknown, query: Query): PlannerViewKind {
  if (routeName === 'month') return 'month';
  return parsePlannerView(query['view']) ?? DEFAULT_PLANNER_VIEW;
}

/** The day `?d=` means; today without it (or with a date that is none). */
export function plannerDayOf(query: Query, today: string): string {
  return parseCivilDate(query['d']) ?? today;
}

/** The Monday of the week `?w=` means (any day of the week will do); this week without it. */
export function plannerWeekOf(query: Query, today: string): string {
  return startOfWeek(parseCivilDate(query['w']) ?? today);
}

/** The month `?m=` means; this month without it. */
export function plannerMonthOf(query: Query, today: string): MonthKey {
  return parseMonthKey(query['m']) ?? monthOfDate(today);
}

export interface PlannerLocation {
  readonly name: 'planner' | 'month';
  readonly query: Readonly<Record<string, string>>;
}

/**
 * The address of `view` around `anchor` (a civil date: the day itself, any
 * day of the week, any day of the month). On the `/month` address the month
 * view stays there; everything else lives under `/planner`.
 */
export function plannerLocation(
  view: PlannerViewKind,
  anchor: string,
  today: string,
  routeName: unknown = 'planner',
): PlannerLocation {
  if (view === 'month') {
    const month = monthOfDate(anchor);
    const query: Record<string, string> = month === monthOfDate(today) ? {} : { m: month };
    if (routeName === 'month') return { name: 'month', query };
    return { name: 'planner', query: { view: 'month', ...query } };
  }
  if (view === 'day') {
    return { name: 'planner', query: { view: 'day', ...(anchor === today ? {} : { d: anchor }) } };
  }
  const week = startOfWeek(anchor);
  const weekQuery: Record<string, string> = week === startOfWeek(today) ? {} : { w: week };
  if (view === 'list') return { name: 'planner', query: { view: 'list', ...weekQuery } };
  return { name: 'planner', query: weekQuery };
}

/** Below this a week is seven columns of forty pixels: the phone's width (DESIGN.md, Layout). */
export const PLANNER_PHONE_QUERY = '(max-width: 639.98px)';

/**
 * HOLO-07: a phone that arrives at 플래너 without asking for a view gets the
 * day — one column a thumb can read and press — not the week. Where to go
 * instead, or null to go where the address says.
 *
 * Only an arrival: inside the planner (`from` is the planner or its `/month`)
 * the address means what it always meant, so 주 in the view switch still
 * opens the week on a phone. And only the bare address: one that names a
 * view, or a week (`w`), was asked for and is honoured.
 */
export function plannerPhoneEntry<Q extends Query>(
  to: { readonly name?: unknown; readonly query: Q },
  from: { readonly name?: unknown },
  phone: boolean,
): { readonly name: 'planner'; readonly query: Q & { readonly view: 'day' } } | null {
  if (!phone || to.name !== 'planner') return null;
  if (from.name === 'planner' || from.name === 'month') return null;
  if (to.query['view'] !== undefined || to.query['w'] !== undefined) return null;
  return { name: 'planner', query: { ...to.query, view: 'day' } };
}

export interface PlannerQueryFix {
  /** Keys to take out of the query. */
  readonly drop: readonly string[];
  /** Keys to write (a `w` moved to its Monday). */
  readonly set: Readonly<Record<string, string>>;
}

/**
 * What is wrong with the query of the current address, or null when nothing
 * is: a `view` that names none, a `d` / `w` / `m` that is no date or month,
 * a `w` that is not a Monday. The screen corrects it once (a replace, not a
 * new history entry), so an address typed wrong does not stay in the bar. A
 * key the current view does not read is left alone.
 */
export function plannerQueryFix(routeName: unknown, query: Query): PlannerQueryFix | null {
  const drop: string[] = [];
  const set: Record<string, string> = {};
  if (routeName !== 'month' && query['view'] !== undefined && parsePlannerView(query['view']) === null) drop.push('view');
  const view = plannerViewOf(routeName, query);
  if (view === 'day' && query['d'] !== undefined && parseCivilDate(query['d']) === null) drop.push('d');
  if ((view === 'week' || view === 'list') && query['w'] !== undefined) {
    const date = parseCivilDate(query['w']);
    if (date === null) drop.push('w');
    else if (startOfWeek(date) !== date) set['w'] = startOfWeek(date);
  }
  if (view === 'month' && query['m'] !== undefined && parseMonthKey(query['m']) === null) drop.push('m');
  return drop.length === 0 && Object.keys(set).length === 0 ? null : { drop, set };
}
