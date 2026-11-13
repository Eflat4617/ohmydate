import { addDaysToDate, localDateOf, weekDates, zonedWallClockToInstant } from './time';

/**
 * 개요 (HOLO-01): every number on the dashboard is computed here, from what
 * the API already returns. Pure functions, no I/O, no clock of their own —
 * "now" and the owner's time zone are always passed in.
 */

/** The fields of a work session the dashboard reads. */
export interface OverviewSession {
  readonly id: string;
  readonly taskId: string;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly focusedSec: number;
  readonly pausedSec: number;
  readonly state: 'active' | 'paused' | 'completed' | 'abandoned';
}

export type GreetingPeriod = 'morning' | 'afternoon' | 'evening';

/** 05–11 is morning, 12–17 afternoon, everything else (18–04) evening. */
export function greetingPeriod(hour: number): GreetingPeriod {
  const whole = Number.isFinite(hour) ? Math.floor(hour) : 0;
  if (whole >= 5 && whole < 12) return 'morning';
  if (whole >= 12 && whole < 18) return 'afternoon';
  return 'evening';
}

/** The instants `[from, to)` of the seven local days that start on `weekStart`. */
export function weekRange(weekStart: string, timeZone: string): { from: string; to: string } {
  return {
    from: zonedWallClockToInstant(weekStart, 0, timeZone),
    to: zonedWallClockToInstant(addDaysToDate(weekStart, 7), 0, timeZone),
  };
}

/** The instants `[from, to)` of one local day. */
export function dayRange(date: string, timeZone: string): { from: string; to: string } {
  return {
    from: zonedWallClockToInstant(date, 0, timeZone),
    to: zonedWallClockToInstant(addDaysToDate(date, 1), 0, timeZone),
  };
}

/**
 * Focused seconds of a session as of `nowMs`. The server's `focusedSec` is
 * exact for a session that is paused or over; a running one has been focused
 * since its last event, which is `startedAt + focused + paused` (the same
 * arithmetic the Focus timer uses).
 */
export function sessionFocusedSec(session: OverviewSession, nowMs: number): number {
  const stored = Number.isFinite(session.focusedSec) ? Math.max(0, session.focusedSec) : 0;
  if (session.state !== 'active') return stored;
  const paused = Number.isFinite(session.pausedSec) ? Math.max(0, session.pausedSec) : 0;
  const started = Date.parse(session.startedAt);
  if (!Number.isFinite(started)) return stored;
  const cursorMs = started + (stored + paused) * 1000;
  return stored + Math.max(0, Math.floor((nowMs - cursorMs) / 1000));
}

/**
 * Focused seconds per local day, Monday to Sunday, for the week that starts on
 * `weekStart`. A session counts on the day it STARTED in the owner's zone
 * (its focus time is not split at midnight: the API reports one total per
 * session). Sessions outside the week, or with an unreadable start, are left
 * out.
 */
export function focusByDay(
  sessions: readonly OverviewSession[],
  weekStart: string,
  timeZone: string,
  nowMs: number,
): number[] {
  const days = weekDates(weekStart);
  const totals = days.map(() => 0);
  for (const session of sessions) {
    if (!Number.isFinite(Date.parse(session.startedAt))) continue;
    const index = days.indexOf(localDateOf(session.startedAt, timeZone));
    if (index === -1) continue;
    totals[index] = (totals[index] ?? 0) + sessionFocusedSec(session, nowMs);
  }
  return totals;
}

export function totalSeconds(buckets: readonly number[]): number {
  return buckets.reduce((sum, value) => sum + (Number.isFinite(value) ? Math.max(0, value) : 0), 0);
}

/** Whole minutes of a number of seconds (a started minute does not count yet). */
export function minutesOfSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.floor(Math.max(0, seconds) / 60) : 0;
}

/**
 * Today's focused time against today's planned time, in minutes: positive is
 * "more than planned". Null unless BOTH exist — nothing planned, or nothing
 * focused yet, is not a comparison.
 */
