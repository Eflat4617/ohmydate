import { assertInstant, type Instant } from './brand.js';

export function instantToEpochMs(instant: Instant): number {
  return Date.parse(assertInstant(instant));
}

export function epochMsToInstant(epochMs: number): Instant {
  if (!Number.isFinite(epochMs)) {
    throw new RangeError('epoch milliseconds must be finite');
  }
  return new Date(epochMs).toISOString() as Instant;
}
