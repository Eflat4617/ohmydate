/**
 * Runs the scheduler's reference tests once with `harvest-setup.mts`, to
 * collect the inputs they give to `generate` (blueprint 15 §5.3):
 *
 *   ORACLE_HARVEST_OUT=core/target/oracle-corpus/reference-tests.jsonl \
 *     corepack pnpm exec vitest run --config packages/scheduler/scripts/harvest.vitest.config.mts
 *
 * `corepack pnpm run core:diff` does this before it exports the pack. The
 * run is for collecting, not for judging: the suite's own verdict comes from
 * the normal `vitest run packages/scheduler`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/scheduler/test/**/*.test.ts'],
    // The performance test asserts on timing ratios, which the recording
    // wrapper and a busy machine disturb; its workload is a fixed case of the
    // exporter instead (`budgetWorkloadCase`).
    exclude: ['**/node_modules/**', 'packages/scheduler/test/performance.test.ts'],
    setupFiles: ['packages/scheduler/scripts/harvest-setup.mts'],
    // One file at a time: the output file is appended to.
    fileParallelism: false,
  },
});
