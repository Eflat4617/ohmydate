/**
 * Pure helpers that pick keyboard edits for E2E-3 from the schedule that was
 * actually generated, instead of assuming where blocks land for "now".
 *
 * Every helper here is deterministic and has no Playwright or network
 * dependency, so `tests/plan-edit-helpers.spec.ts` can exercise it directly.
 * The checks are deliberately conservative re-statements of the hard
 * constraints a 5-minute move can touch (H1 overlap, H2 availability, H3
 * dependencies, H4 due time, H6 daily focus/break, horizon). They never call
 * product code: the planner's own validator stays the oracle under test.
 */

export const GRID_MINUTES = 5;
export const MINUTE_MS = 60_000;
export const GRID_MS = GRID_MINUTES * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

export type ArrowKey = 'ArrowUp' | 'ArrowDown';

export interface Interval {
  readonly startAt: string;
  readonly endAt: string;
}

export interface EditableBlock extends Interval {
  readonly taskId: string;
}

export interface EditableCandidate {
  readonly id: string;
  readonly policy: string;
  readonly feasible: boolean;
  readonly blocks: readonly EditableBlock[];
}

export interface AvailabilityShape {
  readonly timeZone: string;
  readonly rules: readonly {
    readonly weekday: number;
    readonly startLocal: string;
    readonly endLocal: string;
    readonly kind: string;
  }[];
  readonly exceptions: readonly {
    readonly date: string;
    readonly kind: 'off' | 'extra';
    readonly startLocal?: string;
    readonly endLocal?: string;
  }[];
  readonly prefs: {
    readonly breakAfterMin: number;
    readonly breakMin: number;
  };
}

export interface TaskConstraints {
  readonly dueAt?: string;
  readonly dependsOn: readonly string[];
}

export interface EditContext {
  readonly horizon: { readonly start: string; readonly end: string };
  /** Plan time zone: the calendar renders local dates/times in it. */
  readonly timeZone: string;
  readonly availability: AvailabilityShape;
  /** Commitment occurrences and approved schedule blocks the plan must avoid. */
  readonly occupied: readonly Interval[];
  readonly tasks: ReadonlyMap<string, TaskConstraints>;
  /** Moves may not start before this instant (keeps the edit out of the past). */
  readonly notBeforeMs: number;
}

export interface KeyboardEdit {
  readonly candidateIndex: number;
  readonly candidateId: string;
  readonly blockIndex: number;
  readonly key: ArrowKey;
  readonly presses: number;
  readonly original: EditableBlock;
  readonly moved: EditableBlock;
  /** Full candidate block list after the edit, in the original order. */
  readonly blocks: readonly EditableBlock[];
}

export interface OverlapEdit extends KeyboardEdit {
  readonly overlapped: EditableBlock;
}

interface LocalPoint {
  readonly date: string;
  readonly minutes: number;
}

