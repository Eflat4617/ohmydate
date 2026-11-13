import { setupWorker } from 'msw/browser';
import type { User } from '../api';
import { createHandlers } from './handlers';
import {
  createCommitmentParseHandlers,
  setCommitmentParseDelay,
  setCommitmentParseFailure,
} from './commitment-parse';
import { createIntakeHandlers } from './intake-handlers';
import { createNotesHandlers, seedFocusNote } from './notes';
import { createPlanningHandlers } from './planning-handlers';
import { createReplanHandlers, seedColdEstimation, seedReplanScenario } from './replan';
import { mockDb, seedMonth, seedTodayRisk, type MockDb } from './db';

declare global {
  interface Window {
    /** Mock-mode only (VITE_MOCK=1): seed overrides used by the UI screenshot script. */
    __OHMYDATE_MOCK__?: {
      llmProvider?: User['llmProvider'];
      /** M5-03: seed a pending replan proposal (`pending`) plus history (`history`). */
      replan?: 'pending' | 'history';
      /** M5-03: start "내 패턴" from a cold start instead of the learned profile. */
      estimation?: 'cold';
      /** M6-02: give Today a deadline risk (negative slack + an overdue task). */
      today?: 'risk';
      /** M6-03: link a seeded note to the first Today task (Focus → RelatedNotes). */
      notes?: 'focus';
      /** CAL-01: leave out the November month (blocks, 약속, deadlines) that mock mode seeds by default. */
      month?: 'none';
      /** CAL-02: hold each "말로 적기" read this long (ms), to see the wait state. */
      parseDelayMs?: number;
      /** CAL-02: answer every "말로 적기" read with this 503. */
      parseFailure?: 'llm_unavailable' | 'budget_exceeded';
    };
    /** Mock-mode only: the in-page synthetic database, for screenshot/state scripts. */
    __OHMYDATE_MOCK_DB__?: MockDb;
  }
}

const overrides = typeof window === 'undefined' ? undefined : window.__OHMYDATE_MOCK__;
// CAL-01: mock mode opens on a believable month (src/mocks/db.ts seedMonth).
if (overrides?.month !== 'none') seedMonth(mockDb);
if (overrides?.llmProvider !== undefined) {
  mockDb.user = { ...mockDb.user, llmProvider: overrides.llmProvider };
}
if (overrides?.replan !== undefined) {
  seedReplanScenario(mockDb, { history: overrides.replan === 'history' });
}
if (overrides?.estimation === 'cold') seedColdEstimation(mockDb);
if (overrides?.today === 'risk') seedTodayRisk(mockDb);
if (overrides?.notes === 'focus') seedFocusNote(mockDb);
if (overrides?.parseDelayMs !== undefined) setCommitmentParseDelay(overrides.parseDelayMs);
if (overrides?.parseFailure !== undefined) setCommitmentParseFailure(overrides.parseFailure);
if (typeof window !== 'undefined') window.__OHMYDATE_MOCK_DB__ = mockDb;

export const worker = setupWorker(
  ...createHandlers(mockDb),
  ...createIntakeHandlers(mockDb),
  // CAL-02: before the planning handlers so /commitments:parse never reaches /commitments.
  ...createCommitmentParseHandlers(mockDb),
  ...createPlanningHandlers(mockDb),
  ...createReplanHandlers(mockDb),
  ...createNotesHandlers(mockDb),
);
