import type { CommitmentCreate, CommitmentDraft } from '../api';
import { weeklyDaysFromRrule, type WeekdayCode } from './rrule';
import { localInputValue, zonedWallClockToInstant } from './time';

/**
 * CAL-02: a draft read from a natural-language note ("다음 주 화요일 오후 3시에
 * 치과") and what the screen needs to add it. The server already turned the
 * model's local date/time into instants; a draft without `startAt` had no time
 * in the note, and the row asks for one before it can be added.
 */

/** Length of a draft whose end was not given (the server uses the same default). */
export const DEFAULT_DRAFT_MINUTES = 60;

/** The time inputs of a draft row (`<input type="time">` values, may be empty). */
export interface DraftTimes {
  readonly start: string;
  readonly end: string;
}

const CLOCK = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Minutes after midnight of an `HH:mm` value, or null. */
export function clockMinutes(value: string): number | null {
  const match = CLOCK.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function draftHasTime(draft: CommitmentDraft): boolean {
  return draft.startAt !== undefined && draft.endAt !== undefined;
}

/** The instants of a draft: its own, or the ones the row's typed times give (same day). */
export function draftInstants(
  draft: CommitmentDraft,
  times: DraftTimes,
): { readonly startAt: string; readonly endAt: string; readonly endDefaulted: boolean } | null {
  if (draft.startAt !== undefined && draft.endAt !== undefined) {
    return { startAt: draft.startAt, endAt: draft.endAt, endDefaulted: false };
  }
  const start = clockMinutes(times.start);
  if (start === null) return null;
  const typedEnd = times.end.trim().length === 0 ? null : clockMinutes(times.end);
  if (times.end.trim().length > 0 && typedEnd === null) return null;
  const end = typedEnd ?? start + DEFAULT_DRAFT_MINUTES;
  if (end <= start) return null;
  try {
    return {
      startAt: zonedWallClockToInstant(draft.date, start, draft.timeZone),
      endAt: zonedWallClockToInstant(draft.date, end, draft.timeZone),
      endDefaulted: typedEnd === null,
    };
  } catch {
    return null;
  }
}

/** The `POST /commitments` body for a draft, or null while it still needs a valid time. */
export function draftCreateInput(draft: CommitmentDraft, times: DraftTimes): CommitmentCreate | null {
  const title = draft.title.trim();
  const instants = draftInstants(draft, times);
  if (title.length === 0 || instants === null) return null;
  return {
    title,
    startAt: instants.startAt,
    endAt: instants.endAt,
    timeZone: draft.timeZone,
    ...(draft.rrule === undefined ? {} : { rrule: draft.rrule }),
  };
}

/** What 고치기 loads into the manual form (`datetime-local` values in the draft's zone). */
export interface DraftFormValues {
  readonly title: string;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly timeZone: string;
  readonly rrule: string;
}

export function draftFormValues(draft: CommitmentDraft, times: DraftTimes): DraftFormValues {
  const instants = draftInstants(draft, times);
  if (instants !== null) {
    return {
      title: draft.title,
      startLocal: localInputValue(instants.startAt, draft.timeZone),
      endLocal: localInputValue(instants.endAt, draft.timeZone),
      timeZone: draft.timeZone,
      rrule: draft.rrule ?? '',
    };
  }
  // No usable time yet: the form opens on that day at 09:00-10:00 for the person to change.
  return {
    title: draft.title,
    startLocal: `${draft.date}T09:00`,
    endLocal: `${draft.date}T10:00`,
    timeZone: draft.timeZone,
    rrule: draft.rrule ?? '',
  };
}

export interface WeeklyRepeat {
  readonly days: readonly WeekdayCode[];
  /** Local `YYYY-MM-DD` of the DATE-form UNTIL, when the repeat ends. */
  readonly until: string | null;
}

/** The weekly repeat of a drafted RRULE (`FREQ=WEEKLY;BYDAY=…[;UNTIL=YYYYMMDD]`), or null. */
export function weeklyRepeatOf(rrule: string | undefined): WeeklyRepeat | null {
  if (rrule === undefined || !/^FREQ=WEEKLY(;|$)/i.test(rrule)) return null;
  const days = weeklyDaysFromRrule(rrule);
  if (days.length === 0) return null;
  const until = /(?:^|;)UNTIL=(\d{4})(\d{2})(\d{2})(?:;|$)/i.exec(rrule);
  return { days, until: until === null ? null : `${until[1]}-${until[2]}-${until[3]}` };
}
