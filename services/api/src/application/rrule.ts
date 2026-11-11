import { Temporal } from 'temporal-polyfill';

export interface RecurringCommitment {
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
  readonly rrule?: string | undefined;
}

export interface Occurrence {
  readonly startAt: string;
  readonly endAt: string;
}

export const MAX_OCCURRENCES = 2_000;

/** Typed RRULE rejection: callers map this to 422 validation_failed. */
export class InvalidRRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRRuleError';
  }
}

const BYDAY_INDEX: Readonly<Record<string, number>> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

const ALLOWED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'WKST',
]);

interface ParsedRule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly count?: number;
  readonly untilMs?: number;
  readonly untilDate?: string;
  readonly byDay: readonly number[];
  readonly byMonthDay: readonly number[];
}

function parseUntil(raw: string): { untilMs?: number; untilDate?: string } {
  if (/^\d{8}$/.test(raw)) {
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    try {
      Temporal.PlainDate.from(date);
    } catch {
      throw new InvalidRRuleError(`Unsupported RRULE UNTIL date: ${raw}`);
    }
    return { untilDate: date };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (match !== null) {
    const [, year, month, day, hour, minute, second] = match;
    try {
      return {
        untilMs: Temporal.PlainDateTime.from({
          year: Number(year),
          month: Number(month),
          day: Number(day),
          hour: Number(hour),
          minute: Number(minute),
          second: Number(second),
        })
          .toZonedDateTime('UTC')
          .epochMilliseconds,
      };
    } catch {
      throw new InvalidRRuleError(`Unsupported RRULE UNTIL instant: ${raw}`);
    }
  }
  throw new InvalidRRuleError(`Unsupported RRULE UNTIL value: ${raw}`);
}

export function parseRRule(rrule: string): ParsedRule {
  const parts = new Map<string, string>();
  for (const entry of rrule.split(';')) {
    const [name, value] = entry.split('=', 2);
    if (name === undefined || value === undefined || name.length === 0) {
      throw new InvalidRRuleError(`Malformed RRULE part: ${entry}`);
    }
    const upper = name.toUpperCase();
    if (!ALLOWED_PARTS.has(upper)) {
      throw new InvalidRRuleError(`Unsupported RRULE part: ${name}`);
    }
    if (parts.has(upper)) throw new InvalidRRuleError(`Duplicate RRULE part: ${name}`);
    parts.set(upper, value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    throw new InvalidRRuleError(`Unsupported RRULE FREQ: ${String(freq)}`);
  }
  const intervalRaw = parts.get('INTERVAL') ?? '1';
  const interval = Number.parseInt(intervalRaw, 10);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1_000) {
    throw new InvalidRRuleError('RRULE INTERVAL must be an integer between 1 and 1000');
  }
  if (parts.has('COUNT') && parts.has('UNTIL')) {
    throw new InvalidRRuleError('RRULE COUNT and UNTIL are mutually exclusive');
  }
  const countRaw = parts.get('COUNT');
  const count = countRaw === undefined ? undefined : Number.parseInt(countRaw, 10);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_OCCURRENCES)) {
    throw new InvalidRRuleError(`RRULE COUNT must be between 1 and ${MAX_OCCURRENCES}`);
  }
  const untilRaw = parts.get('UNTIL');
  const until = untilRaw === undefined ? {} : parseUntil(untilRaw);

  const byDayRaw = parts.get('BYDAY');
  if (byDayRaw !== undefined && freq !== 'WEEKLY') {
    throw new InvalidRRuleError('RRULE BYDAY is only supported with FREQ=WEEKLY');
  }
  const byDay =
    byDayRaw === undefined
      ? []
      : byDayRaw.split(',').map((day) => {
          const index = /^[A-Z]{2}$/.test(day) ? BYDAY_INDEX[day] : undefined;
          if (index === undefined) {
            throw new InvalidRRuleError(`Unsupported RRULE BYDAY value: ${day}`);
          }
          return index;
        });

  const byMonthDayRaw = parts.get('BYMONTHDAY');
  if (byMonthDayRaw !== undefined && freq !== 'MONTHLY') {
    throw new InvalidRRuleError('RRULE BYMONTHDAY is only supported with FREQ=MONTHLY');
  }
  const byMonthDay =
    byMonthDayRaw === undefined
      ? []
      : byMonthDayRaw.split(',').map((day) => {
          const value = Number.parseInt(day, 10);
          if (!Number.isInteger(value) || value < 1 || value > 31) {
            throw new InvalidRRuleError(`Unsupported RRULE BYMONTHDAY value: ${day}`);
          }
          return value;
        });

  const wkst = parts.get('WKST');
  if (wkst !== undefined && wkst !== 'MO') {
    throw new InvalidRRuleError('RRULE WKST only supports MO');
  }

  return {
    freq,
    interval,
    ...(count === undefined ? {} : { count }),
    ...until,
    byDay,
    byMonthDay,
  };
}

