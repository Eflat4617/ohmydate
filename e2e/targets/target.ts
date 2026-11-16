import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Which backend a run of the E2E suite drives (blueprint 15 §7.3).
 *
 * - `ts` (the default): the stack as deployed — the planner API on
 *   PostgreSQL with Vikunja behind it, the web on the Vite dev server, and a
 *   login form.
 * - `core`: the Rust core, alone. It serves the desktop bundle of the web
 *   itself (`--web-dir`, under its CSP) from one fresh data directory; there
 *   is one owner and no login — a page gets in by the boot hand-off.
 *
 * Chosen with `E2E_TARGET` (`corepack pnpm run e2e:core` sets it). The same
 * specs run on both; what differs is behind `helpers/driver.ts`.
 */
export type TargetName = 'ts' | 'core';

export function targetFromEnv(env: NodeJS.ProcessEnv = process.env): TargetName {
  const raw = env['E2E_TARGET'];
  if (raw === undefined || raw === '' || raw === 'ts') return 'ts';
  if (raw === 'core') return 'core';
  throw new Error(`E2E_TARGET must be "ts" or "core", got: ${raw}`);
}

/**
 * The specs that are proven on the `core` target, and so what a plain
 * `corepack pnpm run e2e:core` runs. A task that ports an area adds its spec
 * here once it passes; `core/PARITY.md` says the same thing in words, and
 * `tests-core/ledger.test.ts` fails when the two disagree.
 */
export const CORE_SPECS_PATH = fileURLToPath(new URL('./core-specs.json', import.meta.url));

export function coreSpecs(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(CORE_SPECS_PATH, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('e2e/targets/core-specs.json must be an array of spec file names');
  }
  return parsed as string[];
}
