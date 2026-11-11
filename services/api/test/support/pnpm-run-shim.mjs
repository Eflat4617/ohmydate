#!/usr/bin/env node
// Run-only stand-in for `pnpm run <script>` inside a private build workspace
// (see dist-artifact.ts). It executes the package.json script text exactly as
// written, with node_modules/.bin on PATH, and does nothing else: unlike the
// real CLI it can never install or relink dependencies, which matters because
// the workspace's dependencies are symlinks into the checkout.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

const [command, name, ...extra] = process.argv.slice(2);
if (command !== 'run' || name === undefined || extra.length > 0) {
  console.error(
    `[pnpm-run-shim] only "pnpm run <script>" is supported in a build workspace, got: ${process.argv.slice(2).join(' ')}`,
  );
  process.exit(64);
}

const cwd = process.cwd();
let script;
try {
  script = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).scripts?.[name];
} catch (error) {
  console.error(`[pnpm-run-shim] cannot read ${join(cwd, 'package.json')}: ${String(error)}`);
  process.exit(1);
}
if (typeof script !== 'string') {
  console.error(`[pnpm-run-shim] missing script: ${name}`);
  process.exit(1);
}

const path = [];
const shimBin = process.env['OHMYDATE_API_BUILD_SHIM_BIN'];
if (shimBin !== undefined && shimBin !== '') path.push(shimBin);
for (let dir = cwd; ; dir = dirname(dir)) {
  const bin = join(dir, 'node_modules', '.bin');
  if (existsSync(bin)) path.push(bin);
  if (dirname(dir) === dir) break;
}
const inherited = process.env['PATH'];
if (inherited !== undefined && inherited !== '') path.push(inherited);

const result = spawnSync(script, {
  cwd,
  env: { ...process.env, PATH: path.join(delimiter) },
  shell: true,
  stdio: 'inherit',
});
if (result.error !== undefined) {
  console.error(`[pnpm-run-shim] ${name} failed to start: ${String(result.error)}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
