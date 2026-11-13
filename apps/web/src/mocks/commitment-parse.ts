import { HttpResponse, http } from 'msw';
import type { CommitmentDraft, CommitmentDraftNote, CommitmentParseResponse } from '../api/client';
import { addDaysToDate, localParts, todayInZone, weekdayOfDate, zonedWallClockToInstant } from '../domain/time';
import { weekdayCode, type WeekdayCode } from '../domain/rrule';
import type { MockDb } from './db';
import { json, parseBody, parseIdempotency, problem, remember } from './handlers';

/**
 * CAL-02 mock of `POST /commitments:parse` (VITE_MOCK=1 and the unit tests).
 *
 * A small deterministic reader, not the product's parser (that is the model):
 * enough for the screenshot sweep and tests. It reads a few phrase shapes —
 * "내일 오후 3시에 치과", "다음 주 화요일 오후 3시에 치과", "14일 저녁 7시부터 9시까지
 * 동창 모임", "매주 목요일 7시 스터디", "이번 주말 영화 보기" (no time) — split by
 * commas and line breaks; anything else goes to `leftover`. It writes nothing.
 */

const MAX_TEXT = 500;
const MAX_DRAFTS = 10;
const CALENDAR_DAYS = 21;
const WEEKDAYS: Readonly<Record<string, WeekdayCode>> = {
  월: 'MO',
  화: 'TU',
  수: 'WE',
  목: 'TH',
  금: 'FR',
  토: 'SA',
  일: 'SU',
};
export const TIME = /(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/u;
const RANGE_END = /(?:부터|~|-)\s*(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/u;
const STRIP = [
  /(?:오늘|내일|모레)/gu,
  /(?:이번|다음|다다음)\s*주(?:말)?/gu,
  /매주/gu,
  /[월화수목금토일]요일(?:마다|에)?/gu,
  /\d{1,2}\s*일/gu,
  /(?:부터|~|-)?\s*(?:오전|오후|아침|저녁|밤|새벽)?\s*\d{1,2}\s*시(?:\s*반|\s*\d{1,2}\s*분)?(?:\s*까지)?/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)/gu,
];

let parseDelayMs = 0;

let parseFailure: 'llm_unavailable' | 'budget_exceeded' | null = null;

/** Mock-mode knob (browser.ts): hold every read this long, to show the wait state. */
export function setCommitmentParseDelay(ms: number): void {
  parseDelayMs = Math.max(0, Math.floor(ms));
}

/** Mock-mode knob (browser.ts): answer every read with this 503, to show the failure line. */
export function setCommitmentParseFailure(code: 'llm_unavailable' | 'budget_exceeded' | null): void {
  parseFailure = code;
}

export interface CalendarDay {
  readonly date: string;
  readonly weekday: WeekdayCode;
  readonly week: number;
}

export function calendarFrom(today: string): CalendarDay[] {
  const monday = weekdayOfDate(today) - 1;
  return Array.from({ length: CALENDAR_DAYS }, (_, offset) => {
    const date = addDaysToDate(today, offset);
    return { date, weekday: weekdayCode(weekdayOfDate(date)), week: Math.floor((monday + offset) / 7) };
  });
}

export function hourOf(marker: string | undefined, hour: number, evening: boolean): number {
  if (marker === '오후' || marker === '저녁' || marker === '밤') return hour === 12 ? 12 : (hour % 12) + 12;
  if (marker === '오전' || marker === '아침' || marker === '새벽') return hour % 12;
  if (hour > 12) return hour;
  if (evening && hour < 12) return hour + 12;
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

/**
 * CAL-05 addendum: a bare hour from 7 to 11 read as AM (no 오전/오후 word, no
 * 24-hour "09시", no evening context) is a guessed half-day.
 */
export function meridiemGuessed(marker: string | undefined, rawHour: string, evening: boolean): boolean {
  if (marker !== undefined || evening || rawHour.startsWith('0')) return false;
  const hour = Number(rawHour);
  return hour >= 7 && hour <= 11;
}

export function minuteOf(half: string | undefined, minutes: string | undefined): number {
  if (half !== undefined) return 30;
  return minutes === undefined ? 0 : Number(minutes);
}

export function dayOf(part: string, calendar: readonly CalendarDay[]): { date: string; guessed: boolean; weekly: WeekdayCode | null } | null {
  const first = calendar[0] as CalendarDay;
  if (part.includes('모레')) return { date: calendar[2]?.date ?? first.date, guessed: false, weekly: null };
  if (part.includes('내일')) return { date: calendar[1]?.date ?? first.date, guessed: false, weekly: null };
  if (part.includes('오늘')) return { date: first.date, guessed: false, weekly: null };
  const weekday = /([월화수목금토일])요일/u.exec(part);
  if (weekday !== null) {
    const code = WEEKDAYS[weekday[1] as string] as WeekdayCode;
    const week = /다다음\s*주/u.test(part) ? 2 : /다음\s*주/u.test(part) ? 1 : /이번\s*주/u.test(part) ? 0 : null;
    const day = calendar.find((entry) => entry.weekday === code && (week === null || entry.week === week));
    return day === undefined ? null : { date: day.date, guessed: false, weekly: /매주|마다/u.test(part) ? code : null };
  }
  if (/주말/u.test(part)) {
    const week = /다음\s*주말/u.test(part) ? 1 : 0;
    const day = calendar.find((entry) => entry.weekday === 'SA' && entry.week === week);
    return day === undefined ? null : { date: day.date, guessed: true, weekly: null };
  }
  const dayOfMonth = /(\d{1,2})\s*일/u.exec(part);
  if (dayOfMonth !== null) {
    const day = calendar.find((entry) => Number(entry.date.slice(8, 10)) === Number(dayOfMonth[1]));
    return day === undefined ? null : { date: day.date, guessed: false, weekly: null };
  }
  return null;
}

function draftOf(part: string, calendar: readonly CalendarDay[], nowMinutes: number, timeZone: string): CommitmentDraft | null {
  const time = TIME.exec(part);
  let day = dayOf(part, calendar);
  if (day === null && time === null) return null;
  const evening = /저녁|밤|퇴근/u.test(part);
  let start: number | null = null;
  let end: number | null = null;
  if (time !== null) {
    const startHour = hourOf(time[1], Number(time[2]), evening);
    if (startHour > 23) return null;
    start = startHour * 60 + minuteOf(time[3], time[4]);
    const range = RANGE_END.exec(part.slice((time.index ?? 0) + time[0].length));
    if (range !== null) {
      let endHour = hourOf(range[1] ?? time[1], Number(range[2]), evening || startHour >= 12);
      if (endHour <= startHour && endHour < 12) endHour += 12;
      if (endHour <= 23) end = endHour * 60 + minuteOf(range[3], range[4]);
    }
  }
  const today = calendar[0] as CalendarDay;
  if (day === null) {
    day = { date: start !== null && start <= nowMinutes ? (calendar[1]?.date ?? today.date) : today.date, guessed: true, weekly: null };
  }
  let title = part;
  for (const pattern of STRIP) title = title.replace(pattern, ' ');
  title = title.replace(/(?:^|\s)(?:에|에서|까지)(?=\s|$)/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (title.length === 0) title = '약속';
  const notes: CommitmentDraftNote[] = [];
  const draft: { -readonly [K in keyof CommitmentDraft]: CommitmentDraft[K] } = {
    title: Array.from(title).slice(0, 200).join(''),
    timeZone,
    date: day.date,
    notes,
  };
  if (day.weekly !== null) {
    draft.rrule = `FREQ=WEEKLY;BYDAY=${day.weekly}`;
    notes.push('repeats_weekly');
  }
  if (day.guessed) notes.push('date_assumed');
  if (start !== null) {
    if (end === null || end <= start) {
      end = start + 60;
      notes.unshift('duration_defaulted');
    }
    draft.startAt = zonedWallClockToInstant(day.date, start, timeZone);
    draft.endAt = zonedWallClockToInstant(day.date, end, timeZone);
    if (time !== null && meridiemGuessed(time[1], time[2] as string, evening)) notes.push('meridiem_assumed');
  }
  return draft;
}

/** The mock reading of `text` at `nowMs` in `timeZone`. */
export function readCommitmentNote(text: string, timeZone: string, nowMs: number): CommitmentParseResponse {
  const today = todayInZone(timeZone, nowMs);
  const calendar = calendarFrom(today);
  const parts = localParts(new Date(nowMs).toISOString(), timeZone);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const drafts: CommitmentDraft[] = [];
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

export function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function createCommitmentParseHandlers(db: MockDb) {
  return [
    http.post(/\/api\/v1\/commitments:parse$/, async ({ request }) => {
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
      const timeZone = typeof body.timeZone === 'string' ? body.timeZone : db.availability.timeZone;
      db.pendingIdempotency.add(token.key);
      try {
        await wait(parseDelayMs, request.signal);
        if (request.signal.aborted) return new HttpResponse(null, { status: 499 });
        const result = readCommitmentNote(body.text.trim(), timeZone, Date.now());
        remember(db, token, 200, result);
        return json(result as unknown as Record<string, unknown>, 200);
      } finally {
        db.pendingIdempotency.delete(token.key);
      }
    }),
  ];
}
