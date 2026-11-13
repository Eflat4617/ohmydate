import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { IanaTimeZoneSchema, InstantSchema } from './common.js';

/**
 * CAL-05: natural-language task entry in the inbox (08 §2.1b).
 *
 * `POST /tasks:parse` reads a short to-do note ("금요일까지 보고서 초안, 내일까지
 * 교수님께 메일") into task drafts. Nothing is saved by the read: a draft is an
 * AI proposal the person adds through `POST /tasks` (05 §1). Same request
 * rules as `POST /commitments:parse` (CAL-02).
 */

/** Longest note (characters). The server trims it first; an all-space note is 422. */
export const TASK_PARSE_TEXT_MAX = 500;
/** Most drafts one read returns. */
export const TASK_DRAFTS_MAX = 10;
/** Bound of the response `leftover` (the model's own leftover plus unreadable items). */
export const TASK_PARSE_LEFTOVER_MAX = 3_000;

export const TaskParseRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: TASK_PARSE_TEXT_MAX, pattern: '\\S' }),
    /** IANA zone the note is read in; default = the owner's zone (`User.timeZone`). */
    timeZone: Type.Optional(IanaTimeZoneSchema),
  },
  { additionalProperties: false, $id: 'TaskParseRequest' },
);

/**
 * Why a draft is not exactly what the note said:
 * - `due_time_defaulted`: a day without a time; the deadline is 23:59 local on that day.
 * - `date_assumed`: no day was given (a time only) or only a vague one ("이번 주까지").
 * - `meridiem_assumed`: the time was a bare hour from 7 to 11 with no 오전/오후 word;
 *   it was read as AM and the person may switch it.
 * - `due_dropped`: the model's deadline was not usable (no real date, more than a day
 *   in the past, more than 2 years ahead); the task is kept without a deadline.
 */
export const TASK_DRAFT_NOTES = ['due_time_defaulted', 'date_assumed', 'meridiem_assumed', 'due_dropped'] as const;

export type TaskDraftNote = (typeof TASK_DRAFT_NOTES)[number];

export const TaskDraftNoteSchema = Type.Union(
  TASK_DRAFT_NOTES.map((note) => Type.Literal(note)) as TLiteral<TaskDraftNote>[],
);

/**
 * One task draft: the title in the person's words and, when the note gave one,
 * the deadline as a UTC instant the server computed from the model's local
 * date/time in the read's zone. No `dueAt` = a task without a deadline.
 */
export const TaskDraftSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    dueAt: Type.Optional(InstantSchema),
    notes: Type.Array(TaskDraftNoteSchema, { maxItems: TASK_DRAFT_NOTES.length }),
  },
  { additionalProperties: false, $id: 'TaskDraft' },
);

export const TaskParseResponseSchema = Type.Object(
  {
    drafts: Type.Array(TaskDraftSchema, { maxItems: TASK_DRAFTS_MAX }),
    /** What could not be read into a task ("" when everything was). */
    leftover: Type.String({ maxLength: TASK_PARSE_LEFTOVER_MAX }),
  },
  { additionalProperties: false, $id: 'TaskParseResponse' },
);

export type TaskParseRequest = Static<typeof TaskParseRequestSchema>;
export type TaskDraft = Static<typeof TaskDraftSchema>;
export type TaskParseResponse = Static<typeof TaskParseResponseSchema>;
