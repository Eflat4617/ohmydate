import { intlLocale, t, tp } from './index';

/**
 * Locale-aware formatting for everything the UI shows (UI-I18N).
 *
 * Dates and times go through `Intl.DateTimeFormat` in the user's IANA zone:
 *   date        11월 14일 (토)          time        오후 7:00
 *   time range  오후 7:00~8:30 · 오전 10:30~오후 1:30
 *   date range  11월 16일 (월) ~ 11월 22일 (일)
 * Durations are minutes rendered as at most two units:
 *   1시간 30분 · 35분 · 0분 · 11일 10시간 (≥ 1 day rounds to the hour)
 *   signed: +11일 10시간 · −35분 (U+2212) · 0분 (no sign) · −1분 미만
 * Money is USD with 2–4 decimals ($0.20, $0.0035).
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
export const MINUS_SIGN = '−';

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const numberFormatters = new Map<string, Intl.NumberFormat>();

function dateTimeFormatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const tag = intlLocale();
  const key = `${tag}|${timeZone}|${JSON.stringify(options)}`;
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(tag, { ...options, timeZone });
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

function numberFormatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const tag = intlLocale();
  const key = `${tag}|${JSON.stringify(options)}`;
  let formatter = numberFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(tag, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

function toDate(instant: string | number | Date): Date {
  const value = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(value.getTime())) throw new RangeError(`Invalid instant: ${String(instant)}`);
  return value;
}

/** The browser's IANA zone, used only when no user/plan zone is known. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' };
const YEAR_MONTH_DAY: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'long', day: 'numeric' };
const WEEKDAY: Intl.DateTimeFormatOptions = { weekday: 'short' };
const LOCAL_DATE: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

export interface DateOptions {
  /** Prefix the year (2026년 11월 14일 (토)). */
  readonly year?: boolean;
  /** Append the weekday; on by default. */
  readonly weekday?: boolean;
}

function composeDate(date: Date, timeZone: string, options: DateOptions): string {
  const base = dateTimeFormatter(timeZone, options.year === true ? YEAR_MONTH_DAY : MONTH_DAY).format(date);
  if (options.weekday === false) return base;
  const weekday = dateTimeFormatter(timeZone, WEEKDAY).format(date);
  return t('format.dateWithWeekday', { date: base, weekday });
}

/** `11월 14일 (토)` for an instant, in `timeZone`. */
export function formatDate(instant: string | number | Date, timeZone: string, options: DateOptions = {}): string {
  return composeDate(toDate(instant), timeZone, options);
}

/** `11월 14일 (토)` for a civil `YYYY-MM-DD` date (no zone conversion). */
export function formatCivilDate(date: string, options: DateOptions = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return date;
  const noon = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (Number.isNaN(noon.getTime())) return date;
  return composeDate(noon, 'UTC', options);
}

/** Short weekday (`토`) for a civil date. */
export function formatCivilWeekday(date: string): string {
  const noon = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(noon.getTime())) return date;
  return dateTimeFormatter('UTC', WEEKDAY).format(noon);
}

/** `11월 14일` for a civil date. */
export function formatCivilMonthDay(date: string): string {
  return formatCivilDate(date, { weekday: false });
}

/** `오후 7:00` for an instant, in `timeZone`. */
export function formatTime(instant: string | number | Date, timeZone: string): string {
  return dateTimeFormatter(timeZone, TIME_OPTIONS).format(toDate(instant));
}

/** `오전 9시` for an hour of a local day (calendar rail labels). */
export function formatHour(hour: number): string {
  return dateTimeFormatter('UTC', { hour: 'numeric' }).format(new Date(Date.UTC(2026, 0, 5, hour)));
}

/** `11월 14일 (토) 오후 7:00`. */
export function formatDateTime(
  instant: string | number | Date,
  timeZone: string,
  options: DateOptions = {},
): string {
  return t('format.dateTime', {
    date: formatDate(instant, timeZone, options),
    time: formatTime(instant, timeZone),
  });
}

function localDateKey(date: Date, timeZone: string): string {
  return dateTimeFormatter(timeZone, LOCAL_DATE).format(date);
}

function timeWithoutDayPeriod(date: Date, timeZone: string): string {
  const parts = dateTimeFormatter(timeZone, TIME_OPTIONS).formatToParts(date);
  const index = parts.findIndex((part) => part.type === 'dayPeriod');
  if (index === -1) return parts.map((part) => part.value).join('');
  const kept = parts.filter((_, position) => {
    if (position === index) return false;
    // Drop the separator that belonged to the day period ("오후 " → "").
    const neighbour = index === 0 ? position === 1 : position === index - 1;
    return !(neighbour && parts[position]?.type === 'literal');
  });
  return kept.map((part) => part.value).join('').trim();
}

