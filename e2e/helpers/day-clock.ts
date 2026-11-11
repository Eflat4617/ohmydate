/**
 * FU-79: deterministic "a day that has room left" for specs that assert the
 * Today screen. The planner's clock still comes from the API (real time, or
 * `E2E_FAKE_NOW` via helpers/shifted-clock.mjs); this helper only picks the
 * simulated browser instant the spec drives the UI with. Choosing the next
 * local morning that is comfortably after the API's "now" makes the tested
 * day independent of the wall-clock time the suite happens to run at.
 */

const MINUTE_MS = 60_000;

/** The next local morning is kept at least this far after the API's now so a
 *  notification block (now + a few minutes) can never overlap the day's plan. */
export const DAY_CLOCK_MARGIN_MS = 3 * 60 * MINUTE_MS;

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function localParts(ms: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return {
    year: Number(part('year')),
    month: Number(part('month')),
    day: Number(part('day')),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
}

/**
 * Instant of a civil wall-clock time in `timeZone`. Two passes handle ordinary
 * offsets; a third absorbs the offset change on DST transition days.
 */
export function zonedWallClockMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = naive;
  for (let pass = 0; pass < 4; pass += 1) {
    const parts = localParts(guess, timeZone);
    const actual = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    const diff = naive - actual;
    if (diff === 0) break;
    guess += diff;
  }
  return guess;
}

/** First instant of the local calendar date that contains `ms`. */
export function localDayStartMs(ms: number, timeZone: string): number {
  const parts = localParts(ms, timeZone);
  return zonedWallClockMs(parts.year, parts.month, parts.day, 0, 0, timeZone);
}

/**
 * Next `hour:00` local wall clock that is at least `marginMs` after `ms`.
 * Whole days are added in civil time, so DST days keep a 09:00 local anchor.
 */
export function nextLocalMorningMs(
  ms: number,
  timeZone: string,
  hour = 9,
  marginMs = DAY_CLOCK_MARGIN_MS,
): number {
  const parts = localParts(ms, timeZone);
  let year = parts.year;
  let month = parts.month;
  let day = parts.day;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = zonedWallClockMs(year, month, day, hour, 0, timeZone);
    if (candidate >= ms + marginMs) return candidate;
    const next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + 1);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return zonedWallClockMs(year, month, day, hour, 0, timeZone);
}
