import { addDaysToDate, localParts, shiftInstant, zonedWallClockToInstant } from './time';

/**
 * CAL-05 addendum: a draft whose time was a bare hour from 7 to 11 ("7시") was
 * read as AM; the person can switch it to PM (and back). The switch is done on
 * the local wall clock in the draft's zone with the shared time utilities, so a
 * DST day still lands on the intended wall-clock time.
 */

const HALF_DAY_MINUTES = 12 * 60;
const DAY_MINUTES = 24 * 60;

export type HalfDayDirection = 1 | -1;

/** The same local wall clock 12 hours later (1) or earlier (-1) in `timeZone`; the date carries over midnight. */
export function shiftHalfDay(instant: string, timeZone: string, direction: HalfDayDirection): string {
  const parts = localParts(instant, timeZone);
  let minutes = parts.minutes + direction * HALF_DAY_MINUTES;
  let date = parts.date;
  if (minutes >= DAY_MINUTES) {
    minutes -= DAY_MINUTES;
    date = addDaysToDate(date, 1);
  } else if (minutes < 0) {
    minutes += DAY_MINUTES;
    date = addDaysToDate(date, -1);
  }
  return zonedWallClockToInstant(date, minutes, timeZone);
}

/**
 * A span moved by half a day: the start moves 12 hours on the wall clock and
 * the end keeps the span's length, so an end that crosses midnight
 * (11:00-13:00 -> 23:00-01:00) stays after the start.
 */
export function shiftSpanHalfDay(
  startAt: string,
  endAt: string,
  timeZone: string,
  direction: HalfDayDirection,
): { readonly startAt: string; readonly endAt: string } {
  const lengthMinutes = Math.round((Date.parse(endAt) - Date.parse(startAt)) / 60_000);
  const start = shiftHalfDay(startAt, timeZone, direction);
  return { startAt: start, endAt: shiftInstant(start, lengthMinutes) };
}
