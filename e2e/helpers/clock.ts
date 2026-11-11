import type { BrowserContext } from '@playwright/test';
import type { E2EState } from './state';

/**
 * Test-side view of the planner's clock. With E2E_FAKE_NOW (see README) the
 * API runs on real time plus `state.clockOffsetMs`; specs that opt in use the
 * same offset for their own "now" and for the browser so every tier agrees.
 */
export interface TestClock {
  readonly offsetMs: number;
  nowMs(): number;
}

export function testClock(state: E2EState): TestClock {
  const offsetMs = state.clockOffsetMs ?? 0;
  return {
    offsetMs,
    nowMs: () => Date.now() + offsetMs,
  };
}

/**
 * Start the browser context's clock at the simulated time and let it flow.
 * A no-op on real time, so the default suite never fakes browser timers.
 */
export async function installBrowserClock(context: BrowserContext, clock: TestClock): Promise<void> {
  if (clock.offsetMs === 0) return;
  await context.clock.install({ time: clock.nowMs() });
}

/**
 * FU-79: pin the browser to the simulator's "today" even on a real-time run.
 * Specs that assert day boundaries call this with the instant returned by
 * helpers/day-clock.ts so the UI's local date never follows the wall clock.
 */
export async function installBrowserClockAt(
  context: BrowserContext,
  nowMs: number,
): Promise<void> {
  await context.clock.install({ time: nowMs });
}
