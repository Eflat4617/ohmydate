import type { CommitmentCreate, CommitmentDraft, TaskCreate, TaskDraft } from '../api';
import { DEFAULT_DRAFT_MINUTES } from './commitmentDraft';
import { TASK_TITLE_MAX } from './taskDraft';
import { instantFromLocalInput, zonedWallClockToInstant } from './time';

/**
 * 담기 (HOLO-04, FLOW.md §2 ①): one line of plain Korean becomes to-dos and
 * appointments. Everything here is pure — what a line looks like, which of
 * the two readers should read it, and how a draft of one kind becomes a
 * draft of the other.
 *
 * There is no reader that tells a to-do from an appointment (the contract
 * has `POST /tasks:parse` and `POST /commitments:parse`), so the line's own
 * look picks the reader, and every draft can be flipped to the other kind
 * before it is added.
 */
export type CaptureKind = 'task' | 'commitment';

/** A clock time: `3시`, `15:30`, `오후 3`, `저녁 7`. */
const CLOCK = /(\d{1,2}\s*시)|(\d{1,2}:\d{2})|((오전|오후|아침|점심|저녁|밤|새벽)\s*\d{1,2})/;
/** "by then": a time that is a deadline, not a meeting. */
const DEADLINE = /까지|마감|제출|내로|이내|안에/;
/** Words for something one goes to at a fixed time. */
const APPOINTMENT =
  /약속|회의|미팅|모임|수업|강의|세미나|면접|면담|상담|예약|병원|치과|진료|검진|결혼식|돌잔치|장례|공연|콘서트|영화|식사|점심 약속|저녁 약속|회식|통화|스터디|데이트|출장|비행기|기차|레슨|학원/;
/** A day or a date: enough to make reading worth it. */
const DAY =
  /오늘|내일|모레|글피|이번\s*주|다음\s*주|이번\s*달|다음\s*달|주말|평일|[월화수목금토일]요일|매주|매일|매달|격주|\d{1,2}\s*월|\d{1,2}\s*일|\d{1,2}\/\d{1,2}|\d+\s*(분|시간|일|주)\s*(뒤|후|동안)/;