function dayNumber(date: Temporal.PlainDate): number {
  return Math.floor(date.toZonedDateTime('UTC').epochMilliseconds / 86_400_000);
}

function monthsBetween(start: Temporal.PlainDate, date: Temporal.PlainDate): number {
  return (date.year - start.year) * 12 + (date.month - start.month);
}

function matches(
  rule: ParsedRule,
  startDate: Temporal.PlainDate,
  date: Temporal.PlainDate,
): boolean {
  const days = dayNumber(date) - dayNumber(startDate);
  switch (rule.freq) {
    case 'DAILY':
      return days >= 0 && days % rule.interval === 0;
    case 'WEEKLY': {
      if (days < 0) return false;
      const weekIndex = Math.floor((days + (startDate.dayOfWeek - 1)) / 7);
      if (weekIndex % rule.interval !== 0) return false;
      const allowed = rule.byDay.length === 0 ? [startDate.dayOfWeek] : rule.byDay;
      return allowed.includes(date.dayOfWeek);
    }
    case 'MONTHLY': {
      if (days < 0) return false;
      const months = monthsBetween(startDate, date);
      if (months < 0 || months % rule.interval !== 0) return false;
      const allowed = rule.byMonthDay.length === 0 ? [startDate.day] : rule.byMonthDay;
      return allowed.includes(date.day);
    }
    case 'YEARLY': {
      if (days < 0) return false;
      const years = date.year - startDate.year;
      if (years % rule.interval !== 0) return false;
      return date.month === startDate.month && date.day === startDate.day;
    }
  }
}

function localEndOfDay(date: string, timeZone: string): number {
  const plain = Temporal.PlainDate.from(date);
  return Temporal.PlainDateTime.from({
    year: plain.year,
    month: plain.month,
    day: plain.day,
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  })
    .toZonedDateTime(timeZone).epochMilliseconds;
}

const MAX_LOOKBACK_MS = 10 * 366 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function localDateAt(ms: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate();
}

/**
 * Yield the same valid dates as `matches()` in chronological order, walking
 * whole periods instead of every calendar day. Invalid dates (Feb 29 outside
 * a leap year, BYMONTHDAY=31 in a short month) are skipped, never constrained
 * to a nearby day. COUNT rules use this path so their bounded match count is
 * exact even when DTSTART is far from the query range; non-COUNT rules keep
 * the day loop and fast-forward by whole periods (see expandOccurrences).
 */
const MAX_PERIOD_ITERATIONS = 200_000;

