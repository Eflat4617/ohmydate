import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'apps/**/test/**/*.test.ts',
      'services/**/test/**/*.test.ts',
      'packages/**/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    passWithNoTests: false,
  },
});
