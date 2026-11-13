import type { CalendarDayEvent, GoogleIntegration } from '../api/client';

/**
 * CAL-04: the mock server's Google Calendar connection. It starts the way a
 * fresh install does (`not_configured`: no OAuth client file on the laptop);
 * `seedGoogle` (src/mocks/google.ts) moves it to another status for the
 * screenshot sweep and the dev server. Synthetic data only.
 */
export interface MockGoogleState {
  integration: GoogleIntegration;
  dayEvents: CalendarDayEvent[];
  /** Make the next `:sync` fail: 503 (Google unreachable) or 409 after the grant was revoked. */
  syncFailure: 'provider_unavailable' | 'auth_revoked' | null;
  /** `removeExported` of the last disconnect (tests read it). */
  lastRemoveExported: boolean | null;
}

export function createGoogleState(): MockGoogleState {
  return {
    integration: {
      status: 'not_configured',
      importAvailable: false,
      exportAvailable: false,
      calendars: [],
      exportCalendarName: null,
      settings: { exportBlocks: true, exportCommitments: true, dailySummary: true, reminderMinutes: 10 },
      lastSyncAt: null,
      lastError: null,
      version: 1,
    },
    dayEvents: [],
    syncFailure: null,
    lastRemoveExported: null,
  };
}
