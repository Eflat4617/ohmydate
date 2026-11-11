import { setupWorker } from 'msw/browser';
import type { User } from '../api';
import { createHandlers } from './handlers';
import { createIntakeHandlers } from './intake-handlers';
import { createPlanningHandlers } from './planning-handlers';
import { createReplanHandlers, seedColdEstimation, seedReplanScenario } from './replan';
import { mockDb, seedTodayRisk, type MockDb } from './db';

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
    };
    /** Mock-mode only: the in-page synthetic database, for screenshot/state scripts. */
    __OHMYDATE_MOCK_DB__?: MockDb;
  }
}

const overrides = typeof window === 'undefined' ? undefined : window.__OHMYDATE_MOCK__;
if (overrides?.llmProvider !== undefined) {
  mockDb.user = { ...mockDb.user, llmProvider: overrides.llmProvider };
}
if (overrides?.replan !== undefined) {
  seedReplanScenario(mockDb, { history: overrides.replan === 'history' });
}
if (overrides?.estimation === 'cold') seedColdEstimation(mockDb);
if (overrides?.today === 'risk') seedTodayRisk(mockDb);
if (typeof window !== 'undefined') window.__OHMYDATE_MOCK_DB__ = mockDb;

export const worker = setupWorker(
  ...createHandlers(mockDb),
  ...createIntakeHandlers(mockDb),
  ...createPlanningHandlers(mockDb),
  ...createReplanHandlers(mockDb),
);