export function planDeltaMinutes(focusedSec: number, plannedMin: number): number | null {
  const focused = minutesOfSeconds(focusedSec);
  if (!Number.isFinite(plannedMin) || plannedMin <= 0 || focused <= 0) return null;
  return focused - Math.round(plannedMin);
}

export interface OverviewBlock {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: 'planned' | 'done' | 'skipped' | 'moved' | 'superseded';
}

function blockMinutes(block: Pick<OverviewBlock, 'startAt' | 'endAt'>): number {
  const span = Date.parse(block.endAt) - Date.parse(block.startAt);
  return Number.isFinite(span) ? Math.max(0, Math.round(span / 60_000)) : 0;
}

/** Blocks that are part of today's plan: not moved away, not replaced. */
function inPlan(block: OverviewBlock): boolean {
  return block.status !== 'moved' && block.status !== 'superseded';
}

/** Minutes of every block planned for today, done or not (the plan as it was made). */
export function plannedMinutes(blocks: readonly OverviewBlock[]): number {
  return blocks.filter(inPlan).reduce((sum, block) => sum + blockMinutes(block), 0);
}

/** Minutes of today's blocks that are still to do. */
export function remainingPlannedMinutes(blocks: readonly OverviewBlock[]): number {
  return blocks.filter((block) => block.status === 'planned').reduce((sum, block) => sum + blockMinutes(block), 0);
}

/** The next thing to start: the first planned block that has not ended yet. */
export function nextBlockOf<T extends OverviewBlock>(blocks: readonly T[], nowMs: number): T | null {
  const open = blocks
    .filter((block) => block.status === 'planned' && Date.parse(block.endAt) > nowMs)
    .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
  return open[0] ?? null;
}

export interface OverviewOccurrence {
  readonly startAt: string;
  readonly endAt: string;
}

/** Minutes of the occurrences that fall inside `[from, to)`, each clipped to it. */
export function minutesWithin(occurrences: readonly OverviewOccurrence[], from: string, to: string): number {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  let total = 0;
  for (const occurrence of occurrences) {
    const start = Math.max(fromMs, Date.parse(occurrence.startAt));
    const end = Math.min(toMs, Date.parse(occurrence.endAt));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) total += end - start;
  }
  return Math.round(total / 60_000);
}

export type DayKind = 'planned' | 'commitment' | 'focused';

export interface DaySegment {
  readonly kind: DayKind;
  readonly minutes: number;
  /** Share of the ring, 0..1; the shares of the returned segments sum to 1. */
  readonly share: number;
}

/**
 * Today's time by kind, for the ring: focus blocks still to do, 약속, and
 * focus already done. Three kinds of time that do not overlap. A kind with no
 * time is left out; with no time at all the list is empty (the card shows its
 * empty state, never an invented ring).
 */
export function daySegments(input: {
  readonly remainingPlannedMin: number;
  readonly commitmentMin: number;
  readonly focusedMin: number;
}): DaySegment[] {
  const parts: { kind: DayKind; minutes: number }[] = [
    { kind: 'planned', minutes: input.remainingPlannedMin },
    { kind: 'commitment', minutes: input.commitmentMin },
    { kind: 'focused', minutes: input.focusedMin },
  ];
  const present = parts
    .map((part) => ({ ...part, minutes: Number.isFinite(part.minutes) ? Math.max(0, Math.round(part.minutes)) : 0 }))
    .filter((part) => part.minutes > 0);
  const total = present.reduce((sum, part) => sum + part.minutes, 0);
  return present.map((part) => ({ ...part, share: part.minutes / total }));
}

/** The newest sessions first (by when they started). */
export function newestFirst<T extends OverviewSession>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

/** The last session of each of the most recently worked-on tasks, newest first. */
export function recentTaskSessions<T extends OverviewSession>(sessions: readonly T[], limit: number): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const session of newestFirst(sessions)) {
    if (seen.has(session.taskId)) continue;
    seen.add(session.taskId);
    result.push(session);
    if (result.length >= limit) break;
  }
  return result;
}

