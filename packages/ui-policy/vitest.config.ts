import { defineConfig } from 'vitest/config';

// Pure package: no API build, no database. The root config still picks these
// tests up for `pnpm test`; this one keeps `pnpm --filter @ohmydate/ui-policy test` fast.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    passWithNoTests: false,
  },
});
