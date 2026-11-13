import {
  TASK_PARSE_LEFTOVER_MAX,
  type TaskDraft,
  type TaskDraftNote,
  type TaskParseRequest,
  type TaskParseResponse,
} from '@ohmydate/contracts';
import { epochMsToInstant, type Id } from '@ohmydate/domain';
import {
  DEFAULT_TASK_PARSE_MAX_OUTPUT_TOKENS,
  DEFAULT_TASK_PARSE_TIMEOUT_MS,
  TASK_PARSE_PROMPT,
  TASK_PARSE_SCHEMA_ID,
  buildTaskParseInput,
  type PromptLimits,
  type TaskParseItem,
  type TaskParseOutput,
} from '@ohmydate/llm';
import { Temporal } from 'temporal-polyfill';
import {
  NoteDraftReader,
  parseLocalDate,
  parseLocalTime,
  truncateText,
  zonedWallClockInstant,
  type DraftConversionContext,
  type NoteReaderOptions,
} from '../nl-read/note-draft-reader.js';

/**
 * CAL-05: natural-language task entry in the inbox (`POST /tasks:parse`).
 *
 * The person writes what they have to do ("금요일까지 보고서 초안, 내일까지
 * 교수님께 메일, 장보기"); the model (task_parse@v1) returns each to-do with its
 * LOCAL deadline date / time, and this use-case turns every item into a task
 * draft:
 *
 * - no date -> a task without a deadline (it is never dropped);
 * - local date + time in the zone -> a UTC instant through Temporal (DST gap:
 *   the next valid instant, fold: the first one; 08 §3), never `Date` math;
 * - a date without a time -> 23:59 local on that day (`due_time_defaulted`).
 *   The app has no date-only deadline convention yet (the task detail shows
 *   `dueAt` as a date-time and the only due input, the wizard's, is a
 *   date-time), so the end of the local day is used;
 * - a guessed day -> `date_assumed`; a bare 7-11 hour read as AM ->
 *   `meridiem_assumed` (CAL-05 addendum);
 * - the deadline is validated AFTER the schema: a real calendar date and time,
 *   not more than 1 day in the past, not more than 2 years ahead. A failing
 *   deadline is removed and the task kept with `due_dropped`: a to-do does not
 *   vanish because its date was odd.
 *
 * The run lifecycle, failure mapping and logging rules are the shared
 * NoteDraftReader (the same as `POST /commitments:parse`). Nothing is written
 * except the `agent_run` row; the client adds each draft through `POST /tasks`.
 */

export const TASK_PARSE_PURPOSE = 'task_parse';
export const TASK_PARSE_LIMITS: PromptLimits = Object.freeze({
  maxOutputTokens: DEFAULT_TASK_PARSE_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_TASK_PARSE_TIMEOUT_MS,
});
/** The local time a date-only deadline gets (the end of that day). */
export const TASK_DUE_DEFAULT_TIME = '23:59';
/** A deadline must not be more than this long before now. */
const PAST_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const LEFTOVER_SEPARATOR = ' / ';
const TITLE_MAX = 200;

export type TaskParseServiceOptions = NoteReaderOptions;

class DroppedDue extends Error {}

/** Notes in the documented order, whatever order they were found in. */
function ordered(notes: ReadonlySet<TaskDraftNote>): TaskDraftNote[] {
  return (['due_time_defaulted', 'date_assumed', 'meridiem_assumed', 'due_dropped'] as const).filter((note) =>
    notes.has(note),
  );
}