/** Sessions that started inside `[from, to)`. */
export function sessionsWithin<T extends OverviewSession>(sessions: readonly T[], from: string, to: string): T[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return sessions.filter((session) => {
    const started = Date.parse(session.startedAt);
    return Number.isFinite(started) && started >= fromMs && started < toMs;
  });
}

export interface EstimateItem {
  readonly actualFocusMin: number;
  readonly estimatedP50: number;
  readonly ratio: number;
  readonly excluded: boolean;
  readonly quality: 'ok' | 'outlier' | 'excluded';
  readonly createdAt: string;
}

/** Fewer included records than this and the dashboard says "not enough yet". */
export const ESTIMATE_MIN_SAMPLES = 3;

function counted(item: EstimateItem): boolean {
  return (
    !item.excluded &&
    item.quality === 'ok' &&
    Number.isFinite(item.actualFocusMin) &&
    Number.isFinite(item.estimatedP50) &&
    item.estimatedP50 > 0 &&
    item.actualFocusMin >= 0
  );
}

/**
 * "실제 시간이 예상의 N배": the focused minutes actually spent over the
 * minutes that were estimated, across the records 내 패턴 counts (not
 * excluded, not an outlier). Null with fewer than ESTIMATE_MIN_SAMPLES of
 * them — a ratio of two sessions is not a pattern.
 */
export function personalEstimate(items: readonly EstimateItem[]): { ratio: number; samples: number } | null {
  const used = items.filter(counted);
  if (used.length < ESTIMATE_MIN_SAMPLES) return null;
  const estimated = used.reduce((sum, item) => sum + item.estimatedP50, 0);
  const actual = used.reduce((sum, item) => sum + item.actualFocusMin, 0);
  if (estimated <= 0) return null;
  return { ratio: actual / estimated, samples: used.length };
}

/** The ratio of each counted record, oldest first, the last `limit` of them. */
export function estimateTrend(items: readonly EstimateItem[], limit: number): number[] {
  return items
    .filter((item) => counted(item) && Number.isFinite(item.ratio) && Number.isFinite(Date.parse(item.createdAt)))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-Math.max(0, limit))
    .map((item) => item.ratio);
}

export interface DurationPart {
  readonly value: number;
  readonly unit: 'hour' | 'minute';
}

/**
 * A duration as the parts a numeral is set in: `[6 시간, 40 분]`, `[45 분]`,
 * `[2 시간]`, `[0 분]`. Hours do not roll over into days.
 */
export function durationParts(minutes: number): DurationPart[] {
  const whole = Number.isFinite(minutes) ? Math.max(0, Math.round(minutes)) : 0;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  const parts: DurationPart[] = [];
  if (hours > 0) parts.push({ value: hours, unit: 'hour' });
  if (rest > 0 || hours === 0) parts.push({ value: rest, unit: 'minute' });
  return parts;
}

/** `00:00:00` for the tracker; hours are always shown so the width never jumps. */
export function clockParts(seconds: number): { hours: string; minutes: string; seconds: string } {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    hours: pad(Math.floor(safe / 3600)),
    minutes: pad(Math.floor((safe % 3600) / 60)),
    seconds: pad(safe % 60),
  };
}

/** How many local days `date` is before `today` (0 today, 1 yesterday, negative: later). */
export function daysBefore(date: string, today: string): number {
  const one = Date.parse(`${date}T00:00:00Z`);
  const two = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(one) || !Number.isFinite(two)) return 0;
  return Math.round((two - one) / 86_400_000);
}

/** One hue per project: the same project always takes the same one of the four. */
export const PROJECT_HUES = ['cyan', 'violet', 'orange', 'sky'] as const;
export type ProjectHue = (typeof PROJECT_HUES)[number];

export function projectHue(projectId: string): ProjectHue {
  let hash = 0;
  for (const char of projectId) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return PROJECT_HUES[hash % PROJECT_HUES.length] ?? 'cyan';
}
