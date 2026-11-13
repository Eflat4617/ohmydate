import type { TaskCreate, TaskDraft } from '../api';
import { shiftHalfDay, type HalfDayDirection } from './meridiem';
import { instantFromLocalInput, localInputValue } from './time';

/**
 * CAL-05: a task draft read from a to-do note ("금요일까지 보고서 초안") and
 * what the inbox row needs to add it. The server already turned the model's
 * local deadline into an instant; a draft without `dueAt` is a task without a
 * deadline. The row lets the person edit the title, change or clear the
 * deadline (the same `datetime-local` input the planning wizard uses for a
 * deadline) and switch a guessed AM to PM.
 */

export const TASK_TITLE_MAX = 200;

/** The `POST /tasks` body for a row (inbox: no project), or null while the title is blank or too long. */
export function taskDraftCreateInput(title: string, dueAt: string | null): TaskCreate | null {
  const trimmed = title.trim();
  if (trimmed.length === 0 || Array.from(trimmed).length > TASK_TITLE_MAX) return null;
  return dueAt === null ? { title: trimmed } : { title: trimmed, dueAt };
}

/** The `datetime-local` value of a deadline in `timeZone` ("" for none). */
export function dueInputValue(dueAt: string | null, timeZone: string): string {
  return dueAt === null ? '' : localInputValue(dueAt, timeZone);
}

/**
 * The deadline a `datetime-local` value means in `timeZone`: null for an empty
 * value (no deadline), undefined when the value is not a date-time.
 */
export function dueFromInputValue(value: string, timeZone: string): string | null | undefined {
  if (value.trim().length === 0) return null;
  try {
    return instantFromLocalInput(value, timeZone);
  } catch {
    return undefined;
  }
}

/** The read guessed AM for a bare 7-11 hour (CAL-05 addendum): the row offers the PM reading. */
export function taskDraftMeridiemGuessed(draft: TaskDraft): boolean {
  return draft.notes.includes('meridiem_assumed') && draft.dueAt !== undefined;
}

/** The deadline moved by half a day (오전 <-> 오후) on the local wall clock in `timeZone`. */
export function switchDueMeridiem(dueAt: string, timeZone: string, direction: HalfDayDirection): string {
  return shiftHalfDay(dueAt, timeZone, direction);
}
