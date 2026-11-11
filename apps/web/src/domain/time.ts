/**
 * Local wall-clock helpers for the planner UI.
 *
 * Everything the UI renders for a user is in the user's IANA time zone. We use
 * `Intl.DateTimeFormat` instead of `Date` local methods so tests and the
 * browser agree regardless of the machine time zone (07 §3.5, 08 §3).
 */

export interface LocalParts {
  /** `YYYY-MM-DD` in the target zone. */
  readonly date: string;
  /** Minutes since local midnight, 0..1439. */
  readonly minutes: number;
  /** ISO weekday, Monday = 1 ... Sunday = 7. */
  readonly weekday: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = DATE_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  DATE_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function offsetFormatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = OFFSET_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  OFFSET_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function partValues(formatter: Intl.DateTimeFormat, instant: Date): Record<string, number> {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type === 'literal') continue;
    const numeric = Number(part.value);
    if (Number.isFinite(numeric)) values[part.type] = numeric;
  }
  return values;
}

/** ISO weekday from a civil `YYYY-MM-DD` date (Monday = 1). */
export function weekdayOfDate(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function localParts(instant: string, timeZone: string): LocalParts {
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis)) throw new RangeError(`Invalid instant: ${instant}`);
  const values = partValues(formatterFor(timeZone), new Date(millis));
  const year = values['year'] ?? 1970;
  const month = values['month'] ?? 1;
  const day = values['day'] ?? 1;
  const hour = values['hour'] ?? 0;
  const minute = values['minute'] ?? 0;
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    date,
    minutes: hour * 60 + minute,
    weekday: weekdayOfDate(date),
    year,
    month,
    day,
    hour,
    minute,
  };
}

export function localDateOf(instant: string, timeZone: string): string {
  return localParts(instant, timeZone).date;
}

export function localMinutesOf(instant: string, timeZone: string): number {
  return localParts(instant, timeZone).minutes;
}

/** Offset in milliseconds east of UTC at the given instant. */
export function offsetMsAt(instantMs: number, timeZone: string): number {
  const values = partValues(offsetFormatterFor(timeZone), new Date(instantMs));
  const asUtc = Date.UTC(
    values['year'] ?? 1970,
    (values['month'] ?? 1) - 1,
    values['day'] ?? 1,
    values['hour'] ?? 0,
    values['minute'] ?? 0,
    values['second'] ?? 0,
  );
  return asUtc - instantMs;
}

/**
 * Convert a local wall-clock date + minutes into a UTC instant.
 *
 * A wall-clock time inside a spring-forward gap is moved forward to the first
 * valid instant, matching the documented DST rule (08 §3); an overlap resolves
 * to the first occurrence.
 */
export function zonedWallClockToInstant(
  date: string,
  minutes: number,
  timeZone: string,
): string {
  const [year, month, day] = date.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const naive = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour, minute);
  const firstOffset = offsetMsAt(naive, timeZone);
  let candidate = naive - firstOffset;
  const secondOffset = offsetMsAt(candidate, timeZone);
  if (secondOffset !== firstOffset) candidate = naive - secondOffset;
  return new Date(candidate).toISOString();
}

export function addDaysToDate(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/** Monday-based start of the week containing `date`. */
export function startOfWeek(date: string): string {
  return addDaysToDate(date, 1 - weekdayOfDate(date));
}

export function weekDates(start: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDaysToDate(start, index));
}

export function formatLocalTime(instant: string, timeZone: string): string {
  const parts = localParts(instant, timeZone);
  return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function localInputValue(instant: string, timeZone: string): string {
  const parts = localParts(instant, timeZone);
  return `${parts.date}T${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}

export function instantFromLocalInput(value: string, timeZone: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (match === null) throw new RangeError(`Invalid local date-time: ${value}`);
  const date = match[1] ?? '';
  const hour = Number(match[2] ?? '0');
  const minute = Number(match[3] ?? '0');
  return zonedWallClockToInstant(date, hour * 60 + minute, timeZone);
}

export function todayInZone(timeZone: string, nowMs: number = Date.now()): string {
  return localDateOf(new Date(nowMs).toISOString(), timeZone);
}

/** Minutes as a compact duration, keeping fractional minutes intact. */
export function formatMinuteValue(value: number): string {
  if (Number.isInteger(value)) return `${value} min`;
  const rounded = Math.round(value * 100) / 100;
  return `${rounded} min`;
}

export function formatSignedMinuteValue(value: number): string {
  const formatted = formatMinuteValue(Math.abs(value));
  if (value < 0) return `−${formatted}`;
  if (value === 0) return '0 min';
  return `+${formatted}`;
}

export function formatRatio(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

export function shiftInstant(instant: string, minutes: number): string {
  const millis = Date.parse(instant);
  if (!Number.isFinite(millis)) throw new RangeError(`Invalid instant: ${instant}`);
  return new Date(millis + minutes * 60 * 1000).toISOString();
}
