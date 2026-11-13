import { Type, type Static, type TLiteral } from '@sinclair/typebox';
import { IanaTimeZoneSchema, InstantSchema } from './common.js';
import { RRuleSchema } from './planning.js';

/**
 * CAL-02: natural-language commitment entry (08 §2.4b).
 *
 * `POST /commitments:parse` reads a short note ("다음 주 화요일 오후 3시에 치과")
 * into commitment drafts. Nothing is saved by the read: a draft is an AI
 * proposal the person adds through `POST /commitments` (05 §1).
 */

/** Longest note (characters). The server trims it first; an all-space note is 422. */
export const COMMITMENT_PARSE_TEXT_MAX = 500;
/** Most drafts one read returns. */
export const COMMITMENT_DRAFTS_MAX = 10;
/** Bound of the response `leftover` (the model's own leftover plus dropped drafts). */
export const COMMITMENT_PARSE_LEFTOVER_MAX = 3_000;

export const CommitmentParseRequestSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: COMMITMENT_PARSE_TEXT_MAX, pattern: '\\S' }),
    /** IANA zone the note is read in; default = the owner's availability zone. */
    timeZone: Type.Optional(IanaTimeZoneSchema),
  },
  { additionalProperties: false, $id: 'CommitmentParseRequest' },
);

/**
 * Why a draft is not exactly what the note said:
 * - `duration_defaulted`: no end time was given; the end is start + 60 min.
 * - `date_assumed`: no day was given (or only "주말"); the nearest date was taken.
 * - `repeats_weekly`: the note asked for a weekly repeat (`rrule`).
 * - `meridiem_assumed` (CAL-05 addendum): the start was a bare hour from 7 to 11
 *   with no 오전/오후 word; it was read as AM and the person may switch it.
 */
export const COMMITMENT_DRAFT_NOTES = ['duration_defaulted', 'date_assumed', 'repeats_weekly', 'meridiem_assumed'] as const;

export type CommitmentDraftNote = (typeof COMMITMENT_DRAFT_NOTES)[number];

export const CommitmentDraftNoteSchema = Type.Union(
  COMMITMENT_DRAFT_NOTES.map((note) => Type.Literal(note)) as TLiteral<CommitmentDraftNote>[],
);

/**
 * One draft. `startAt`/`endAt` are UTC instants the server computed from the
 * model's local date and time in `timeZone`; both are present or both absent.
 * Absent means the note gave no time and the client must ask for one before
 * the draft can be added. `date` is the local start date in `timeZone`.
 */
export const CommitmentDraftSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    timeZone: IanaTimeZoneSchema,
    date: Type.String({ format: 'date' }),
    startAt: Type.Optional(InstantSchema),
    endAt: Type.Optional(InstantSchema),
    rrule: Type.Optional(RRuleSchema),
    notes: Type.Array(CommitmentDraftNoteSchema, { maxItems: COMMITMENT_DRAFT_NOTES.length }),
  },
  { additionalProperties: false, $id: 'CommitmentDraft' },
);

export const CommitmentParseResponseSchema = Type.Object(
  {
    drafts: Type.Array(CommitmentDraftSchema, { maxItems: COMMITMENT_DRAFTS_MAX }),
    /** What could not be read into a draft ("" when everything was). */
    leftover: Type.String({ maxLength: COMMITMENT_PARSE_LEFTOVER_MAX }),
  },
  { additionalProperties: false, $id: 'CommitmentParseResponse' },
);

export type CommitmentParseRequest = Static<typeof CommitmentParseRequestSchema>;
export type CommitmentDraft = Static<typeof CommitmentDraftSchema>;
export type CommitmentParseResponse = Static<typeof CommitmentParseResponseSchema>;