/** The deadline of one item as an instant, with its notes; throws DroppedDue when unusable. */
function dueOf(
  item: TaskParseItem & { readonly dueDate: string },
  context: DraftConversionContext,
): { readonly dueAt: string; readonly notes: Set<TaskDraftNote> } {
  const notes = new Set<TaskDraftNote>();
  const date = parseLocalDate(item.dueDate);
  if (date === null) throw new DroppedDue('not a calendar date');
  const time = parseLocalTime(item.dueTime ?? TASK_DUE_DEFAULT_TIME);
  if (time === null) throw new DroppedDue('not a wall-clock time');
  if (item.dueTime === null) notes.add('due_time_defaulted');
  if (item.dateWasGuessed) notes.add('date_assumed');
  if (item.dueTime !== null && item.meridiemWasGuessed) notes.add('meridiem_assumed');

  const zonedNow = Temporal.Instant.fromEpochMilliseconds(context.nowMs).toZonedDateTimeISO(context.timeZone);
  // "At most 2 years ahead": the same local wall clock two years from now; a
  // date-only deadline on that last day is still accepted.
  const latestZoned = zonedNow.add({ years: 2 });
  if (Temporal.PlainDate.compare(date, latestZoned.toPlainDate()) > 0) throw new DroppedDue('too far ahead');
  const due = zonedWallClockInstant(date, time, context.timeZone);
  if (item.dueTime !== null && due.epochMilliseconds > latestZoned.epochMilliseconds) {
    throw new DroppedDue('too far ahead');
  }
  if (due.epochMilliseconds < context.nowMs - PAST_TOLERANCE_MS) throw new DroppedDue('past');
  return { dueAt: epochMsToInstant(due.epochMilliseconds), notes };
}

function convertItem(item: TaskParseItem, context: DraftConversionContext): TaskDraft | null {
  const title = item.title.trim();
  if (title.length === 0) return null;
  const draftTitle = Array.from(title).length > TITLE_MAX ? truncateText(title, TITLE_MAX) : title;
  if (item.dueDate === null) {
    // A time without a day breaks the prompt's rule: keep the task, say the deadline was dropped.
    return { title: draftTitle, notes: item.dueTime === null ? [] : ['due_dropped'] };
  }
  try {
    const due = dueOf({ ...item, dueDate: item.dueDate }, context);
    return { title: draftTitle, dueAt: due.dueAt, notes: ordered(due.notes) };
  } catch (error) {
    if (!(error instanceof DroppedDue) && !(error instanceof RangeError)) throw error;
    return { title: draftTitle, notes: ['due_dropped'] };
  }
}

/**
 * Pure: schema-valid model output -> task drafts + leftover (exported for
 * tests). Items keep their order; an item whose deadline fails validation
 * stays a draft without `dueAt` (`due_dropped`). Only an item with a blank
 * title cannot become a task; its date goes to the leftover.
 */
export function taskDraftsFromOutput(output: TaskParseOutput, context: DraftConversionContext): TaskParseResponse {
  const drafts: TaskDraft[] = [];
  const leftover: string[] = [];
  if (output.leftover.trim().length > 0) leftover.push(output.leftover.trim());
  for (const item of output.items) {
    const draft = convertItem(item, context);
    if (draft !== null) {
      drafts.push(draft);
      continue;
    }
    const when = [item.dueDate, item.dueTime].filter((part): part is string => part !== null).join(' ');
    if (when.length > 0) leftover.push(`(${when})`);
  }
  return { drafts, leftover: truncateText(leftover.join(LEFTOVER_SEPARATOR), TASK_PARSE_LEFTOVER_MAX) };
}

/** The task_parse@v1 reader (shared lifecycle: nl-read/note-draft-reader.ts). */
const TASK_READER = {
  prompt: TASK_PARSE_PROMPT,
  schemaId: TASK_PARSE_SCHEMA_ID,
  purpose: TASK_PARSE_PURPOSE,
  defaultLimits: TASK_PARSE_LIMITS,
  subject: 'task',
  buildInput: buildTaskParseInput,
  convert: taskDraftsFromOutput,
} as const;

export class TaskParseService {
  readonly #reader: NoteDraftReader<TaskParseOutput, TaskParseResponse>;

  constructor(options: TaskParseServiceOptions) {
    this.#reader = new NoteDraftReader(TASK_READER, options);
  }

  /** Wall-clock bound of one read (one attempt + one repair + slack): 50 s by default. */
  get totalTimeoutMs(): number {
    return this.#reader.totalTimeoutMs;
  }

  /**
   * Read `request.text` into task drafts. `signal` aborts the model call
   * (client disconnect or shutdown): the run is settled `cancelled` and the
   * request fails as 503 llm_unavailable (not stored for idempotency).
   */
  parse(ownerId: Id, request: TaskParseRequest, signal?: AbortSignal): Promise<TaskParseResponse> {
    return this.#reader.read(ownerId, request, signal);
  }
}
