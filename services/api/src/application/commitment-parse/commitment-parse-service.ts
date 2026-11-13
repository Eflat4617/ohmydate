import {
  COMMITMENT_PARSE_LEFTOVER_MAX,
  type CommitmentDraft,
  type CommitmentDraftNote,
  type CommitmentParseRequest,
  type CommitmentParseResponse,
} from '@ohmydate/contracts';
import { ValidationFailedError, epochMsToInstant, type Id } from '@ohmydate/domain';
import {
  COMMITMENT_PARSE_PROMPT,
  COMMITMENT_PARSE_SCHEMA_ID,
  DEFAULT_COMMITMENT_PARSE_MAX_OUTPUT_TOKENS,
  DEFAULT_COMMITMENT_PARSE_TIMEOUT_MS,
  WEEKDAY_CODES,
  buildCommitmentParseInput,
  type CommitmentParseItem,
  type CommitmentParseOutput,
  type PromptLimits,
  type WeekdayCode,
} from '@ohmydate/llm';
import { Temporal } from 'temporal-polyfill';
import {
  NoteDraftReader,
  localNowOf,
  parseLocalDate,
  parseLocalTime,
  truncateText,
  zonedWallClockInstant,
  type DraftConversionContext,
  type NoteReaderOptions,
} from '../nl-read/note-draft-reader.js';
import { validateCommitment } from '../plan-service.js';

export { localNowOf, type DraftConversionContext };

/**
 * CAL-02: natural-language commitment entry (`POST /commitments:parse`).
 *
 * The person writes what they have on ("다음 주 화요일 오후 3시에 치과"); the
 * model (commitment_parse@v1) returns LOCAL dates and times only, and this
 * use-case turns every item into a draft:
 *
 * - local date + time in the zone -> UTC instants through Temporal (DST gap:
 *   the next valid instant, fold: the first one; 08 §3), never `Date` math;
 * - no end time -> start + 60 min (`duration_defaulted`); a guessed date ->
 *   `date_assumed`; `weeklyDays` -> `FREQ=WEEKLY;BYDAY=…[;UNTIL=…]`
 *   (`repeats_weekly`); a bare 7-11 hour read as AM -> `meridiem_assumed`
 *   (CAL-05 addendum);
 * - every item is validated AFTER the schema: a real calendar date, end after
 *   start, start at most 1 day in the past and at most 2 years ahead, plus the
 *   create-path bounds (`validateCommitment`). A failing item is dropped into
 *   `leftover`; it is never a 500.
 *
 * Nothing is written except the `agent_run` row (pending before the call,
 * settled after, spend-ledger linked through `agentRunId`). The drafts are a
 * proposal: the client adds each one through `POST /commitments`. The note,
 * the titles and the prompt are never logged or stored here. The run
 * lifecycle and failure mapping are the shared NoteDraftReader (CAL-05).
 */

export const COMMITMENT_PARSE_PURPOSE = 'commitment_parse';
export const COMMITMENT_PARSE_LIMITS: PromptLimits = Object.freeze({
  maxOutputTokens: DEFAULT_COMMITMENT_PARSE_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_COMMITMENT_PARSE_TIMEOUT_MS,
});
/** A draft must not start more than this long before now. */
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DURATION_MINUTES = 60;
const LEFTOVER_SEPARATOR = ' / ';

export type CommitmentParseServiceOptions = NoteReaderOptions;

export interface DraftConversion {
  readonly drafts: CommitmentDraft[];
  readonly leftover: string;
}

class DroppedItem extends Error {}

function plainDate(value: string): Temporal.PlainDate {
  const date = parseLocalDate(value);
  if (date === null) throw new DroppedItem('not a calendar date');
  return date;
}

function plainTime(value: string): Temporal.PlainTime {
  const time = parseLocalTime(value);
  if (time === null) throw new DroppedItem('not a wall-clock time');
  return time;
}

function isoInstant(instant: Temporal.Instant): string {
  return epochMsToInstant(instant.epochMilliseconds);
}

function orderedDays(days: readonly WeekdayCode[]): WeekdayCode[] {
  const wanted = new Set(days);
  return WEEKDAY_CODES.filter((code) => wanted.has(code));
}

/** How the dropped item reads in `leftover`: its title and the model's date/time, no instant. */
function leftoverText(item: CommitmentParseItem): string {
  const when = [item.date, item.startTime].filter((part) => part !== null && part.length > 0).join(' ');
  const title = item.title.trim();
  if (when.length === 0) return title;
  return title.length === 0 ? `(${when})` : `${title} (${when})`;
}

