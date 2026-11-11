import {
  addDaysToDate,
  localParts,
  startOfWeek,
  weekdayOfDate,
  zonedWallClockToInstant,
} from './time';

export interface RruleSource {
  readonly startAt: string;
  readonly endAt: string;
  readonly timeZone: string;
  readonly rrule?: string | undefined;
}

export interface ExpandedOccurrence {
  readonly startAt: string;
  readonly endAt: string;
}

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const CODE_TO_WEEKDAY: Record<WeekdayCode, number> = {
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
  SU: 7,
};

export function weekdayCode(weekday: number): WeekdayCode {
  return WEEKDAY_CODES[weekday - 1] ?? 'MO';
}

export function weeklyRrule(days: readonly WeekdayCode[]): string {
  const sorted = [...new Set(days)]
    .sort((left, right) => CODE_TO_WEEKDAY[left] - CODE_TO_WEEKDAY[right])
    .join(',');
  return `FREQ=WEEKLY;BYDAY=${sorted.length > 0 ? sorted : 'MO'}`;
}

export interface ParsedRrule {
  readonly freq: 'DAILY' | 'WEEKLY';
  readonly interval: number;
  readonly byDay: readonly WeekdayCode[];
  readonly count: number | undefined;
  readonly until: string | undefined;
}

export function parseRrule(rule: string): ParsedRrule {
  const fields = new Map<string, string>();
  for (const token of rule.split(';')) {
    const [key, value] = token.split('=');
    if (key !== undefined && value !== undefined) fields.set(key.trim().toUpperCase(), value.trim());
  }
  const freqValue = fields.get('FREQ') ?? 'WEEKLY';
  const freq = freqValue === 'DAILY' ? 'DAILY' : 'WEEKLY';
  const intervalRaw = Number(fields.get('INTERVAL') ?? '1');
  const interval = Number.isFinite(intervalRaw) && intervalRaw >= 1 ? Math.floor(intervalRaw) : 1;
  const byDayRaw = fields.get('BYDAY');
  const byDay =
    byDayRaw === undefined
      ? []
      : byDayRaw
          .split(',')
          .map((code) => code.trim().toUpperCase())
          .filter((code): code is WeekdayCode => (WEEKDAY_CODES as readonly string[]).includes(code));
  const countRaw = Number(fields.get('COUNT') ?? '');
  const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.floor(countRaw) : undefined;
  const untilRaw = fields.get('UNTIL');
  return { freq, interval, byDay, count, until: untilRaw };
}

/** Days selected by a weekly preset, for the checkbox UI. */
export function weeklyDaysFromRrule(rule: string | undefined): WeekdayCode[] {
  if (rule === undefined) return [];
  const parsed = parseRrule(rule);
  if (parsed.freq !== 'WEEKLY') return [];
  return [...parsed.byDay];
}

function untilInstant(until: string | undefined, timeZone: string): number | undefined {
  if (until === undefined) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return Date.parse(zonedWallClockToInstant(until, 24 * 60, timeZone));
  }
  const parsed = Date.parse(until);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const MAX_ITERATIONS = 20_000;

/**
 * Expand a bounded RFC 5545 subset (DAILY/WEEKLY, INTERVAL, BYDAY, COUNT,
 * UNTIL). Recurrence is computed in the commitment's local wall clock, then
 * converted to UTC instants, so a weekly 09:00 meeting stays at 09:00 across a
 * DST transition (08 §2.4a, §3).
 */
export function expandOccurrences(
  source: RruleSource,
  from: string,
  to: string,
  limit = 2_000,
): ExpandedOccurrence[] {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const startMs = Date.parse(source.startAt);
  const endMs = Date.parse(source.endAt);
  if (![fromMs, toMs, startMs, endMs].every(Number.isFinite) || toMs <= fromMs) return [];

  const occurrences: ExpandedOccurrence[] = [];
  const durationMs = Math.max(0, endMs - startMs);

  if (source.rrule === undefined || source.rrule.length === 0) {
    if (startMs < toMs && endMs > fromMs) occurrences.push({ startAt: source.startAt, endAt: source.endAt });
    return occurrences;
  }

  const rule = parseRrule(source.rrule);
  const startLocal = localParts(source.startAt, source.timeZone);
  const untilMs = untilInstant(rule.until, source.timeZone);
  const weeklyDays =
    rule.freq === 'WEEKLY'
      ? rule.byDay.length > 0
        ? [...rule.byDay].sort((left, right) => CODE_TO_WEEKDAY[left] - CODE_TO_WEEKDAY[right])
        : [weekdayCode(startLocal.weekday)]
      : [];
  const startWeek = startOfWeek(startLocal.date);
  let emitted = 0;
  let iterations = 0;

  const push = (localDate: string): boolean => {
    const occurrenceStart = zonedWallClockToInstant(localDate, startLocal.minutes, source.timeZone);
    const occurrenceStartMs = Date.parse(occurrenceStart);
    if (occurrenceStartMs < startMs) return true;
    const occurrenceEndMs = occurrenceStartMs + durationMs;
    if (untilMs !== undefined && occurrenceStartMs > untilMs) return false;
    emitted += 1;
    if (occurrenceStartMs < toMs && occurrenceEndMs > fromMs) {
      occurrences.push({
        startAt: occurrenceStart,
        endAt: new Date(occurrenceEndMs).toISOString(),
      });
    }
    if (rule.count !== undefined && emitted >= rule.count) return false;
    if (occurrenceStartMs >= toMs) return false;
    return occurrences.length < limit;
  };

  if (rule.freq === 'DAILY') {
    let date = startLocal.date;
    while (iterations < MAX_ITERATIONS) {
      iterations += 1;
      if (!push(date)) break;
      date = addDaysToDate(date, rule.interval);
    }
    return occurrences;
  }

  let week = startWeek;
  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    for (const code of weeklyDays) {
      const offset = CODE_TO_WEEKDAY[code] - 1;
      const date = addDaysToDate(week, offset);
      if (weekdayOfDate(date) !== CODE_TO_WEEKDAY[code]) continue;
      if (!push(date)) return occurrences;
    }
    week = addDaysToDate(week, 7 * rule.interval);
    if (Date.parse(zonedWallClockToInstant(week, 0, source.timeZone)) >= toMs) break;
  }
  return occurrences;
}
