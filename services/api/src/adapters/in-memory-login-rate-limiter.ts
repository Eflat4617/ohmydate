import { instantToEpochMs, type Clock } from '@ohmydate/domain';
import type { LoginRateLimiter } from '../application/ports.js';

interface Window {
  count: number;
  resetAt: number;
}

export interface InMemoryLoginRateLimiterOptions {
  readonly clock: Clock;
  readonly limit: number;
  readonly windowMs: number;
}

/** Fixed-window limiter keyed by `${ip}:${normalizedEmail}` for /auth/login. */
export class InMemoryLoginRateLimiter implements LoginRateLimiter {
  readonly #clock: InMemoryLoginRateLimiterOptions['clock'];
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #windows = new Map<string, Window>();

  constructor(options: InMemoryLoginRateLimiterOptions) {
    this.#clock = options.clock;
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
  }

  consume(key: string): boolean {
    const now = instantToEpochMs(this.#clock.now());
    let window = this.#windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.#windowMs };
      this.#windows.set(key, window);
    }
    window.count += 1;
    return window.count <= this.#limit;
  }

  /** FU-79: E2E-only isolation between Playwright tests (see routes/app.ts). */
  reset(): void {
    this.#windows.clear();
  }
}
