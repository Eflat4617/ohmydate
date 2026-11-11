import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['services/api/test/support/global-setup.ts'],
    include: [
      'apps/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
      'scripts/**/*.test.{ts,mjs,cjs}',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    passWithNoTests: false,
  },
});
