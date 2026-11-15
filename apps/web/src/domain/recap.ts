import { minutesOfSeconds, planDeltaMinutes, plannedMinutes, sessionFocusedSec, type OverviewBlock, type OverviewSession } from './overview';
import { localDateOf } from './time';

/**
 * 오늘 정리 (HOLO-04, FLOW.md §2 ⑤): the day against its plan, from the
 * owner's own records. Pure.
 */
/** Blocks that are part of the day's plan: not moved away, not replaced. */
function isInPlan(block: OverviewBlock): boolean {
  return block.status !== 'moved' && block.status !== 'superseded';
}

export interface DayRecap {
  /** Blocks planned for the day. */
  readonly blockCount: number;
  /** Of those, finished. */
  readonly doneCount: number;
  /** Minutes the day's blocks were planned for. */
  readonly plannedMin: number;
  /** Minutes focused in sessions that started on the day (a running one up to now). */
  readonly focusedMin: number;
  readonly sessionCount: number;
  /** Focused minus planned, in minutes; null when nothing was planned. */
  readonly deltaMin: number | null;
}

export function dayRecap(input: {
  readonly blocks: readonly OverviewBlock[];
  readonly sessions: readonly OverviewSession[];
  /** The civil day being summed up, in `timeZone`. */
  readonly date: string;
  readonly timeZone: string;
  readonly nowMs: number;
}): DayRecap {
  const ofDay = input.sessions.filter((session) => localDateOf(session.startedAt, input.timeZone) === input.date);
  const focusedSec = ofDay.reduce((sum, session) => sum + sessionFocusedSec(session, input.nowMs), 0);
  const planned = plannedMinutes(input.blocks);
  const inPlan = input.blocks.filter(isInPlan);
  return {
    blockCount: inPlan.length,
    doneCount: inPlan.filter((block) => block.status === 'done').length,
    plannedMin: planned,
    focusedMin: minutesOfSeconds(focusedSec),
    sessionCount: ofDay.length,
    deltaMin: planned > 0 ? planDeltaMinutes(focusedSec, planned) : null,
  };
}

/**
 * Whether the day is over as far as its plan goes: it had blocks, and none is
 * left to do (each is finished, skipped, or past its end). A day without a
 * plan is not "over" — it has not begun.
 */
export function dayIsOver(blocks: readonly OverviewBlock[], nowMs: number): boolean {
  const inPlan = blocks.filter(isInPlan);
  if (inPlan.length === 0) return false;
  return inPlan.every((block) => block.status === 'done' || block.status === 'skipped' || Date.parse(block.endAt) <= nowMs);
}
