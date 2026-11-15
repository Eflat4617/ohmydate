import type { MockDb } from './db';

/**
 * HOLO-04 (FLOW.md §3): a brand-new owner for the mock and the tests — no
 * available hours, no 약속, no tasks beyond the inbox itself, nothing planned
 * for today, no notifications, and the AI question still unanswered. The
 * start guide opens for this owner; the default mock owner is a returning one.
 * Synthetic data only.
 */
export function seedNewOwner(db: MockDb): void {
  db.availability = { ...db.availability, rules: [], exceptions: [] };
  db.commitments.clear();
  db.tasks.clear();
  db.sessions.clear();
  db.sessionClocks.clear();
  db.activeSessionId = null;
  db.notifications.clear();
  db.extraScheduleBlocks = [];
  db.today = { ...db.today, blocks: [], risk: { level: 'low', reasons: [] } };
  db.user = { ...db.user, llmProvider: 'deepseek', llm: {} };
}