interface WindowBand {
  readonly start: number;
  readonly end: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function instantMs(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new RangeError(`invalid instant: ${value}`);
  return ms;
}

export function localPoint(ms: number, timeZone: string): LocalPoint {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

export function localDate(instant: string, timeZone: string): string {
  return localPoint(instantMs(instant), timeZone).date;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localClock(instant: string, timeZone: string): string {
  const { minutes } = localPoint(instantMs(instant), timeZone);
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a `YYYY-MM-DD` date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const base = new Date(`${date}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Monday of the calendar week that contains `date` (the web calendar starts weeks on Monday). */
export function weekStartOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / (DAY_MINUTES * MINUTE_MS),
  );
}

const KOREAN_WEEKDAYS = ['월', '화', '수', '목', '금', '토', '일'] as const;

/**
 * Civil date the way the Korean web UI writes it (ko-KR):
 * `11월 13일 (금)`, or `2026년 11월 13일 (금)` with the year.
 */
export function koreanDateLabel(date: string, withYear = false): string {
  const [year, month, day] = date.split('-').map(Number);
  const weekday = KOREAN_WEEKDAYS[isoWeekday(date) - 1] ?? '';
  return `${withYear ? `${year}년 ` : ''}${month}월 ${day}일 (${weekday})`;
}

/** Local 12-hour clock as the UI renders it (ko-KR): `오전 1:30`, `오후 12:05`. */
export function koreanClock(instant: string, timeZone: string): string {
  const { minutes } = localPoint(instantMs(instant), timeZone);
  const hour = Math.floor(minutes / 60);
  const period = hour < 12 ? '오전' : '오후';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${period} ${hour12}:${pad(minutes % 60)}`;
}

/**
 * The block of the schedule being chosen as the week grid draws it
 * (HOLO-03A, `WeekGrid`). Its accessible name is
 * `일정안 블록, <task>, <date> <start>~<end>`, e.g.
 * `일정안 블록, 논문 요약, 11월 13일 (금) 오전 1:30~2:00`; feasible candidates
 * never contain two blocks that start at the same instant.
 */
export function calendarBlockSelector(block: Interval, timeZone: string): string {
  const date = koreanDateLabel(localDate(block.startAt, timeZone));
  const clock = koreanClock(block.startAt, timeZone);
  return `.wg-item[data-kind="proposal"][aria-label*=", ${date} ${clock}~"]`;
}

export function sameBlock(left: EditableBlock | undefined, right: EditableBlock): boolean {
  return (
    left !== undefined &&
    left.taskId === right.taskId &&
    instantMs(left.startAt) === instantMs(right.startAt) &&
    instantMs(left.endAt) === instantMs(right.endAt)
  );
}

function clockMinutes(value: string | undefined, fallback: number): number {
  if (value === undefined || value.length === 0) return fallback;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) return fallback;
  return Number(match[1]) * 60 + Number(match[2]);
}

function subtractWindow(windows: WindowBand[], start: number, end: number): WindowBand[] {
  const next: WindowBand[] = [];
  for (const window of windows) {
    if (end <= window.start || start >= window.end) {
      next.push(window);
      continue;
    }
    if (start > window.start) next.push({ start: window.start, end: start });
    if (end < window.end) next.push({ start: end, end: window.end });
  }
  return next;
}

/**
 * Local availability windows (minutes after local midnight) for `date`.
 * An `extra` exception without times adds nothing here: under-approximating
 * availability only ever removes edit options.
 */
export function availabilityWindows(date: string, availability: AvailabilityShape): WindowBand[] {
  const weekday = isoWeekday(date);
  let windows: WindowBand[] = availability.rules
    .filter((rule) => rule.weekday === weekday)
    .map((rule) => ({
      start: clockMinutes(rule.startLocal, 0),
      end: clockMinutes(rule.endLocal, DAY_MINUTES),
    }));
  for (const exception of availability.exceptions) {
    if (exception.date !== date) continue;
    const hasTimes =
      (exception.startLocal ?? '').length > 0 || (exception.endLocal ?? '').length > 0;
    if (exception.kind === 'off') {
      windows = hasTimes
        ? subtractWindow(
            windows,
            clockMinutes(exception.startLocal, 0),
            clockMinutes(exception.endLocal, DAY_MINUTES),
          )
        : [];
    } else if (hasTimes) {
      windows.push({
        start: clockMinutes(exception.startLocal, 0),
        end: clockMinutes(exception.endLocal, DAY_MINUTES),
      });
    }
  }
  return windows
    .map((window) => ({ start: Math.max(0, window.start), end: Math.min(DAY_MINUTES, window.end) }))
    .filter((window) => window.end > window.start);
}

/** Local span of [startMs, endMs) when it stays on one local date without an offset change. */
function localSpan(
  startMs: number,
  endMs: number,
  timeZone: string,
): { date: string; start: number; end: number } | null {
  if (endMs <= startMs) return null;
  const start = localPoint(startMs, timeZone);
  const lastMinute = localPoint(endMs - MINUTE_MS, timeZone);
  if (start.date !== lastMinute.date) return null;
  const end = lastMinute.minutes + 1;
  if (end - start.minutes !== (endMs - startMs) / MINUTE_MS) return null;
  return { date: start.date, start: start.minutes, end };
}

function insideOneWindow(
  startMs: number,
  endMs: number,
  timeZone: string,
  availability: AvailabilityShape,
): boolean {
  const span = localSpan(startMs, endMs, timeZone);
  if (span === null) return false;
  return availabilityWindows(span.date, availability).some(
    (window) => window.start <= span.start && span.end <= window.end,
  );
}

function overlapsMs(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function longestRunMs(intervals: readonly { start: number; end: number }[], breakMs: number): number {
  const sorted = [...intervals].sort((left, right) => left.start - right.start || left.end - right.end);
  let longest = 0;
  let runStart: number | undefined;
  let runEnd: number | undefined;
  for (const interval of sorted) {
    if (runStart === undefined || runEnd === undefined || interval.start - runEnd >= breakMs) {
      if (runStart !== undefined && runEnd !== undefined) longest = Math.max(longest, runEnd - runStart);
      runStart = interval.start;
      runEnd = interval.end;
    } else {
      runEnd = Math.max(runEnd, interval.end);
    }
  }
  if (runStart !== undefined && runEnd !== undefined) longest = Math.max(longest, runEnd - runStart);
  return longest;
}

function shifted(block: EditableBlock, deltaMs: number): EditableBlock {
  return {
    taskId: block.taskId,
    startAt: new Date(instantMs(block.startAt) + deltaMs).toISOString(),
    endAt: new Date(instantMs(block.endAt) + deltaMs).toISOString(),
  };
}

function replaceAt(
  blocks: readonly EditableBlock[],
  index: number,
  block: EditableBlock,
): EditableBlock[] {
  return blocks.map((item, position) => (position === index ? block : { ...item }));
}

function dependencyLinked(taskId: string, tasks: ReadonlyMap<string, TaskConstraints>): boolean {
  const own = tasks.get(taskId);
  if (own === undefined) return true; // unknown constraints: never pick it
  if (own.dependsOn.length > 0) return true;
  for (const other of tasks.values()) {
    if (other.dependsOn.includes(taskId)) return true;
  }
  return false;
}

function inHorizon(startMs: number, endMs: number, horizon: { start: string; end: string }): boolean {
  return startMs >= instantMs(horizon.start) && endMs <= instantMs(horizon.end);
}

/**
 * Why a single 5-minute move of `blocks[index]` would not stay feasible, or
 * `null` when every hard constraint the move can touch still holds.
 */
export function nudgeBlocker(
  blocks: readonly EditableBlock[],
  index: number,
  key: ArrowKey,
  context: EditContext,
): string | null {
  const block = blocks[index];
  if (block === undefined) return 'no such block';
  const deltaMs = key === 'ArrowDown' ? GRID_MS : -GRID_MS;
  const originalStart = instantMs(block.startAt);
  const startMs = originalStart + deltaMs;
  const endMs = instantMs(block.endAt) + deltaMs;
  if (!inHorizon(startMs, endMs, context.horizon)) return 'outside horizon';
  if (startMs < context.notBeforeMs) return 'would start in the past';
  if (localPoint(startMs, context.timeZone).date !== localPoint(originalStart, context.timeZone).date) {
    return 'would change local date';
  }
  if (!insideOneWindow(startMs, endMs, context.timeZone, context.availability)) {
    return 'outside availability (H2)';
  }
  const others = blocks.filter((_, position) => position !== index);
  for (const other of [...others, ...context.occupied]) {
    if (overlapsMs(startMs, endMs, instantMs(other.startAt), instantMs(other.endAt))) {
      return 'overlaps a block or commitment (H1)';
    }
  }
  if (dependencyLinked(block.taskId, context.tasks)) return 'dependency-linked task (H3)';
  const dueAt = context.tasks.get(block.taskId)?.dueAt;
  if (key === 'ArrowDown' && dueAt !== undefined && endMs > instantMs(dueAt)) {
    return 'would end after the due time (H4)';
  }
  const { breakAfterMin, breakMin } = context.availability.prefs;
  if (breakAfterMin > 0) {
    const intervals = [...others, ...context.occupied].map((other) => ({
      start: instantMs(other.startAt),
      end: instantMs(other.endAt),
    }));
    intervals.push({ start: startMs, end: endMs });
    if (longestRunMs(intervals, breakMin * MINUTE_MS) > breakAfterMin * MINUTE_MS) {
      return 'would break the focus break rule (H6)';
    }
  }
  return null;
}

/**
 * First single-press move (ArrowDown preferred, then ArrowUp) into free space
 * on any feasible candidate, trying candidates in their rendered order. The
 * block keeps its local date and duration, so daily totals (H6), session
 * bounds (H5) and placed minutes (H7) are unchanged by construction.
 */
export function findFeasibleNudge(
  candidates: readonly EditableCandidate[],
  context: EditContext,
): KeyboardEdit | null {
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!candidate.feasible) continue;
    for (const key of ['ArrowDown', 'ArrowUp'] as const) {
      for (const [blockIndex, block] of candidate.blocks.entries()) {
        if (nudgeBlocker(candidate.blocks, blockIndex, key, context) !== null) continue;
        const moved = shifted(block, key === 'ArrowDown' ? GRID_MS : -GRID_MS);
        return {
          candidateIndex,
          candidateId: candidate.id,
          blockIndex,
          key,
          presses: 1,
          original: block,
          moved,
          blocks: replaceAt(candidate.blocks, blockIndex, moved),
        };
      }
    }
  }
  return null;
}

/**
 * ArrowDown presses that slide block A into the next block B of the same
 * local date, choosing the pair that needs the fewest presses. The moved block
 * still starts before B ends, so the result always overlaps B (H1) and stays
 * on the same calendar column.
 */
export function findOverlapEdit(
  candidates: readonly EditableCandidate[],
  timeZone: string,
  horizon: { start: string; end: string },
): OverlapEdit | null {
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!candidate.feasible) continue;
    const order = candidate.blocks
      .map((block, index) => ({ block, index }))
      .sort((left, right) => instantMs(left.block.startAt) - instantMs(right.block.startAt));
    let best: OverlapEdit | null = null;
    for (let position = 0; position + 1 < order.length; position += 1) {
      const first = order[position];
      const next = order[position + 1];
      if (first === undefined || next === undefined) continue;
      const aStart = instantMs(first.block.startAt);
      const aEnd = instantMs(first.block.endAt);
      const bStart = instantMs(next.block.startAt);
      const bEnd = instantMs(next.block.endAt);
      if (aEnd > bStart) continue; // already overlapping: not a feasible baseline
      if (localDate(first.block.startAt, timeZone) !== localDate(next.block.startAt, timeZone)) {
        continue;
      }
      const presses = Math.floor((bStart - aEnd) / GRID_MS) + 1;
      const deltaMs = presses * GRID_MS;
      const movedStart = aStart + deltaMs;
      const movedEnd = aEnd + deltaMs;
      if (!overlapsMs(movedStart, movedEnd, bStart, bEnd)) continue;
      if (localSpan(movedStart, movedEnd, timeZone)?.date !== localDate(first.block.startAt, timeZone)) {
        continue;
      }
      if (!inHorizon(movedStart, movedEnd, horizon)) continue;
      if (best !== null && best.presses <= presses) continue;
      const moved = shifted(first.block, deltaMs);
      best = {
        candidateIndex,
        candidateId: candidate.id,
        blockIndex: first.index,
        key: 'ArrowDown',
        presses,
        original: first.block,
        moved,
        overlapped: next.block,
        blocks: replaceAt(candidate.blocks, first.index, moved),
      };
    }
    if (best !== null) return best;
  }
  return null;
}

