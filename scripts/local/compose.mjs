#!/usr/bin/env node
// `pnpm local:stack <up|down|ps|logs>`: one place that resolves the absolute
// compose/env paths and runs `sudo docker compose` so the caller's cwd and
// sudo's HOME cannot change what is mounted. `down` never removes volumes.
import { spawnSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  createContext,
  ensureDir,
  fail,
  isEntryPoint,
  log,
  repoRoot,
} from './common.mjs';

export const COMPOSE_PROJECT = 'ohmydate-local';
export const COMPOSE_ACTIONS = new Set(['up', 'down', 'ps', 'logs']);

export function composeFile() {
  return join(repoRoot, 'deploy/local/compose.yaml');
}

export function composeEnvFile() {
  return join(repoRoot, 'deploy/local/local.env');
}

/**
 * `--dry-run` and `--help` are booleans: unlike common.parseFlags they never
 * consume the following token as a value. Everything after the first `--` is a
 * verbatim docker compose argument, so `local:stack logs -- vikunja` forwards
 * the service name (FU-90 finding 1).
 */
export function parseComposeArgv(argv) {
  const separator = argv.indexOf('--');
  const head = separator < 0 ? argv : argv.slice(0, separator);
  const passthrough = separator < 0 ? [] : argv.slice(separator + 1);
  const flags = new Set();
  const positionals = [];
  for (const arg of head) {
    if (arg === '--dry-run') flags.add('dry-run');
    else if (arg === '--help') flags.add('help');
    else positionals.push(arg);
  }
  return { flags, positionals, passthrough };
}

const DOWN_TIMEOUT_FLAGS = new Set(['-t', '--timeout']);

/** Allow-list `down` arguments; every spelling of -v/--volumes is refused. */
export function validateDownArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--remove-orphans') {
      result.push(arg);
      continue;
    }
    if (DOWN_TIMEOUT_FLAGS.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error(`down 의 ${arg} 에는 초 단위 숫자가 필요합니다.`);
      }
      result.push(arg, value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--timeout=')) {
      const value = arg.slice('--timeout='.length);
      if (!/^\d+$/u.test(value)) {
        throw new Error('down 의 --timeout 에는 초 단위 숫자가 필요합니다.');
      }
      result.push(arg);
      continue;
    }
    throw new Error(
      `down 에서는 지원하지 않는 인자입니다: ${arg}. ` +
        '허용: --remove-orphans, -t/--timeout <초>. ' +
        '-v/--volumes 는 볼륨을 지우므로 허용하지 않습니다.',
    );
  }
  return result;
}

/** Build the sudo docker compose argv. Never includes -v on down. */
export function composeInvocation(action, extra = []) {
  if (!COMPOSE_ACTIONS.has(action)) {
    throw new Error(`알 수 없는 local:stack 명령입니다: ${action} (up|down|ps|logs)`);
  }
  const command = [
    'docker',
    'compose',
    '-p',
    COMPOSE_PROJECT,
    '--env-file',
    composeEnvFile(),
    '-f',
    composeFile(),
  ];
  if (action === 'up') {
    const args = extra.includes('-d') ? extra : ['-d', ...extra];
    return { command: 'sudo', args: [...command, 'up', ...args] };
  }
  if (action === 'down') {
    return { command: 'sudo', args: [...command, 'down', ...validateDownArgs(extra)] };
  }
  if (action === 'logs') {
    return {
      command: 'sudo',
      args: [...command, 'logs', '--tail', '200', ...extra.filter((arg) => arg !== '-f')],
    };
  }
  return { command: 'sudo', args: [...command, 'ps', ...extra] };
}

export function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function formatCommand(invocation) {
  return [invocation.command, ...invocation.args].map(shellQuote).join(' ');
}

async function recordStackState(context, invocation) {
  await ensureDir(dirname(context.stackStateFile), 0o700);
  const body = {
    project: COMPOSE_PROJECT,
    composeFile: composeFile(),
    envFile: composeEnvFile(),
    volumes: ['pgdata', 'vikunja-files'],
    command: formatCommand(invocation),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(context.stackStateFile, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  await chmod(context.stackStateFile, 0o600);
}

async function main() {
  const { flags, positionals, passthrough } = parseComposeArgv(process.argv.slice(2));
  if (flags.has('help') || positionals.length === 0) {
    console.log(
      'usage: node scripts/local/compose.mjs <up|down|ps|logs> [--dry-run] [-- extra args]\n' +
        '  up    start the stack detached (sudo docker compose ... up -d)\n' +
        '  down  stop containers; NEVER removes volumes (-v is refused)\n' +
        '  ps    show container status\n' +
        '  logs  last 200 lines (no follow)\n' +
        '  --dry-run prints the exact command without running docker\n' +
        '  -- extra args are passed to docker compose verbatim',
    );
    return;
  }
  const action = positionals[0];
  const extras = [...positionals.slice(1), ...passthrough];
  const invocation = composeInvocation(action, extras);
  const printed = formatCommand(invocation);
  log(`실행: ${printed}`);
  if (flags.has('dry-run')) {
    log('(--dry-run: docker를 실행하지 않았습니다)');
    return;
  }
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`compose 명령이 ${String(result.status)} 로 끝났습니다.`);
  }
  if (action === 'up') {
    await recordStackState(createContext(process.env), invocation);
  }
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
