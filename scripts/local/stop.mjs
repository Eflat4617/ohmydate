#!/usr/bin/env node
// Stop only the local API/web processes started by scripts/local/start.mjs.
// A PID is signalled only when its start time and marker still match, so a
// foreign or recycled PID is never touched. Never touches docker or the DB.
import {
  createContext,
  fail,
  isEntryPoint,
  log,
  parseFlags,
} from './common.mjs';
import { inspectProcess, removePidRecord, stopRecord } from './pid.mjs';

const STOP_TIMEOUT_MS = 20_000;

export async function stopLocal(options = {}) {
  const context = options.context ?? createContext(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? STOP_TIMEOUT_MS;
  const results = [];
  for (const name of ['api', 'web']) {
    const inspection = await inspectProcess(context.runDir, name);
    if (inspection.status === 'missing') {
      results.push({ name, status: 'not-running', pid: null });
      continue;
    }
    const pid = typeof inspection.record?.pid === 'number' ? inspection.record.pid : null;
    if (inspection.status !== 'running') {
      await removePidRecord(context.runDir, name);
      results.push({ name, status: 'stale', pid });
      continue;
    }
    const status = await stopRecord(inspection.record, timeoutMs);
    if (status !== 'still-running') await removePidRecord(context.runDir, name);
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
    } else if (result.status === 'stale') {
      log(`${label}: 오래된 PID 파일을 지웠습니다 (pid ${String(result.pid)}, 신호를 보내지 않음).`);
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
