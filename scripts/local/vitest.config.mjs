import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['scripts/local/**/*.test.{mjs,ts}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: false,
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