function* matchDates(
  rule: ParsedRule,
  startDate: Temporal.PlainDate,
  stopDate: Temporal.PlainDate,
): Generator<Temporal.PlainDate> {
  const after = (date: Temporal.PlainDate): boolean =>
    Temporal.PlainDate.compare(date, stopDate) > 0;
  let steps = 0;
  const tick = (): void => {
    steps += 1;
    if (steps > MAX_PERIOD_ITERATIONS) {
      throw new InvalidRRuleError('commitment recurrence expansion exceeded its safety bound');
    }
  };
  switch (rule.freq) {
    case 'DAILY': {
      for (let date = startDate; ; date = date.add({ days: rule.interval })) {
        tick();
        if (after(date)) return;
        yield date;
      }
    }
    case 'WEEKLY': {
      const allowed = [
        ...new Set(rule.byDay.length === 0 ? [startDate.dayOfWeek] : rule.byDay),
      ].sort((left, right) => left - right);
      for (let week = 0; ; week += rule.interval) {
        tick();
        for (const weekday of allowed) {
          const offset = week * 7 - (startDate.dayOfWeek - 1) + (weekday - 1);
          if (offset < 0) continue;
          const date = startDate.add({ days: offset });
          if (after(date)) return;
          yield date;
        }
      }
    }
    case 'MONTHLY': {
      const allowed = [
        ...new Set(rule.byMonthDay.length === 0 ? [startDate.day] : rule.byMonthDay),
      ].sort((left, right) => left - right);
      let month = Temporal.PlainYearMonth.from({
        year: startDate.year,
        month: startDate.month,
      });
      for (;;) {
        tick();
        if (after(month.toPlainDate({ day: 1 }))) return;
        for (const day of allowed) {
          if (day > month.daysInMonth) continue;
          const date = month.toPlainDate({ day });
          if (Temporal.PlainDate.compare(date, startDate) < 0) continue;
          if (after(date)) return;
          yield date;
        }
        month = month.add({ months: rule.interval });
      }
    }
    case 'YEARLY': {
      for (let year = startDate.year; ; year += rule.interval) {
        tick();
        const month = Temporal.PlainYearMonth.from({
          year,
          month: startDate.month,
        });
        if (after(month.toPlainDate({ day: 1 }))) return;
        if (startDate.day > month.daysInMonth) continue;
        const date = month.toPlainDate({ day: startDate.day });
        if (after(date)) return;
        yield date;
      }
    }
  }
}

/**
 * Expand a commitment into occurrences that overlap `[from, to)`.
 *
 * Recurrence is interpreted on the commitment's IANA wall clock. `UNTIL` is
 * inclusive; a DATE-form UNTIL means the end of that local day in the
 * commitment time zone. DST gap wall times shift forward to the next valid
 * instant and overlap wall times resolve to the first occurrence (Temporal's
 * "compatible" disambiguation, matching 08 §3). The query window must be at
 * most 366 days and expansion is capped at 2,000 occurrences. Unsupported
 * rules throw InvalidRRuleError, which callers map to 422. Non-COUNT rules
 * whose DTSTART is more than ten years before the range are fast-forwarded by
 * whole periods (so old stored rows cannot poison every query); new writes
 * are rejected by the application layer instead. COUNT rules never
 * fast-forward: they walk whole periods from DTSTART so the bounded match
 * count stays exact, and create/patch cap COUNT at 1000.
 */
