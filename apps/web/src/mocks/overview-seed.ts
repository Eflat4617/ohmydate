import type { WorkSession } from '../api/client';
import {
  MONTH_TASK_ENGLISH_ID,
  MONTH_TASK_SLIDES_ID,
  MONTH_TASK_SUMMARY_ID,
  MONTH_TASK_THESIS_ID,
  TODAY_BLOCK_ONE_ID,
  TODAY_TASK_ONE_ID,
  TODAY_TASK_TWO_ID,
  type MockDb,
} from './db';

/**
 * HOLO-01: a believable fortnight of focus sessions around the pinned mock
 * day (2026-11-14, Asia/Seoul) so 개요 opens on a full dashboard: an evening
 * of work most days, one given up half-way, two sittings today, the week
 * before for the week switcher. Synthetic; the unit tests start without it
 * (`createMockDb`) and seed it themselves when they want it.
 */
export const OVERVIEW_RUNNING_SESSION_ID = '01900000-0000-7000-8000-000000000599';

/** A Seoul wall-clock time (UTC+9, no DST) as an instant. */
function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

type Row = readonly [taskId: string, date: string, start: string, end: string, focusedMin: number, state: WorkSession['state']];

export function seedOverviewSessions(db: MockDb, options: { readonly running?: boolean } = {}): void {
  // Tasks of the seeded month when it is there, else the ones every mock has.
  const pick = (preferred: string, fallback: string): string => (db.tasks.has(preferred) ? preferred : fallback);
  const thesis = pick(MONTH_TASK_THESIS_ID, TODAY_TASK_ONE_ID);
  const slides = pick(MONTH_TASK_SLIDES_ID, TODAY_TASK_TWO_ID);
  const summary = pick(MONTH_TASK_SUMMARY_ID, TODAY_TASK_ONE_ID);
  const english = pick(MONTH_TASK_ENGLISH_ID, TODAY_TASK_TWO_ID);

  const rows: Row[] = [
    [thesis, '2026-11-02', '19:00', '20:30', 80, 'completed'],
    [thesis, '2026-11-04', '19:30', '21:00', 75, 'completed'],
    [english, '2026-11-05', '20:00', '21:00', 50, 'completed'],
    [thesis, '2026-11-07', '10:00', '12:00', 110, 'completed'],
    [summary, '2026-11-09', '19:00', '20:00', 52, 'completed'],
    [slides, '2026-11-10', '19:00', '20:30', 78, 'completed'],
    [english, '2026-11-11', '21:00', '21:40', 22, 'abandoned'],
    [thesis, '2026-11-12', '20:00', '21:30', 85, 'completed'],
    [slides, '2026-11-13', '19:00', '20:05', 58, 'completed'],
    [thesis, '2026-11-14', '10:05', '11:12', 62, 'completed'],
    [TODAY_TASK_TWO_ID, '2026-11-14', '16:20', '17:05', 41, 'completed'],
  ];
  rows.forEach(([taskId, date, start, end, focusedMin, state], index) => {
    const startedAt = seoul(date, start);
    const endedAt = seoul(date, end);
    const elapsedSec = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
    const session: WorkSession = {
      // Ascending with time, like UUIDv7: the list endpoint orders by id.
      id: `01900000-0000-7000-8000-0000000005${(0x10 + index).toString(16)}`,
      taskId,
      startedAt,
      endedAt,
      focusedSec: focusedMin * 60,
      pausedSec: Math.max(0, elapsedSec - focusedMin * 60),
      state,
      clientId: 'mock-seed',
      version: 2,
    };
    db.sessions.set(session.id, session);
  });

  if (options.running === true) {
    const startedAt = seoul('2026-11-14', '18:15');
    db.sessions.set(OVERVIEW_RUNNING_SESSION_ID, {
      id: OVERVIEW_RUNNING_SESSION_ID,
      taskId: TODAY_TASK_ONE_ID,
      blockId: TODAY_BLOCK_ONE_ID,
      startedAt,
      focusedSec: 0,
      pausedSec: 0,
      state: 'active',
      clientId: 'mock-seed',
      version: 1,
    });
    db.sessionClocks.set(OVERVIEW_RUNNING_SESSION_ID, { activeSince: Date.parse(startedAt), pausedSince: null });
    db.activeSessionId = OVERVIEW_RUNNING_SESSION_ID;
  }
}
