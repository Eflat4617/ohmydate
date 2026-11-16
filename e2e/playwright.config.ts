import { defineConfig } from '@playwright/test';
import { coreSpecs, targetFromEnv } from './targets/target';

/**
 * One suite, two targets (targets/target.ts; `E2E_TARGET`, default `ts`).
 *
 * - `ts`: this file as it always was — the planner API on PostgreSQL with
 *   Vikunja, the web on the Vite dev server (`global-setup.ts`).
 * - `core`: the Rust core serving the web's desktop bundle
 *   (`targets/core-setup.ts`). It runs the target's own spec
 *   (`targets/core.spec.ts`: the hand-off, the signed-out page, and proof
 *   that the page watch notices what it is there for) and the specs that are
 *   proven there, no others (`targets/core-specs.json`): a spec of an area
 *   the core does not serve yet has nothing to pass against. To bring one
 *   over, add it to that list.
 */
const target = targetFromEnv();

export default defineConfig({
  ...(target === 'core'
    ? { testDir: '.', testMatch: ['targets/core.spec.ts', ...coreSpecs().map((spec) => `tests/${spec}`)] }
    : { testDir: './tests' }),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: target === 'core' ? './targets/core-setup.ts' : './global-setup.ts',
  globalTeardown: target === 'core' ? './targets/core-teardown.ts' : './global-teardown.ts',
  reporter: [
    ['list'],
    ['html', { outputFolder: '../playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    // `core`: no automatic screenshots. To take one, Playwright adds a <style>
    // element to the page (it hides the caret), and WebKit holds that element
    // to the page's Content-Security-Policy — so on WebKit every screenshot
    // makes the page report a violation that is the tool's, not the web's
    // (measured 2026-11-16: one `style-src-elem` report per screenshot, any
    // options; none on Chromium). The runner takes one whenever a test closes
    // a context, to keep in case the test fails, which would put that report
    // into every test's page watch (helpers/test.ts). A failing test still
    // leaves its trace, with snapshots of the page.
    screenshot: target === 'core' ? 'off' : 'only-on-failure',
    video: 'off',
  },
});
