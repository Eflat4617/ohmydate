import type { CommitmentCalendarDay, CommitmentParseItem, CommitmentParseOutput, WeekdayCode } from '@ohmydate/llm';

/**
 * CAL-02, `LLM_PROVIDER=fake` only: a small deterministic stand-in for
 * commitment_parse@v1, used by the E2E fake scenarios (fake-llm-scenarios.ts,
 * scripted-fake-llm.ts). It reads the structured input the API built (the
 * fenced note, `now`, `calendar`) and answers a schema-valid output for a few
 * phrase shapes ("내일 오후 3시에 치과", "다음 주 화요일 3시 치과",
 * "14일 저녁 7시부터 9시까지 모임", "매주 목요일 7시 스터디"); anything it cannot
 * read goes to `leftover`. It is not the product's parser: the real reading is
 * the model's. Nothing here retains the input.
 */

const NOTE_BLOCK = /<untrusted_document id="commitment-text">\n([\s\S]*?)\n<\/untrusted_document>/u;
const WEEKDAYS: Readonly<Record<string, WeekdayCode>> = {
  월: 'MO',
  화: 'TU',
  수: 'WE',
  목: 'TH',
  금: 'FR',
  토: 'SA',
  일: 'SU',
};
const TIME = /(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/u;
const RANGE_END = /(?:부터|~|-)\s*(오전|오후|아침|저녁|밤|새벽)?\s*(\d{1,2})\s*시(?:\s*(반)|\s*(\d{1,2})\s*분)?/u;
const DURATION = /(\d{1,2})\s*시간/u;
const STRIP = [
  /(?:오늘|내일|모레|글피)/gu,
  /(?:이번|다음|다다음)\s*주(?:말)?/gu,
  /매주/gu,
  /[월화수목금토일]요일(?:마다|에)?/gu,
  /\d{1,2}\s*일/gu,
  /(?:부터|~|-)?\s*(?:오전|오후|아침|저녁|밤|새벽)?\s*\d{1,2}\s*시(?:\s*반|\s*\d{1,2}\s*분)?(?:\s*까지)?/gu,
  /\d{1,2}\s*시간(?:\s*동안)?/gu,
  /(?:오전|오후|아침|저녁|밤|새벽)/gu,
];

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unescapeFenced(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function hourOf(marker: string | undefined, hour: number, evening: boolean): number {
  if (marker === '오후' || marker === '저녁' || marker === '밤') return hour === 12 ? 12 : hour % 12 + 12;
  if (marker === '오전' || marker === '아침' || marker === '새벽') return hour % 12;
  if (hour > 12) return hour;
  if (evening && hour < 12) return hour + 12;
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

function minuteOf(half: string | undefined, minutes: string | undefined): number {
  if (half !== undefined) return 30;
  return minutes === undefined ? 0 : Number(minutes);
}

function dayFor(part: string, now: { date: string; weekday: WeekdayCode }, calendar: readonly CommitmentCalendarDay[]): {
  date: string;
  guessed: boolean;
  weekly: WeekdayCode | null;
} | null {
  const offset = (days: number): string | null => calendar[days]?.date ?? null;
  if (part.includes('모레')) return { date: offset(2) ?? now.date, guessed: false, weekly: null };
  if (part.includes('내일')) return { date: offset(1) ?? now.date, guessed: false, weekly: null };
  if (part.includes('오늘')) return { date: now.date, guessed: false, weekly: null };
  const weekday = /([월화수목금토일])요일/u.exec(part);
  if (weekday !== null) {
    const code = WEEKDAYS[weekday[1] as string] as WeekdayCode;
    const week = /다다음\s*주/u.test(part) ? 2 : /다음\s*주/u.test(part) ? 1 : /이번\s*주/u.test(part) ? 0 : null;
    const day = calendar.find((entry) => entry.weekday === code && (week === null || entry.week === week));
    if (day === undefined) return null;
    return { date: day.date, guessed: false, weekly: /매주|마다/u.test(part) ? code : null };
  }
  if (/주말/u.test(part)) {
    const week = /다음\s*주말/u.test(part) ? 1 : 0;
    const day = calendar.find((entry) => entry.weekday === 'SA' && entry.week === week);
    return day === undefined ? null : { date: day.date, guessed: true, weekly: null };
  }
  const dayOfMonth = /(\d{1,2})\s*일/u.exec(part);
  if (dayOfMonth !== null) {
    const wanted = Number(dayOfMonth[1]);
    const day = calendar.find((entry) => Number(entry.date.slice(8, 10)) === wanted);
    return day === undefined ? null : { date: day.date, guessed: false, weekly: null };
  }
  return null;
}

function readPart(
  part: string,
  now: { date: string; weekday: WeekdayCode; time: string },
  calendar: readonly CommitmentCalendarDay[],
): CommitmentParseItem | null {
  const time = TIME.exec(part);
  let day = dayFor(part, now, calendar);
  if (day === null && time === null) return null;
  const evening = /저녁|밤|퇴근/u.test(part);
  let startTime: string | null = null;
  let endTime: string | null = null;
  if (time !== null) {
    const startHour = hourOf(time[1], Number(time[2]), evening);
    if (startHour > 23) return null;
    startTime = `${pad(startHour)}:${pad(minuteOf(time[3], time[4]))}`;
    const rest = part.slice((time.index ?? 0) + time[0].length);
    const end = RANGE_END.exec(rest);
    const duration = DURATION.exec(part);
    if (end !== null) {
      let endHour = hourOf(end[1] ?? time[1], Number(end[2]), evening || startHour >= 12);
      if (endHour <= startHour && endHour < 12) endHour += 12;
      if (endHour <= 23) endTime = `${pad(endHour)}:${pad(minuteOf(end[3], end[4]))}`;
    } else if (duration !== null) {
      const endHour = startHour + Number(duration[1]);
      if (endHour <= 23) endTime = `${pad(endHour)}:${startTime.slice(3)}`;
    }
  }
  if (day === null) {
    const tomorrow = calendar[1]?.date ?? now.date;
    day = { date: startTime !== null && startTime <= now.time ? tomorrow : now.date, guessed: true, weekly: null };
  }
  let title = part;
  for (const pattern of STRIP) title = title.replace(pattern, ' ');
  title = title.replace(/(?:^|\s)(?:에|에서|까지|동안)(?=\s|$)/gu, ' ').replace(/\s+/gu, ' ').trim();
  title = title.replace(/^(?:에|에서)\s*/u, '').trim();
  if (title.length === 0) title = '약속';
  return {
    title: Array.from(title).slice(0, 200).join(''),
    date: day.date,
    startTime,
    endTime,
    endDate: null,
    weeklyDays: day.weekly === null ? null : [day.weekly],
    untilDate: null,
    dateWasGuessed: day.guessed,
  };
}

/** Schema-valid `llm.commitment_parse.v1` output built only from the request input. */
export function fakeCommitmentParseOutput(input: unknown): CommitmentParseOutput {
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
  const items: CommitmentParseItem[] = [];
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
