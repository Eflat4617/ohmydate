#!/usr/bin/env node
// Stop only the local API/web processes started by scripts/local/start.mjs.
// Never touches docker or the database.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createContext,
  fail,
  isEntryPoint,
  log,
  parseFlags,
  processAlive,
} from './common.mjs';

const STOP_TIMEOUT_MS = 15_000;

function readPid(runDir, name) {
  try {
    const raw = readFileSync(join(runDir, `${name}.pid`), 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function signal(pid, name) {
  try {
    process.kill(-pid, name);
    return true;
  } catch {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopProcess(pid, timeoutMs) {
  if (!processAlive(pid)) return 'already-stopped';
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return 'terminated';
    await delay(100);
  }
  signal(pid, 'SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!processAlive(pid)) return 'killed';
    await delay(100);
  }
  return 'still-running';
}

export async function stopLocal(options = {}) {
  const context = options.context ?? createContext(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const results = [];
  for (const name of ['api', 'web']) {
    const pidFile = join(context.runDir, `${name}.pid`);
    const pid = readPid(context.runDir, name);
    if (pid === null) {
      results.push({ name, status: 'not-running', pid: null });
      continue;
    }
    const status = await stopProcess(pid, timeoutMs);
    if (status !== 'still-running') rmSync(pidFile, { force: true });
    results.push({ name, status, pid });
  }
  return results;
}

async function main() {
  const { flags } = parseFlags(process.argv.slice(2));
  if (flags.has('help')) {
    console.log('usage: node scripts/local/stop.mjs');
    return;
  }
  const results = await stopLocal();
  for (const result of results) {
    const label = result.name === 'api' ? 'API' : '웹';
    if (result.status === 'not-running') {
      log(`${label}: 실행 중이 아닙니다.`);
    } else if (result.status === 'still-running') {
      log(`${label}: 종료하지 못했습니다 (pid ${String(result.pid)}).`);
    } else {
      log(`${label}: 종료됨 (pid ${String(result.pid)}, ${result.status}).`);
    }
  }
  if (results.some((result) => result.status === 'still-running')) process.exitCode = 1;
}

if (isEntryPoint(import.meta.url)) {
  await main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
