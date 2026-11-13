/**
 * CAL-02: natural-language commitment entry ("다음 주 화요일 오후 3시에 치과").
 *
 * The model reads the person's note into local-date / local-time drafts; the
 * API converts them to instants in the owner's zone, validates them and
 * returns them as proposals. Nothing is saved by the read: the person adds each
 * draft through the ordinary commitment create call (05 §1).
 *
 * This module owns the prompt's input shape so the API, the contract smoke and
 * the injection evaluation build exactly the same object:
 *
 * - the note itself only inside one escaped `<untrusted_document>` block, after
 *   the same privacy masking the intake prompts get (05 §9, §12);
 * - `now` (local date, weekday, time) and `calendar` (the coming days with their
 *   weekday and week index) are computed by the caller from its clock and the
 *   IANA zone, so the model never does calendar or time-zone arithmetic;
 * - `outputLanguage` is the resolved owner locale (never note text).
 */

import { buildUntrustedBlock, redact, type RedactionKind } from './privacy.js';

export const COMMITMENT_PARSE_PROMPT = { promptId: 'commitment_parse', version: 'v1' } as const;
export const COMMITMENT_PARSE_SCHEMA_ID = 'llm.commitment_parse.v1';
export const COMMITMENT_PARSE_CONFIG_VERSION = 'commitment-parse@1';
/** The fence id of the note block (one block per call). */
export const COMMITMENT_TEXT_BLOCK_ID = 'commitment-text';
/** Longest note the API accepts (characters, after trimming). */
export const MAX_COMMITMENT_TEXT_LENGTH = 500;
/** Most drafts one read may return (schema `maxItems`). */
export const MAX_COMMITMENT_DRAFTS = 10;
/** How many coming days `calendar` lists (this week, next week and the week after). */
export const COMMITMENT_CALENDAR_DAYS = 21;

export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface CommitmentParseNow {
  /** Local date `YYYY-MM-DD` in `timeZone`. */
  readonly date: string;
  readonly weekday: WeekdayCode;
  /** Local wall-clock time `HH:mm`. */
  readonly time: string;
}

export interface CommitmentCalendarDay {
  readonly date: string;
  readonly weekday: WeekdayCode;
  /** 0 = this week (Monday to Sunday), 1 = next week, 2 = the week after. */
  readonly week: number;
}

export interface CommitmentParseInputRequest {
  readonly text: string;
  readonly now: CommitmentParseNow;
  readonly calendar: readonly CommitmentCalendarDay[];
  readonly timeZone: string;
  readonly outputLanguage: string;
}

export interface CommitmentParseInputBundle {
  readonly input: {
    readonly configVersion: string;
    readonly outputLanguage: string;
    readonly timeZone: string;
    readonly now: CommitmentParseNow;
    readonly calendar: readonly CommitmentCalendarDay[];
    readonly text: string;
  };
  /** Kinds and counts of masked values only (never the values). */
  readonly redactionReport: Readonly<Record<string, number>>;
}

/** One item of `llm.commitment_parse.v1` (schema-validated before use). */
export interface CommitmentParseItem {
  readonly title: string;
  readonly date: string;
  readonly startTime: string | null;
  readonly endTime: string | null;
  readonly endDate: string | null;
  readonly weeklyDays: readonly WeekdayCode[] | null;
  readonly untilDate: string | null;
  readonly dateWasGuessed: boolean;
  /**
   * CAL-05 addendum: the start was a bare hour from 7 to 11 read as AM (no
   * 오전/오후 word, no 24-hour form, no evening context). The API marks the
   * draft `meridiem_assumed` so the person sees that the half-day was a guess.
   */
  readonly meridiemWasGuessed: boolean;
}

export interface CommitmentParseOutput {
  readonly items: readonly CommitmentParseItem[];
  readonly leftover: string;
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a proleptic Gregorian date (integer math, no Date). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function civilFromDays(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The `calendar` input: `days` local dates from `today` (a local `YYYY-MM-DD`)
 * with their ISO weekday and week index (0 = the Monday-to-Sunday week that
 * contains today). Pure civil-date math, so every caller gets the same list.
 */
export function commitmentCalendar(today: string, days: number = COMMITMENT_CALENDAR_DAYS): CommitmentCalendarDay[] {
  const match = CIVIL_DATE.exec(today);
  if (match === null) throw new RangeError('today must be a YYYY-MM-DD date');
  const start = daysFromCivil(Number(match[1]), Number(match[2]), Number(match[3]));
  if (civilFromDays(start) !== today) throw new RangeError('today must be a real calendar date');
  // 1970-01-01 was a Thursday (index 3 with Monday = 0).
  const mondayIndex = (((start + 3) % 7) + 7) % 7;
  return Array.from({ length: Math.max(0, Math.floor(days)) }, (_, offset) => ({
    date: civilFromDays(start + offset),
    weekday: WEEKDAY_CODES[(mondayIndex + offset) % 7] as WeekdayCode,
    week: Math.floor((mondayIndex + offset) / 7),
  }));
}

/**
 * The structured input shared by the natural-language readers
 * (commitment_parse@v1, CAL-05 task_parse@v1): the note masked (ADR-019) and
 * fenced in one block named `blockId`; everything else is caller-computed,
 * non-free-text data.
 */
export function buildNoteReadInput(
  configVersion: string,
  blockId: string,
  request: CommitmentParseInputRequest,
): CommitmentParseInputBundle {
  const redacted = redact(request.text);
  const report: Record<string, number> = {};
  for (const entry of redacted.report as readonly { readonly kind: RedactionKind; readonly count: number }[]) {
    report[entry.kind] = (report[entry.kind] ?? 0) + entry.count;
  }
  return {
    input: {
      configVersion,
      outputLanguage: request.outputLanguage,
      timeZone: request.timeZone,
      now: { date: request.now.date, weekday: request.now.weekday, time: request.now.time },
      calendar: request.calendar.map((day) => ({ date: day.date, weekday: day.weekday, week: day.week })),
      text: buildUntrustedBlock(blockId, redacted.text),
    },
    redactionReport: report,
  };
}

/** The structured input of commitment_parse@v1. */
export function buildCommitmentParseInput(request: CommitmentParseInputRequest): CommitmentParseInputBundle {
  return buildNoteReadInput(COMMITMENT_PARSE_CONFIG_VERSION, COMMITMENT_TEXT_BLOCK_ID, request);
}
