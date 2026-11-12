import { test as base, expect } from '@playwright/test';
import { readState } from './state';

/**
 * FU-79: every Playwright test starts with a clean login rate-limit window.
 *
 * The login limiter is a process-wide fixed window keyed by `${ip}:${email}`.
 * Earlier tests in the same E2E run share the API process and often the same
 * fixture owner, so E2E-5 could inherit a nearly exhausted window and fail on
 * a 429 after its own back-off. The reset route exists only when the API is
 * started with the fake-only `E2E_RESET_LOGIN_RATE_LIMIT=1` knob (global-setup
 * does that); production refuses the knob, and the limiter's production
 * behaviour is untouched.
 */
export const test = base.extend<{ resetLoginRateLimit: void }>({
  resetLoginRateLimit: [
    async ({ request }, use) => {
      const state = readState();
      const response = await request.post(
        `${state.apiUrl}/api/v1/__e2e__/reset-login-rate-limit`,
      );
      if (!response.ok) {
        throw new Error(
          `E2E login-rate-limit reset -> ${response.status}; is E2E_RESET_LOGIN_RATE_LIMIT=1 set?`,
        );
      }
      await use();
    },
    { auto: true },
  ],
});

export { expect };