/**
 * Fewest presses that push one block across the edge of the availability
 * window that contains it, onto a minute no window covers (H2), without
 * leaving its local date or the horizon.
 */
export function findAvailabilityExitEdit(
  candidates: readonly EditableCandidate[],
  context: Pick<EditContext, 'timeZone' | 'availability' | 'horizon'>,
): KeyboardEdit | null {
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (!candidate.feasible) continue;
    let best: KeyboardEdit | null = null;
    for (const [blockIndex, block] of candidate.blocks.entries()) {
      const startMs = instantMs(block.startAt);
      const endMs = instantMs(block.endAt);
      const span = localSpan(startMs, endMs, context.timeZone);
      if (span === null) continue;
      const windows = availabilityWindows(span.date, context.availability);
      const window = windows.find((band) => band.start <= span.start && span.end <= band.end);
      if (window === undefined) continue;
      const covered = (minute: number): boolean =>
        windows.some((band) => band.start <= minute && minute < band.end);
      const options: { key: ArrowKey; presses: number; outsideMinute: number }[] = [
        {
          key: 'ArrowDown',
          presses: Math.floor((window.end - span.end) / GRID_MINUTES) + 1,
          outsideMinute: window.end,
        },
        {
          key: 'ArrowUp',
          presses: Math.floor((span.start - window.start) / GRID_MINUTES) + 1,
          outsideMinute: window.start - 1,
        },
      ];
      for (const option of options) {
        if (option.outsideMinute < 0 || option.outsideMinute >= DAY_MINUTES) continue;
        if (covered(option.outsideMinute)) continue;
        const deltaMs = (option.key === 'ArrowDown' ? 1 : -1) * option.presses * GRID_MS;
        const movedSpan = localSpan(startMs + deltaMs, endMs + deltaMs, context.timeZone);
        if (movedSpan?.date !== span.date) continue;
        if (!inHorizon(startMs + deltaMs, endMs + deltaMs, context.horizon)) continue;
        if (best !== null && best.presses <= option.presses) continue;
        const moved = shifted(block, deltaMs);
        best = {
          candidateIndex,
          candidateId: candidate.id,
          blockIndex,
          key: option.key,
          presses: option.presses,
          original: block,
          moved,
          blocks: replaceAt(candidate.blocks, blockIndex, moved),
        };
      }
    }
    if (best !== null) return best;
  }
  return null;
}

/** Compact human-readable dump of candidates for failure messages and annotations. */
export function describeCandidates(
  candidates: readonly EditableCandidate[],
  timeZone: string,
): string {
  return candidates
    .map((candidate, index) => {
      const blocks = [...candidate.blocks]
        .sort((left, right) => instantMs(left.startAt) - instantMs(right.startAt))
        .map(
          (block) =>
            `${localDate(block.startAt, timeZone)} ${localClock(block.startAt, timeZone)}-${localClock(block.endAt, timeZone)}`,
        )
        .join(', ');
      return `#${index} ${candidate.policy}${candidate.feasible ? '' : ' (infeasible)'}: ${blocks}`;
    })
    .join('\n');
}

export function describeEdit(edit: KeyboardEdit, timeZone: string): string {
  const from = `${localDate(edit.original.startAt, timeZone)} ${localClock(edit.original.startAt, timeZone)}-${localClock(edit.original.endAt, timeZone)}`;
  const to = `${localClock(edit.moved.startAt, timeZone)}-${localClock(edit.moved.endAt, timeZone)}`;
  return `candidate #${edit.candidateIndex} block ${edit.blockIndex}: ${from} → ${to} (${edit.key} ×${edit.presses})`;
}
