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

const BYDAY_INDEX: Readonly<Record<string, number>> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

interface ParsedRule {
  readonly freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  readonly interval: number;
  readonly count?: number;
  readonly untilMs?: number;
  readonly byDay: readonly number[];
}

function parseUntil(raw: string): number {
  if (/^\d{8}$/.test(raw)) {
    const date = Temporal.PlainDate.from(
      `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
    );
    return date.toZonedDateTime('UTC').epochMilliseconds;
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw);
  if (match !== null) {
    const [, year, month, day, hour, minute, second] = match;
    return Temporal.PlainDateTime.from({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
    })
      .toZonedDateTime('UTC')
      .epochMilliseconds;
  }
  throw new RangeError(`Unsupported RRULE UNTIL value: ${raw}`);
}

export function parseRRule(rrule: string): ParsedRule {
  const parts = new Map<string, string>();
  for (const entry of rrule.split(';')) {
    const [name, value] = entry.split('=', 2);
    if (name === undefined || value === undefined) {
      throw new RangeError(`Malformed RRULE part: ${entry}`);
    }
    parts.set(name.toUpperCase(), value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    throw new RangeError(`Unsupported RRULE FREQ: ${String(freq)}`);
  }
  const intervalRaw = parts.get('INTERVAL') ?? '1';
  const interval = Number.parseInt(intervalRaw, 10);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1_000) {
    throw new RangeError('RRULE INTERVAL must be an integer between 1 and 1000');
  }
  const countRaw = parts.get('COUNT');
  const count = countRaw === undefined ? undefined : Number.parseInt(countRaw, 10);
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > MAX_OCCURRENCES)) {
    throw new RangeError(`RRULE COUNT must be between 1 and ${MAX_OCCURRENCES}`);
  }
  const untilRaw = parts.get('UNTIL');
  const untilMs = untilRaw === undefined ? undefined : parseUntil(untilRaw);
  const byDayRaw = parts.get('BYDAY');
  const byDay =
    byDayRaw === undefined
      ? []
      : byDayRaw.split(',').map((day) => {
          const index = BYDAY_INDEX[day.replace(/^[+-]?\d+/, '')];
          if (index === undefined) throw new RangeError(`Unsupported RRULE BYDAY value: ${day}`);
          return index;
        });
  return {
    freq,
    interval,
    ...(count === undefined ? {} : { count }),
    ...(untilMs === undefined ? {} : { untilMs }),
    byDay,
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
      const weekIndex = Math.floor(
        (days + (startDate.dayOfWeek - 1)) / 7,
      );
      if (weekIndex % rule.interval !== 0) return false;
      const allowed = rule.byDay.length === 0 ? [startDate.dayOfWeek] : rule.byDay;
      return allowed.includes(date.dayOfWeek);
    }
    case 'MONTHLY': {
      if (days < 0) return false;
      const months = monthsBetween(startDate, date);
      if (months < 0 || months % rule.interval !== 0) return false;
      return date.day === startDate.day;
    }
    case 'YEARLY': {
      if (days < 0) return false;
      const years = date.year - startDate.year;
      if (years % rule.interval !== 0) return false;
      return date.month === startDate.month && date.day === startDate.day;
    }
  }
}

/**
 * Expand a commitment into occurrences that overlap `[from, to)`.
 *
 * Recurrence is interpreted on the commitment's IANA wall clock: the local
 * start time is preserved across DST transitions (gap -> next valid instant,
 * overlap -> the first occurrence, matching 08 §3). The query window must be
 * at most 366 days and expansion is capped at 2,000 occurrences; callers map
 * the thrown `RangeError` to 422.
 */
export function expandOccurrences(
  commitment: RecurringCommitment,
  from: string,
  to: string,
): Occurrence[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new RangeError('occurrence range is not a valid interval');
  }
  if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) {
    throw new RangeError('occurrence range exceeds 366 days');
  }
  const startMs = Date.parse(commitment.startAt);
  const endMs = Date.parse(commitment.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new RangeError('commitment interval is invalid');
  }
  if (commitment.rrule === undefined) {
    return endMs > fromMs && startMs < toMs
      ? [{ startAt: commitment.startAt, endAt: commitment.endAt }]
      : [];
  }

  const rule = parseRRule(commitment.rrule);
  const durationMs = endMs - startMs;
  const start = Temporal.Instant.from(commitment.startAt).toZonedDateTimeISO(
    commitment.timeZone,
  );
  const localTime = start.toPlainTime();
  const startDate = start.toPlainDate();
  let cursor = startDate;
  const occurrences: Occurrence[] = [];
  let matched = 0;
  let guard = 0;

  // The guard bounds a pathological rule (a daily rule started decades before
  // the query window) instead of walking forever.
  while (guard < 40_000) {
    guard += 1;
    const occurrence = cursor.toPlainDateTime(localTime).toZonedDateTime(commitment.timeZone);
    const occurrenceStartMs = occurrence.epochMilliseconds;
    const occurrenceEndMs = occurrenceStartMs + durationMs;
    if (occurrenceStartMs >= toMs) break;

    if (matches(rule, startDate, cursor)) {
      matched += 1;
      if (rule.count !== undefined && matched > rule.count) break;
      if (rule.untilMs !== undefined && occurrenceStartMs >= rule.untilMs) break;
      if (occurrenceEndMs > fromMs && occurrenceStartMs < toMs) {
        occurrences.push({
          startAt: occurrence.toInstant().toString(),
          endAt: Temporal.Instant.fromEpochMilliseconds(occurrenceEndMs).toString(),
        });
        if (occurrences.length > MAX_OCCURRENCES) {
          throw new RangeError(`commitment expands to more than ${MAX_OCCURRENCES} occurrences`);
        }
      }
    }
    cursor = cursor.add({ days: 1 });
  }

  if (guard >= 40_000) {
    throw new RangeError('commitment recurrence expansion exceeded its safety bound');
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
