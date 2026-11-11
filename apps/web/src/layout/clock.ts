import type { Clock } from '@ohmydate/ui-policy';

/**
 * Clock port for the adaptive layout. The policy never reads time itself;
 * the web passes `layoutClock().now()` in, and tests swap the clock.
 */
const systemClock: Clock = { now: () => Date.now() };

let active: Clock = systemClock;

export function layoutClock(): Clock {
  return active;
}

/** Test seam: pass null to go back to the system clock. */
export function setLayoutClock(clock: Clock | null): void {
  active = clock ?? systemClock;
}
