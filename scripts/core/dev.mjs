#!/usr/bin/env node
// `corepack pnpm run core:dev` — the web on the Rust core, for development
// (blueprint 15 §7.3 items 8–9).
//
// One command:
//   1. builds the core (`cargo build -p ohmydate-server --features test-clock`,
//      the same binary `core:build` makes, so nothing is rebuilt between this
//      and the tests);
//   2. starts it on a data directory — a temporary one, or `--data-dir <dir>`
//      to keep what you make — with the dev server's origin allowed;
//   3. starts Vite in desktop mode, whose `/api` proxy adds the core's launch
//      token (apps/web/config/coreProxy.ts).
// Stopping it (Ctrl-C, SIGTERM, or either process ending) stops both.
//
// The launch token is a secret. This script takes only the port out of the
// core's ready file (0600) and hands the dev server the file's *path*. The
// token is never kept in a variable here, and is not in an argument, an
// environment variable, the browser bundle, or anything printed.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { clearTimeout, setTimeout } from 'node:timers';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');

export const DEFAULT_WEB_PORT = 5173;
/** The variable the dev server reads (apps/web/config/coreProxy.ts). */
export const CORE_READY_FILE_ENV = 'OHMYDATE_CORE_READY_FILE';
const READY_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 15_000;

export const USAGE = `Usage: corepack pnpm run core:dev [-- options]

  --data-dir <dir>   Keep the data in <dir> (created if missing). Without it the
                     data lives in a temporary directory that is deleted on exit.
  --port <n>         Port of the dev server (default ${DEFAULT_WEB_PORT}). It is the origin
                     the core allows, so it is not changed if taken.
  --time-zone <tz>   Time zone of a new owner (IANA name; default: the core's).
  --locale <tag>     Locale of a new owner (default: the core's).
  --skip-build       Do not run cargo; use the binary that is there.
  -h, --help         This text.
`;

export class UsageError extends Error {}

/** Parses the launcher's own arguments. Throws `UsageError` for anything it does not know. */
export function parseArgs(argv) {
  const options = { dataDir: null, port: DEFAULT_WEB_PORT, timeZone: null, locale: null, skipBuild: false, help: false };
  const args = [...argv];
  // pnpm passes a bare `--` through when it is given.
  if (args[0] === '--') args.shift();
  while (args.length > 0) {
    const flag = args.shift();
    const value = () => {
      const next = args.shift();
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return next;
    };
    switch (flag) {
      case '--data-dir':
        options.dataDir = resolve(value());
        break;
      case '--port': {
        const raw = value();
        const port = Number(raw);
        if (!/^\d+$/.test(raw) || port < 1 || port > 65535) throw new UsageError(`--port must be 1–65535, got: ${raw}`);
        options.port = port;
        break;
      }
      case '--time-zone':
        options.timeZone = value();
        break;
      case '--locale':
        options.locale = value();
        break;
      case '--skip-build':
        options.skipBuild = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new UsageError(`unknown option: ${flag}`);
    }
  }
  return options;
}

