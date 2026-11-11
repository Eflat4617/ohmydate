import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Sized for several concurrent invocations sharing one test database; see
    // test/db/helpers.ts.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    globalSetup: ['test/support/global-setup.ts'],
  },
});