function dayPeriod(date: Date, timeZone: string): string | undefined {
  return dateTimeFormatter(timeZone, TIME_OPTIONS)
    .formatToParts(date)
    .find((part) => part.type === 'dayPeriod')?.value;
}

/**
 * Time range in `timeZone`. Same local day: `오후 7:00~8:30` (the day period
 * is not repeated) or `오전 10:30~오후 1:30`. Across days both ends carry the
 * date: `11월 14일 (토) 오후 11:00~11월 15일 (일) 오전 1:00`.
 */
export function formatTimeRange(
  start: string | number | Date,
  end: string | number | Date,
  timeZone: string,
): string {
  const from = toDate(start);
  const to = toDate(end);
  if (localDateKey(from, timeZone) !== localDateKey(to, timeZone)) {
    return t('format.timeRange', {
      start: formatDateTime(from, timeZone),
      end: formatDateTime(to, timeZone),
    });
  }
  const startPeriod = dayPeriod(from, timeZone);
  const endText =
    startPeriod !== undefined && startPeriod === dayPeriod(to, timeZone)
      ? timeWithoutDayPeriod(to, timeZone)
      : formatTime(to, timeZone);
  return t('format.timeRange', { start: formatTime(from, timeZone), end: endText });
}

/** `11월 14일 (토) 오후 7:00~8:30`, or both full ends across days. */
export function formatDateTimeRange(
  start: string | number | Date,
  end: string | number | Date,
  timeZone: string,
  options: DateOptions = {},
): string {
  const from = toDate(start);
  const to = toDate(end);
  if (localDateKey(from, timeZone) !== localDateKey(to, timeZone)) {
    return formatTimeRange(from, to, timeZone);
  }
  return t('format.dateTime', {
    date: formatDate(from, timeZone, options),
    time: formatTimeRange(from, to, timeZone),
  });
}

/** `11월 16일 (월) ~ 11월 22일 (일)` for two civil dates. */
export function formatCivilDateRange(start: string, end: string, options: DateOptions = {}): string {
  return t('format.dateRange', {
    start: formatCivilDate(start, options),
    end: formatCivilDate(end, { ...options, year: false }),
  });
}

export function formatNumber(value: number, maximumFractionDigits = 0): string {
  return numberFormatter({ maximumFractionDigits }).format(value);
}

function durationParts(absoluteMinutes: number): string[] {
  const rounded = Math.round(absoluteMinutes);
  if (rounded >= MINUTES_PER_DAY) {
    const totalHours = Math.round(absoluteMinutes / MINUTES_PER_HOUR);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    const parts = [tp('duration.day', days)];
    if (hours > 0) parts.push(tp('duration.hour', hours));
    return parts;
  }
  const hours = Math.floor(rounded / MINUTES_PER_HOUR);
  const minutes = rounded % MINUTES_PER_HOUR;
  const parts: string[] = [];
  if (hours > 0) parts.push(tp('duration.hour', hours));
  if (minutes > 0 || hours === 0) parts.push(tp('duration.minute', minutes));
  return parts;
}

function unsignedDuration(absoluteMinutes: number): string {
  return durationParts(absoluteMinutes).join(t('duration.separator'));
}

function isZeroDuration(minutes: number): boolean {
  return minutes === 0;
}

function magnitude(absoluteMinutes: number): string {
  // Keep a sub-minute value visible instead of rounding it to "0분": a slack of
  // −0.4 minutes is still negative.
  if (absoluteMinutes > 0 && absoluteMinutes < 1) return t('duration.underMinute');
  return unsignedDuration(absoluteMinutes);
}

/**
 * Human-readable duration from minutes: `1시간 30분`, `35분`, `11일 10시간`.
 * Negative values get a minus sign (`−35분`); zero is `0분`; values under a
 * minute read `1분 미만`.
 */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  if (isZeroDuration(minutes)) return unsignedDuration(0);
  const text = magnitude(Math.abs(minutes));
  return minutes < 0 ? `${MINUS_SIGN}${text}` : text;
}

/** Like `formatDuration`, but positive values carry `+` (`+11일 10시간`). */
export function formatSignedDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  if (isZeroDuration(minutes)) return unsignedDuration(0);
  const text = magnitude(Math.abs(minutes));
  return minutes < 0 ? `${MINUS_SIGN}${text}` : `+${text}`;
}

/** Elapsed minutes between two instants (real time, so DST days count 23 or 25 hours). */
export function minutesBetween(start: string, end: string): number {
  return Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000));
}

/** Focus timer clock: `05:07`, `1:02:03`. */
export function formatTimer(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

/** US dollars with 2–4 decimals: `$0.20`, `$5.00`, `$0.0035`. */
export function formatUsd(amount: number): string {
  return numberFormatter({
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

/** Ratio (0–1) as a percentage with one decimal: `92.5%`. */
export function formatPercent(ratio: number, maximumFractionDigits = 1): string {
  return numberFormatter({ style: 'percent', maximumFractionDigits }).format(ratio);
}
