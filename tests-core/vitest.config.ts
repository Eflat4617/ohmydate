import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// tests-core is not a workspace package (it must not change the lockfile).
// It borrows the contract package and its ajv from packages/contracts.
const contracts = fileURLToPath(new URL('../packages/contracts/', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: {
    alias: {
      '@ohmydate/contracts': `${contracts}src/index.ts`,
      'ajv-formats': `${contracts}node_modules/ajv-formats`,
      ajv: `${contracts}node_modules/ajv`,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests-core/**/*.test.ts'],
    // Each file starts its own core process on a private data directory.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    passWithNoTests: false,
  },
});
