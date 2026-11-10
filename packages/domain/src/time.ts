import {
  MAX_INSTANT_MS,
  MIN_INSTANT_MS,
  assertInstant,
  type Instant,
} from './brand.js';

export function instantToEpochMs(instant: Instant): number {
  return Date.parse(assertInstant(instant));
}

export function epochMsToInstant(epochMs: number): Instant {
  if (!Number.isInteger(epochMs)) {
    throw new RangeError('epoch milliseconds must be an integer');
  }
  if (epochMs < MIN_INSTANT_MS || epochMs > MAX_INSTANT_MS) {
    throw new RangeError(
      `epoch milliseconds outside supported Instant range: ${epochMs}`,
    );
  }
  return new Date(epochMs).toISOString() as Instant;
}
