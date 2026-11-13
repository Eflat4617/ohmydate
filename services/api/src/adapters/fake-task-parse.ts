import type { CommitmentCalendarDay, TaskParseItem, TaskParseOutput, WeekdayCode } from '@ohmydate/llm';
import { TIME, dayFor, hourOf, meridiemGuessed, minuteOf, record, unescapeFenced } from './fake-commitment-parse.js';

/**
 * CAL-05, `LLM_PROVIDER=fake` only: a small deterministic stand-in for
 * task_parse@v1, used by the E2E fake scenarios (fake-llm-scenarios.ts,
 * scripted-fake-llm.ts). It reads the structured input the API built (the
 * fenced note, `now`, `calendar`) and answers a schema-valid output: every
 * comma / line-break separated part is a to-do, with a deadline when it names a
 * day (오늘, 내일, 모레, [다음 주] X요일, N일) and/or a time ("9시", "오후 3시");
 * "X요일 전에" is the day before. A part that reads like a remark (ends with
 * "다" or "?") goes to `leftover`. It is not the product's parser: the real
 * reading is the model's. Nothing here retains the input.
 */

const NOTE_BLOCK = /<untrusted_document id="task-text">\n([\s\S]*?)\n<\/untrusted_document>/u;
const REMARK = /(?:다|\?)\s*[.!]*$/u;
const STRIP = [
  /(?:오늘|내일|모레|글피)/gu,
  /(?:이번|다음|다다음)\s*주(?:말)?/gu,
  /[월화수목금토일]요일/gu,
  /\d{1,2}\s*일/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)?\s*\d{1,2}\s*시(?:\s*반|\s*\d{1,2}\s*분)?/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)/gu,
];
const PARTICLES = /(?:^|\s)(?:까지|전까지|전에|에|마감)(?=\s|$)/gu;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function readPart(
  part: string,
  now: { date: string; weekday: WeekdayCode; time: string },
  calendar: readonly CommitmentCalendarDay[],
): TaskParseItem | null {
  if (REMARK.test(part)) return null;
  const time = TIME.exec(part);
  let day = dayFor(part, now, calendar);
  if (day !== null && /요일\s*전에/u.test(part)) {
    const index = calendar.findIndex((entry) => entry.date === day?.date);
    const before = index > 0 ? calendar[index - 1]?.date : undefined;
    day = before === undefined ? null : { ...day, date: before };
  }
  let dueTime: string | null = null;
  let guessedMeridiem = false;
  if (time !== null) {
    const evening = /저녁|밤|퇴근/u.test(part);
    const hour = hourOf(time[1], Number(time[2]), evening);
    if (hour <= 23) {
      dueTime = `${pad(hour)}:${pad(minuteOf(time[3], time[4]))}`;
      guessedMeridiem = meridiemGuessed(time[1], time[2] as string, evening);
    }
  }
  let dueDate: string | null = day?.date ?? null;
  let guessed = day?.guessed ?? false;
  if (dueDate === null && dueTime !== null) {
    dueDate = dueTime <= now.time ? (calendar[1]?.date ?? now.date) : now.date;
    guessed = true;
  }
  let title = part;
  for (const pattern of STRIP) title = title.replace(pattern, ' ');
  title = title.replace(/(까지|전까지|전에|마감)/gu, ' ');
  title = title.replace(PARTICLES, ' ').replace(/\s+/gu, ' ').trim();
  if (title.length === 0) title = part;
  return {
    title: Array.from(title).slice(0, 200).join(''),
    dueDate,
    dueTime,
    dateWasGuessed: dueDate === null ? false : guessed,
    meridiemWasGuessed: dueTime === null ? false : guessedMeridiem,
  };
}

/** Schema-valid `llm.task_parse.v1` output built only from the request input. */
export function fakeTaskParseOutput(input: unknown): TaskParseOutput {
  const value = record(input);
  const now = record(value?.['now']);
  const calendar = Array.isArray(value?.['calendar']) ? (value['calendar'] as CommitmentCalendarDay[]) : [];
  const match = typeof value?.['text'] === 'string' ? NOTE_BLOCK.exec(value['text']) : null;
  if (now === null || match === null) return { items: [], leftover: '' };
  const today = {
    date: String(now['date']),
    weekday: String(now['weekday']) as WeekdayCode,
    time: String(now['time']),
  };
  const items: TaskParseItem[] = [];
  const leftover: string[] = [];
  for (const raw of unescapeFenced(match[1] as string).split(/[,\n]|그리고/u)) {
    const part = raw.trim();
    if (part.length === 0) continue;
    const item = items.length < 10 ? readPart(part, today, calendar) : null;
    if (item === null) leftover.push(part);
    else items.push(item);
  }
  return { items, leftover: Array.from(leftover.join(' / ')).slice(0, 500).join('') };
}
