import { setupWorker } from 'msw/browser';
import type { User } from '../api';
import { createHandlers } from './handlers';
import { createIntakeHandlers } from './intake-handlers';
import { createPlanningHandlers } from './planning-handlers';
import { mockDb, type MockDb } from './db';

declare global {
  interface Window {
    /** Mock-mode only (VITE_MOCK=1): seed overrides used by the UI screenshot script. */
    __OHMYDATE_MOCK__?: { llmProvider?: User['llmProvider'] };
    /** Mock-mode only: the in-page synthetic database, for screenshot/state scripts. */
    __OHMYDATE_MOCK_DB__?: MockDb;
  }
}

const overrides = typeof window === 'undefined' ? undefined : window.__OHMYDATE_MOCK__;
if (overrides?.llmProvider !== undefined) {
  mockDb.user = { ...mockDb.user, llmProvider: overrides.llmProvider };
}
if (typeof window !== 'undefined') window.__OHMYDATE_MOCK_DB__ = mockDb;

export const worker = setupWorker(
  ...createHandlers(mockDb),
  ...createIntakeHandlers(mockDb),
  ...createPlanningHandlers(mockDb),
);
