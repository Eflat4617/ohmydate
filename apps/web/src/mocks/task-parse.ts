import { HttpResponse, http } from 'msw';
import type { TaskDraft, TaskDraftNote, TaskParseResponse } from '../api/client';
import { localParts, todayInZone, zonedWallClockToInstant } from '../domain/time';
import { TIME, calendarFrom, dayOf, hourOf, meridiemGuessed, minuteOf, wait, type CalendarDay } from './commitment-parse';
import type { MockDb } from './db';
import { json, parseBody, parseIdempotency, problem, remember } from './handlers';

/**
 * CAL-05 mock of `POST /tasks:parse` (VITE_MOCK=1 and the unit tests).
 *
 * A small deterministic reader, not the product's parser (that is the model):
 * every comma / line-break separated part is a to-do. A day it knows (오늘,
 * 내일, 모레, [다음 주] X요일, N일; "X요일 전에" = the day before) and/or a time
 * ("9시", "오후 3시") is the deadline; a date without a time is due at 23:59
 * local. A part that reads like a remark (ends with "다" or "?") goes to
 * `leftover`. It writes nothing.
 */

const MAX_TEXT = 500;
const MAX_DRAFTS = 10;
const END_OF_DAY_MINUTES = 23 * 60 + 59;
const REMARK = /(?:다|\?)\s*[.!]*$/u;
const STRIP = [
  /(?:오늘|내일|모레|글피)/gu,
  /(?:이번|다음|다다음)\s*주(?:말)?/gu,
  /[월화수목금토일]요일/gu,
  /\d{1,2}\s*일/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)?\s*\d{1,2}\s*시(?:\s*반|\s*\d{1,2}\s*분)?/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)/gu,
  /(?:까지|전까지|전에|마감)/gu,
];

let parseDelayMs = 0;
let parseFailure: 'llm_unavailable' | 'budget_exceeded' | null = null;

/** Mock-mode knob (browser.ts): hold every inbox read this long, to show the wait state. */
export function setTaskParseDelay(ms: number): void {
  parseDelayMs = Math.max(0, Math.floor(ms));
}

/** Mock-mode knob (browser.ts): answer every inbox read with this 503, to show the failure line. */
export function setTaskParseFailure(code: 'llm_unavailable' | 'budget_exceeded' | null): void {
  parseFailure = code;
}

function draftOf(part: string, calendar: readonly CalendarDay[], nowMinutes: number, timeZone: string): TaskDraft | null {
  if (REMARK.test(part)) return null;
  const time = TIME.exec(part);
  let day = dayOf(part, calendar);
  if (day !== null && /요일\s*전에/u.test(part)) {
    const index = calendar.findIndex((entry) => entry.date === day?.date);
    const before = index > 0 ? calendar[index - 1]?.date : undefined;
    day = before === undefined ? null : { ...day, date: before };
  }
  const evening = /저녁|밤|퇴근/u.test(part);
  let minutes: number | null = null;
  if (time !== null) {
    const hour = hourOf(time[1], Number(time[2]), evening);
    if (hour <= 23) minutes = hour * 60 + minuteOf(time[3], time[4]);
  }
  const today = calendar[0] as CalendarDay;
  let guessed = day?.guessed ?? false;
  let date = day?.date ?? null;
  if (date === null && minutes !== null) {
    date = minutes <= nowMinutes ? (calendar[1]?.date ?? today.date) : today.date;
    guessed = true;
  }
  let title = part;
  for (const pattern of STRIP) title = title.replace(pattern, ' ');
  title = title.replace(/(?:^|\s)에(?=\s|$)/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (title.length === 0) title = part;
  const draft: { -readonly [K in keyof TaskDraft]: TaskDraft[K] } = {
    title: Array.from(title).slice(0, 200).join(''),
    notes: [],
  };
  if (date === null) return draft;
  const notes: TaskDraftNote[] = [];
  if (minutes === null) notes.push('due_time_defaulted');
  if (guessed) notes.push('date_assumed');
  if (time !== null && minutes !== null && meridiemGuessed(time[1], time[2] as string, evening)) {
    notes.push('meridiem_assumed');
  }
  draft.dueAt = zonedWallClockToInstant(date, minutes ?? END_OF_DAY_MINUTES, timeZone);
  draft.notes = notes;
  return draft;
}

/** The mock reading of a to-do note `text` at `nowMs` in `timeZone`. */
export function readTaskNote(text: string, timeZone: string, nowMs: number): TaskParseResponse {
  const calendar = calendarFrom(todayInZone(timeZone, nowMs));
  const parts = localParts(new Date(nowMs).toISOString(), timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const drafts: TaskDraft[] = [];
  const leftover: string[] = [];
  for (const raw of text.split(/[,\n]|그리고/u)) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const draft = drafts.length < MAX_DRAFTS ? draftOf(part, calendar, nowMinutes, timeZone) : null;
    if (draft === null) leftover.push(part);
    else drafts.push(draft);
  }
  return { drafts, leftover: leftover.join(' / ') };
}

export function createTaskParseHandlers(db: MockDb) {
  return [
    http.post(/\/api\/v1\/tasks:parse$/, async ({ request }) => {
      if (!db.authenticated) return problem(401, 'unauthenticated', 'Authentication is required');
      const raw = await request.text();
      const token = parseIdempotency(db, request, raw);
      if (token instanceof Response) return token;
      const body = parseBody<{ text?: unknown; timeZone?: unknown }>(raw);
      if (
        body === undefined ||
        typeof body.text !== 'string' ||
        body.text.trim().length === 0 ||
        Array.from(body.text).length > MAX_TEXT ||
        (body.timeZone !== undefined && typeof body.timeZone !== 'string')
      ) {
        return problem(400, 'validation_failed', 'text must be 1-500 characters with something other than spaces');
      }
      if (parseFailure !== null) return problem(503, parseFailure, 'the AI cannot read notes right now (mock)');
      const timeZone = typeof body.timeZone === 'string' ? body.timeZone : db.user.timeZone;
      db.pendingIdempotency.add(token.key);
      try {
        await wait(parseDelayMs, request.signal);
        if (request.signal.aborted) return new HttpResponse(null, { status: 499 });
        const result = readTaskNote(body.text.trim(), timeZone, Date.now());
        remember(db, token, 200, result);
        return json(result as unknown as Record<string, unknown>, 200);
      } finally {
        db.pendingIdempotency.delete(token.key);
      }
    }),
  ];
}
