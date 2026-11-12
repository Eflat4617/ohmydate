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
  parseFlags,
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

function stripVolumeFlags(args) {
  return args.filter((arg) => arg !== '-v' && arg !== '--volumes');
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
    return { command: 'sudo', args: [...command, 'down', ...stripVolumeFlags(extra)] };
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
  const { flags, positionals } = parseFlags(process.argv.slice(2));
  if (flags.has('help') || positionals.length === 0) {
    console.log(
      'usage: node scripts/local/compose.mjs <up|down|ps|logs> [--dry-run] [-- extra args]\n' +
        '  up    start the stack detached (sudo docker compose ... up -d)\n' +
        '  down  stop containers; NEVER removes volumes (-v is ignored)\n' +
        '  ps    show container status\n' +
        '  logs  last 200 lines (no follow)\n' +
        '  --dry-run prints the exact command without running docker',
    );
    return;
  }
  const action = positionals[0];
  const invocation = composeInvocation(action, positionals.slice(1));
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