/** The dev server's origins, as a browser names them: what the core must allow. */
export function devOrigins(port) {
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

/** The core's arguments. The token is not among them: the core makes it and writes the ready file. */
export function coreArgs({ dataDir, readyFile, port, timeZone, locale }) {
  return [
    '--data-dir',
    dataDir,
    '--ready-file',
    readyFile,
    ...devOrigins(port).flatMap((origin) => ['--allow-origin', origin]),
    ...(timeZone === null || timeZone === undefined ? [] : ['--time-zone', timeZone]),
    ...(locale === null || locale === undefined ? [] : ['--locale', locale]),
  ];
}

/** The dev server's arguments: desktop mode, on exactly the port the core allows. */
export function viteArgs(port) {
  return ['--mode', 'desktop', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
}

/**
 * The dev server's environment: the caller's, plus the ready file's path —
 * and without a mock switch, which would mean nothing here.
 */
export function viteEnv(base, readyFile) {
  const env = { ...base, [CORE_READY_FILE_ENV]: readyFile };
  delete env['VITE_MOCK'];
  return env;
}

/** `cargo` may be installed by rustup without being on PATH (AGENTS.md). */
export function cargoEnv(base) {
  const cargoBin = join(os.homedir(), '.cargo', 'bin');
  const path = base['PATH'] ?? '';
  return {
    ...base,
    PATH: path.split(delimiter).includes(cargoBin) ? path : `${cargoBin}${delimiter}${path}`,
    // A 15 GB laptop: the build never takes every core unless told to.
    CARGO_BUILD_JOBS: base['CARGO_BUILD_JOBS'] ?? '4',
  };
}

function log(message) {
  process.stdout.write(`[core:dev] ${message}\n`);
}

function run(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ended with ${signal ?? `code ${String(code)}`}`));
    });
  });
}

/** Waits until the core has written its ready file; returns its port and keeps nothing else of it. */
async function waitForCore(readyFile, core) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (core.exitCode !== null) {
      throw new Error(
        core.exitCode === 3
          ? 'the core is already running on this data directory (exit code 3)'
          : `the core ended with code ${String(core.exitCode)} before it was ready`,
      );
    }
    try {
      const { port } = JSON.parse(await readFile(readyFile, 'utf8'));
      if (Number.isInteger(port)) return port;
    } catch {
      // Not written yet, or half written.
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
  throw new Error('the core did not become ready in time');
}

function stop(child) {
  return new Promise((resolveStop) => {
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      resolveStop();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const binary = join(repoRoot, 'core', 'target', 'debug', 'ohmydate-core');
  const viteBin = join(repoRoot, 'apps', 'web', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    process.stderr.write('apps/web has no vite: run `corepack pnpm install` first.\n');
    return 1;
  }

  if (!options.skipBuild) {
    log('building the core (cargo build -p ohmydate-server --features test-clock)');
    await run('cargo', ['build', '-p', 'ohmydate-server', '--features', 'test-clock'], {
      cwd: join(repoRoot, 'core'),
      env: cargoEnv(process.env),
    });
  }
  if (!existsSync(binary)) {
    process.stderr.write(`no core binary at ${binary}: run without --skip-build.\n`);
    return 1;
  }

  // Private to this user (mkdtemp makes it 0700): the ready file, and the data unless a directory was given.
  const runDir = await mkdtemp(join(os.tmpdir(), 'ohmydate-core-dev-'));
  const readyFile = join(runDir, 'ready.json');
  const dataDir = options.dataDir ?? join(runDir, 'data');
  await mkdir(dataDir, { recursive: true });

  let core = null;
  let vite = null;
  let stopping = null;
  const shutdown = (code) => {
    stopping ??= (async () => {
      await stop(vite);
      // SIGTERM: the core drains, deletes its ready file and exits 0.
      await stop(core);
      await rm(runDir, { recursive: true, force: true });
      return code;
    })();
    return stopping;
  };

  const finished = new Promise((resolveFinished) => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.once(signal, () => {
        log('stopping');
        void shutdown(0).then(resolveFinished);
      });
    }
    void (async () => {
      try {
        core = spawn(binary, coreArgs({ ...options, dataDir, readyFile }), {
          cwd: repoRoot,
          // The core logs to stderr (ids, codes and counts only; never the token).
          stdio: ['ignore', 'ignore', 'inherit'],
          env: { ...process.env, OHMYDATE_LOG: process.env['OHMYDATE_LOG'] ?? 'warn' },
        });
        core.once('exit', (code) => {
          if (stopping === null) {
            log(`the core ended (code ${String(code)}); stopping the dev server`);
            void shutdown(code === 0 ? 0 : 1).then(resolveFinished);
          }
        });
        const corePort = await waitForCore(readyFile, core);
        log(`core:  http://127.0.0.1:${corePort}  (data: ${options.dataDir ?? 'temporary, deleted on exit'})`);

        vite = spawn(process.execPath, [viteBin, ...viteArgs(options.port)], {
          cwd: join(repoRoot, 'apps', 'web'),
          stdio: 'inherit',
          env: viteEnv(process.env, readyFile),
        });
        vite.once('exit', (code) => {
          if (stopping === null) {
            log(`the dev server ended (code ${String(code)}); stopping the core`);
            void shutdown(code === 0 ? 0 : 1).then(resolveFinished);
          }
        });
        log(`web:   http://127.0.0.1:${options.port}  (open this one)`);
      } catch (error) {
        process.stderr.write(`[core:dev] ${error instanceof Error ? error.message : String(error)}\n`);
        void shutdown(1).then(resolveFinished);
      }
    })();
  });
  return finished;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`[core:dev] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
