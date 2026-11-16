import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_PATH, type E2EState } from '../helpers/state';

/**
 * Global setup of the `core` target (blueprint 15 §7.3 item 10):
 *
 * 1. builds the web's desktop bundle (`vite build --mode desktop` →
 *    `apps/web/desktop/dist`);
 * 2. starts the Rust core — the test build, `corepack pnpm run core:build` —
 *    on a fresh data directory, serving that bundle (`--web-dir`), with the
 *    owner's zone and locale the specs assume, and with `--clock-offset-ms`
 *    when `E2E_FAKE_NOW` is set;
 * 3. writes the run state. The launch token is not in it: the tests read it
 *    from the core's ready file (0600) when they need it.
 *
 * No PostgreSQL, no Vikunja, no accounts. One process, one owner; a new run
 * is a new data directory and a new process (15 §7.3 item 13).
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const logsDir = path.join(repoRoot, 'test-results', 'e2e', 'logs');
const stateDir = path.dirname(STATE_PATH);
const webDir = path.join(repoRoot, 'apps', 'web');
/** Where `vite build --mode desktop` writes (apps/web/vite.config.ts). */
export const DESKTOP_BUNDLE = path.join(webDir, 'desktop', 'dist');

/** The default target's owners are created with the database defaults; the core is told the same. */
const OWNER_TIME_ZONE = 'UTC';
const OWNER_LOCALE = 'en';

const READY_TIMEOUT_MS = 15_000;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** `E2E_FAKE_NOW` as the offset the core's test clock takes; 0 when unset (the same rule as the default setup). */
export function clockOffsetFromEnv(env: NodeJS.ProcessEnv = process.env, nowMs: number = Date.now()): number {
  const raw = env['E2E_FAKE_NOW'];
  if (raw === undefined || raw.trim().length === 0) return 0;
  const target = Date.parse(raw);
  if (!Number.isFinite(target) || !/(Z|[+-]\d{2}:\d{2})$/.test(raw.trim())) {
    throw new Error(`E2E_FAKE_NOW must be an ISO-8601 instant with a zone, got: ${raw}`);
  }
  return target - nowMs;
}

/** The core binary under test: `OHMYDATE_CORE_BIN`, else the debug build of this checkout. */
export function coreBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env['OHMYDATE_CORE_BIN'] ?? path.join(repoRoot, 'core', 'target', 'debug', 'ohmydate-core');
}

/** The core's arguments for a run. The launch token is not among them: the core makes its own. */
export function coreArgs(options: { readonly dataDir: string; readonly readyFile: string; readonly webDir: string; readonly clockOffsetMs: number }): string[] {
  return [
    '--data-dir',
    options.dataDir,
    '--ready-file',
    options.readyFile,
    '--web-dir',
    options.webDir,
    '--time-zone',
    OWNER_TIME_ZONE,
    '--locale',
    OWNER_LOCALE,
    // Only when the clock is moved: the flag exists in the test build alone.
    ...(options.clockOffsetMs === 0 ? [] : ['--clock-offset-ms', String(Math.trunc(options.clockOffsetMs))]),
  ];
}

function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error !== null) reject(new Error(`${path.basename(command)} ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve();
    });
  });
}

async function buildDesktopBundle(): Promise<void> {
  const vite = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  await run(process.execPath, [vite, 'build', '--mode', 'desktop'], webDir);
  if (!existsSync(path.join(DESKTOP_BUNDLE, 'index.html'))) {
    throw new Error(`the desktop bundle was not written to ${DESKTOP_BUNDLE}`);
  }
}

/** Waits for the core's ready file and returns its port. Nothing else of the file is kept. */
async function waitForPort(readyFile: string, isAlive: () => boolean): Promise<number> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive()) throw new Error('the core ended before it was ready (see test-results/e2e/logs/core.log)');
    try {
      const { port } = JSON.parse(await fs.readFile(readyFile, 'utf8')) as { port?: unknown };
      if (typeof port === 'number' && Number.isInteger(port)) return port;
    } catch {
      // Not written yet.
    }
    await delay(50);
  }
  throw new Error('the core did not write its ready file in time');
}

export default async function coreGlobalSetup(): Promise<void> {
  const binary = coreBinary();
  if (!existsSync(binary)) {
    throw new Error(
      `no core binary at ${binary}. Build the test binary first: \`corepack pnpm run core:build\` (\`corepack pnpm run e2e:core\` does).`,
    );
  }
  const clockOffsetMs = clockOffsetFromEnv();

  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(logsDir, { recursive: true });
  await buildDesktopBundle();

  // Private to this user (mkdtemp: 0700). The data directory and the ready file live in it.
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohmydate-e2e-core-'));
  const readyFile = path.join(runDir, 'ready.json');
  const dataDir = path.join(runDir, 'data');
  await fs.mkdir(dataDir, { mode: 0o700 });

  let pid = 0;
  try {
    // The core logs to stderr: ids, codes and counts — never the token (15 §1.6).
    const log = openSync(path.join(logsDir, 'core.log'), 'a');
    const child = spawn(binary, coreArgs({ dataDir, readyFile, webDir: DESKTOP_BUNDLE, clockOffsetMs }), {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, OHMYDATE_LOG: process.env['OHMYDATE_LOG'] ?? 'warn' },
      stdio: ['ignore', 'ignore', log],
    });
    closeSync(log);
    if (child.pid === undefined) throw new Error('failed to start the core');
    pid = child.pid;
    let alive = true;
    child.once('exit', () => {
      alive = false;
    });
    const port = await waitForPort(readyFile, () => alive);
    child.unref();

    const origin = `http://127.0.0.1:${port}`;
    const state: Pick<E2EState, 'target' | 'core' | 'webUrl' | 'apiUrl' | 'clockOffsetMs'> = {
      target: 'core',
      // The core serves the web and the API from one origin.
      webUrl: origin,
      apiUrl: origin,
      core: { pid, runDir, readyFile },
      ...(clockOffsetMs === 0 ? {} : { clockOffsetMs }),
    };
    await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    if (pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    await fs.rm(runDir, { recursive: true, force: true });
    throw error;
  }
}