export function expandOccurrences(
  commitment: RecurringCommitment,
  from: string,
  to: string,
): Occurrence[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new InvalidRRuleError('occurrence range is not a valid interval');
  }
  if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) {
    throw new InvalidRRuleError('occurrence range exceeds 366 days');
  }
  const startMs = Date.parse(commitment.startAt);
  const endMs = Date.parse(commitment.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new InvalidRRuleError('commitment interval is invalid');
  }
  if (commitment.rrule === undefined) {
    return endMs > fromMs && startMs < toMs
      ? [{ startAt: commitment.startAt, endAt: commitment.endAt }]
      : [];
  }

  const rule = parseRRule(commitment.rrule);
  const untilMs =
    rule.untilMs ??
    (rule.untilDate === undefined ? undefined : localEndOfDay(rule.untilDate, commitment.timeZone));

  const durationMs = endMs - startMs;
  // Recurrence already ended before the range: no occurrence can overlap it.
  if (untilMs !== undefined && untilMs + durationMs <= fromMs) return [];

  const start = Temporal.Instant.from(commitment.startAt).toZonedDateTimeISO(
    commitment.timeZone,
  );
  const localTime = start.toPlainTime();
  const startDate = start.toPlainDate();
  const occurrences: Occurrence[] = [];

  if (rule.count !== undefined) {
    // COUNT is bounded by its own value: walk periods and count every valid
    // date from DTSTART, independent of the query range (review finding R2).
    let matched = 0;
    const stopDate = localDateAt(toMs, commitment.timeZone);
    for (const cursor of matchDates(rule, startDate, stopDate)) {
      const occurrence = cursor.toPlainDateTime(localTime).toZonedDateTime(commitment.timeZone);
      const occurrenceStartMs = occurrence.epochMilliseconds;
      if (occurrenceStartMs >= toMs) break;
      if (untilMs !== undefined && occurrenceStartMs > untilMs) break;
      matched += 1;
      const occurrenceEndMs = occurrenceStartMs + durationMs;
      if (occurrenceEndMs > fromMs && occurrenceStartMs < toMs) {
        occurrences.push({
          startAt: occurrence.toInstant().toString(),
          endAt: Temporal.Instant.fromEpochMilliseconds(occurrenceEndMs).toString(),
        });
        if (occurrences.length > MAX_OCCURRENCES) {
          throw new InvalidRRuleError(
            `commitment expands to more than ${MAX_OCCURRENCES} occurrences`,
          );
        }
      }
      if (matched >= rule.count) break;
    }
    return occurrences;
  }

  let cursor = startDate;
  if (fromMs - startMs > MAX_LOOKBACK_MS) {
    // No COUNT: jump whole periods instead of rejecting. Keep a one-day
    // margin so an occurrence that starts before `from` but overlaps the
    // range is still visited by the day loop below.
    const target = localDateAt(Math.max(startMs, fromMs - durationMs - DAY_MS), commitment.timeZone);
    if (Temporal.PlainDate.compare(target, startDate) > 0) {
      cursor = target;
    }
  }
  let guard = 0;

  while (guard < 40_000) {
    guard += 1;
    const occurrence = cursor.toPlainDateTime(localTime).toZonedDateTime(commitment.timeZone);
    const occurrenceStartMs = occurrence.epochMilliseconds;
    const occurrenceEndMs = occurrenceStartMs + durationMs;
    if (occurrenceStartMs >= toMs) break;
    if (untilMs !== undefined && occurrenceStartMs > untilMs) break;

    if (matches(rule, startDate, cursor)) {
      if (occurrenceEndMs > fromMs && occurrenceStartMs < toMs) {
        occurrences.push({
          startAt: occurrence.toInstant().toString(),
          endAt: Temporal.Instant.fromEpochMilliseconds(occurrenceEndMs).toString(),
        });
        if (occurrences.length > MAX_OCCURRENCES) {
          throw new InvalidRRuleError(
            `commitment expands to more than ${MAX_OCCURRENCES} occurrences`,
          );
        }
      }
    }
    cursor = cursor.add({ days: 1 });
  }

  if (guard >= 40_000) {
    throw new InvalidRRuleError('commitment recurrence expansion exceeded its safety bound');
  }
  return occurrences;
}

/** Intersect an occurrence with `[from, to)`, or null when disjoint. */
export function clipOccurrence(
  occurrence: Occurrence,
  from: string,
  to: string,
): Occurrence | null {
  const startMs = Math.max(Date.parse(occurrence.startAt), Date.parse(from));
  const endMs = Math.min(Date.parse(occurrence.endAt), Date.parse(to));
  if (endMs <= startMs) return null;
  return {
    startAt: new Date(startMs).toISOString(),
    endAt: new Date(endMs).toISOString(),
  };
}