function convertItem(item: CommitmentParseItem, context: DraftConversionContext): CommitmentDraft {
  const title = item.title.trim();
  if (title.length === 0 || title.length > 200) throw new DroppedItem('title');
  const notes: CommitmentDraftNote[] = [];
  const zonedNow = Temporal.Instant.fromEpochMilliseconds(context.nowMs).toZonedDateTimeISO(context.timeZone);
  const today = zonedNow.toPlainDate();
  // "At most 2 years ahead": the same local wall clock two years from now.
  const latestZoned = zonedNow.add({ years: 2 });
  const latest = latestZoned.toPlainDate();
  let date = plainDate(item.date);

  let rrule: string | undefined;
  if (item.weeklyDays !== null && item.weeklyDays.length > 0) {
    const days = orderedDays(item.weeklyDays);
    // The first occurrence is the start: move forward to the first listed weekday.
    for (let step = 0; step < 7 && !days.includes(WEEKDAY_CODES[date.dayOfWeek - 1] as WeekdayCode); step += 1) {
      date = date.add({ days: 1 });
    }
    rrule = `FREQ=WEEKLY;BYDAY=${days.join(',')}`;
    if (item.untilDate !== null) {
      const until = plainDate(item.untilDate);
      if (Temporal.PlainDate.compare(until, date) < 0) throw new DroppedItem('until before start');
      rrule += `;UNTIL=${until.toString().replaceAll('-', '')}`;
    }
    notes.push('repeats_weekly');
  }
  if (item.dateWasGuessed) notes.push('date_assumed');

  if (Temporal.PlainDate.compare(date, today.subtract({ days: 1 })) < 0) throw new DroppedItem('past');
  if (Temporal.PlainDate.compare(date, latest) > 0) throw new DroppedItem('too far ahead');

  const base = {
    title,
    timeZone: context.timeZone,
    date: date.toString(),
    ...(rrule === undefined ? {} : { rrule }),
  };
  if (item.startTime === null) {
    // No time in the note: the client asks for it before the draft can be added.
    return { ...base, notes };
  }

  const start = zonedWallClockInstant(date, plainTime(item.startTime), context.timeZone);
  let end: Temporal.Instant;
  if (item.endTime === null) {
    end = start.add({ minutes: DEFAULT_DURATION_MINUTES });
    notes.unshift('duration_defaulted');
  } else {
    const endDate = item.endDate === null ? date : plainDate(item.endDate);
    end = zonedWallClockInstant(endDate, plainTime(item.endTime), context.timeZone);
  }
  if (item.meridiemWasGuessed) notes.push('meridiem_assumed');
  if (Temporal.Instant.compare(end, start) <= 0) throw new DroppedItem('end not after start');
  if (start.epochMilliseconds < context.nowMs - PAST_TOLERANCE_MS) throw new DroppedItem('past');
  if (start.epochMilliseconds > latestZoned.epochMilliseconds) throw new DroppedItem('too far ahead');

  const startAt = isoInstant(start);
  const endAt = isoInstant(end);
  try {
    // The same bounds the create call enforces (interval, RRULE shape and COUNT).
    validateCommitment(
      { title, startAt, endAt, timeZone: context.timeZone, ...(rrule === undefined ? {} : { rrule }) },
      epochMsToInstant(context.nowMs),
    );
  } catch (error) {
    if (error instanceof ValidationFailedError) throw new DroppedItem('create bounds');
    throw error;
  }
  return { ...base, startAt, endAt, notes };
}

/**
 * Pure: schema-valid model output -> drafts + leftover (exported for tests).
 * Items keep their order; an item that fails validation is dropped and its
 * text appended to the leftover.
 */
export function draftsFromOutput(output: CommitmentParseOutput, context: DraftConversionContext): DraftConversion {
  const drafts: CommitmentDraft[] = [];
  const leftover: string[] = [];
  if (output.leftover.trim().length > 0) leftover.push(output.leftover.trim());
  for (const item of output.items) {
    try {
      drafts.push(convertItem(item, context));
    } catch (error) {
      if (!(error instanceof DroppedItem) && !(error instanceof RangeError)) throw error;
      const text = leftoverText(item);
      if (text.length > 0) leftover.push(text);
    }
  }
  return { drafts, leftover: truncateText(leftover.join(LEFTOVER_SEPARATOR), COMMITMENT_PARSE_LEFTOVER_MAX) };
}

/** The commitment_parse@v1 reader (shared lifecycle: nl-read/note-draft-reader.ts). */
const COMMITMENT_READER = {
  prompt: COMMITMENT_PARSE_PROMPT,
  schemaId: COMMITMENT_PARSE_SCHEMA_ID,
  purpose: COMMITMENT_PARSE_PURPOSE,
  defaultLimits: COMMITMENT_PARSE_LIMITS,
  subject: 'commitment',
  buildInput: buildCommitmentParseInput,
  convert: draftsFromOutput,
} as const;

export class CommitmentParseService {
  readonly #reader: NoteDraftReader<CommitmentParseOutput, CommitmentParseResponse>;

  constructor(options: CommitmentParseServiceOptions) {
    this.#reader = new NoteDraftReader(COMMITMENT_READER, options);
  }

  /** Wall-clock bound of one read (one attempt + one repair + slack): 50 s by default. */
  get totalTimeoutMs(): number {
    return this.#reader.totalTimeoutMs;
  }

  /**
   * Read `request.text` into drafts. `signal` aborts the model call (client
   * disconnect or shutdown): the run is settled `cancelled` and the request
   * fails as 503 llm_unavailable (not stored for idempotency, so it can retry).
   */
  parse(ownerId: Id, request: CommitmentParseRequest, signal?: AbortSignal): Promise<CommitmentParseResponse> {
    return this.#reader.read(ownerId, request, signal);
  }
}
