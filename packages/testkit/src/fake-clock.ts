import {
  epochMsToInstant,
  instantToEpochMs,
  type Clock,
  type Instant,
} from '@ohmydate/domain';

const DEFAULT_START_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

export class FakeClock implements Clock {
  #nowMs: number;

  constructor(start: Instant = epochMsToInstant(DEFAULT_START_MS)) {
    this.#nowMs = instantToEpochMs(start);
  }

  now(): Instant {
    return epochMsToInstant(this.#nowMs);
  }

  advance(milliseconds: number): Instant {
    if (!Number.isInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('advance requires a non-negative integer number of milliseconds');
    }
    this.#nowMs += milliseconds;
    return this.now();
  }

  set(instant: Instant): void {
    this.#nowMs = instantToEpochMs(instant);
  }
}