/** The separate things a line names: split on commas, line breaks, semicolons and "그리고". */
export function captureSegments(text: string): string[] {
  return text
    .split(/[,，、;；\n]+|\s+그리고\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** What one segment looks like: an appointment has a clock time (or is a kind of meeting) and is not a deadline. */
export function segmentKind(segment: string): CaptureKind {
  if (DEADLINE.test(segment)) return 'task';
  if (CLOCK.test(segment) || APPOINTMENT.test(segment)) return 'commitment';
  return 'task';
}

/**
 * Which reader reads the line. Appointments only when every segment looks
 * like one: a to-do read as an appointment would lose its "by when", while
 * an appointment read as a to-do keeps its time as the deadline and flips
 * back with one press.
 */
export function captureKindOf(text: string): CaptureKind {
  const segments = captureSegments(text);
  return segments.length > 0 && segments.every((segment) => segmentKind(segment) === 'commitment') ? 'commitment' : 'task';
}

/**
 * Whether the line needs reading at all. One thing with no day, time or
 * appointment word in it is already a to-do's title: it is added as it is,
 * at once, without waiting for the AI.
 */
export function captureNeedsReading(text: string): boolean {
  const segments = captureSegments(text);
  if (segments.length !== 1) return segments.length > 1;
  const only = segments[0] ?? '';
  return CLOCK.test(only) || DAY.test(only) || DEADLINE.test(only) || APPOINTMENT.test(only);
}

/** The title a line gives a to-do when nothing reads it: trimmed, one line, within the limit. */
export function captureTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return Array.from(oneLine).slice(0, TASK_TITLE_MAX).join('');
}

/** What a row of the capture bar holds, whichever reader made it. */
export interface CaptureFields {
  kind: CaptureKind;
  title: string;
  /** A to-do's deadline, or an appointment's start. Null: none (a to-do) or not known yet (an appointment). */
  at: string | null;
  /** An appointment's end. */
  endAt: string | null;
  /** An appointment's repeat rule, kept through a flip to a to-do and back. */
  rrule: string | undefined;
  timeZone: string;
}

export function fieldsOfTaskDraft(draft: TaskDraft, timeZone: string): CaptureFields {
  return { kind: 'task', title: draft.title, at: draft.dueAt ?? null, endAt: null, rrule: undefined, timeZone };
}

export function fieldsOfCommitmentDraft(draft: CommitmentDraft): CaptureFields {
  return {
    kind: 'commitment',
    title: draft.title,
    at: draft.startAt ?? null,
    endAt: draft.endAt ?? null,
    rrule: draft.rrule,
    timeZone: draft.timeZone,
  };
}

function plusMinutes(instant: string, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

/**
 * The same thing as the other kind.
 *
 * - to-do → appointment: its deadline is when it starts, for an hour. Without
 *   a deadline the appointment has no time yet (the row asks for one).
 * - appointment → to-do: its start is the deadline. One that had only a day
 *   (`date`) is due at the end of that day.
 */
export function flipCapture(fields: CaptureFields, dayWithoutTime: string | null = null): CaptureFields {
  if (fields.kind === 'task') {
    return {
      ...fields,
      kind: 'commitment',
      endAt: fields.at === null ? null : plusMinutes(fields.at, DEFAULT_DRAFT_MINUTES),
    };
  }
  let due = fields.at;
  if (due === null && dayWithoutTime !== null) {
    try {
      due = zonedWallClockToInstant(dayWithoutTime, 23 * 60 + 59, fields.timeZone);
    } catch {
      due = null;
    }
  }
  return { ...fields, kind: 'task', at: due, endAt: null };
}

/** A start typed into the row (`datetime-local`), for an appointment that came without a time. */
export function withTypedStart(fields: CaptureFields, localValue: string): CaptureFields {
  try {
    const start = instantFromLocalInput(localValue, fields.timeZone);
    return { ...fields, at: start, endAt: plusMinutes(start, DEFAULT_DRAFT_MINUTES) };
  } catch {
    return { ...fields, at: null, endAt: null };
  }
}

export type CaptureCreate =
  | { readonly kind: 'task'; readonly body: TaskCreate }
  | { readonly kind: 'commitment'; readonly body: CommitmentCreate };

/** The create call of a row, or null while it cannot be added (no title; an appointment without a time). */
export function captureCreateInput(fields: CaptureFields): CaptureCreate | null {
  const title = fields.title.trim();
  if (title.length === 0 || Array.from(title).length > TASK_TITLE_MAX) return null;
  if (fields.kind === 'task') {
    return { kind: 'task', body: fields.at === null ? { title } : { title, dueAt: fields.at } };
  }
  if (fields.at === null || fields.endAt === null || Date.parse(fields.endAt) <= Date.parse(fields.at)) return null;
  return {
    kind: 'commitment',
    body: {
      title,
      startAt: fields.at,
      endAt: fields.endAt,
      timeZone: fields.timeZone,
      ...(fields.rrule === undefined ? {} : { rrule: fields.rrule }),
    },
  };
}

/** What was added, for the hand-off to the next stage. */
export interface CaptureAdded {
  readonly kind: CaptureKind;
  readonly id: string;
  readonly title: string;
  /** An appointment's start: where the planner opens. */
  readonly at: string | null;
}

/** Where the loop goes on from what was just added (FLOW.md §2 ①: "계획에 넣을까요?"). */
export function captureNextStep(
  added: readonly CaptureAdded[],
): { readonly to: 'plan'; readonly taskIds: readonly string[] } | { readonly to: 'planner'; readonly at: string | null } | null {
  const tasks = added.filter((item) => item.kind === 'task');
  if (tasks.length > 0) return { to: 'plan', taskIds: tasks.map((item) => item.id) };
  const first = added.find((item) => item.kind === 'commitment');
  return first === undefined ? null : { to: 'planner', at: first.at };
}

/** One task matches a search when its title holds every word typed (any case). */
export function matchesSearch(title: string, query: string): boolean {
  const words = query.toLocaleLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return false;
  const haystack = title.toLocaleLowerCase();
  return words.every((word) => haystack.includes(word));
}
