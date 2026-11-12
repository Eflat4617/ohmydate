#!/usr/bin/env node
// PID-file identity. A PID alone is not enough: after a reboot, a crash or a
// failed start the file can point at an unrelated process (or a recycled PID).
// Every record carries the kernel start time and a random marker that the
// child received through its environment. A signal is sent only when both
// still match the live process; otherwise the file is stale and never
// signalled.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processAlive } from './common.mjs';

export const PROCESS_MARKER_ENV = 'OHMYDATE_LOCAL_PROCESS_MARKER';

export function createMarker() {
  return randomBytes(16).toString('hex');
}

export function pidFilePath(runDir, name) {
  return join(runDir, `${name}.pid`);
}

/** Field 22 of /proc/<pid>/stat, which does not change for a live process. */
export function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return null;
    const fields = stat.slice(end + 2).trim().split(/\s+/u);
    const startTime = fields[19];
    return typeof startTime === 'string' && startTime.length > 0 ? startTime : null;
  } catch {
    return null;
  }
}

export function processEnviron(pid) {
  try {
    return readFileSync(`/proc/${String(pid)}/environ`, 'utf8');
  } catch {
    return null;
  }
}

export function processMatches(record) {
  if (record === null || typeof record !== 'object') return false;
  const pid = record.pid;
  const marker = record.marker;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (typeof marker !== 'string' || marker.length === 0) return false;
  if (!processAlive(pid)) return false;
  const startTime = processStartTime(pid);
  if (startTime === null) return false;
  if (typeof record.startTime === 'string' && record.startTime !== startTime) return false;
  const environ = processEnviron(pid);
  if (environ === null) return false;
  return environ.split('\0').includes(`${PROCESS_MARKER_ENV}=${marker}`);
}

export async function readPidRecord(runDir, name) {
  const path = pidFilePath(runDir, name);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { status: 'missing', path, record: null };
  }
  let record;
  try {
    const parsed = JSON.parse(raw.trim());
    record =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    record = null;
  }
  return { status: 'present', path, record };
}

export async function writePidRecord(runDir, name, pid, marker, extra = {}) {
  const record = {
    pid,
    marker,
    startTime: processStartTime(pid),
    ...extra,
  };
  const path = pidFilePath(runDir, name);
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return record;
}

export async function removePidRecord(runDir, name) {
  await rm(pidFilePath(runDir, name), { force: true });
}

/**
 * Inspect a PID file without signalling anything.
 * status: missing | dead | mismatch | running
 */
export async function inspectProcess(runDir, name) {
  const { status, path, record } = await readPidRecord(runDir, name);
  if (status === 'missing') return { status: 'missing', path, record, alive: false };
  const pid = typeof record?.pid === 'number' ? record.pid : null;
  const alive = pid !== null && processAlive(pid);
  if (!alive) return { status: 'dead', path, record, alive: false };
  if (!processMatches(record)) return { status: 'mismatch', path, record, alive: true };
  return { status: 'running', path, record, alive: true };
}

/** Only call this after inspectProcess returned running. */
export function signalRecord(record, signal) {
  if (!processMatches(record)) return false;
  try {
    process.kill(-record.pid, signal);
    return true;
  } catch {
    try {
      process.kill(record.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

export async function stopRecord(record, timeoutMs) {
  if (!processMatches(record)) return 'stale';
  signalRecord(record, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(record.pid)) return 'terminated';
    if (!processMatches(record)) return 'terminated';
    await delay(100);
  }
  signalRecord(record, 'SIGKILL');
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline) {
    if (!processAlive(record.pid)) return 'killed';
    if (!processMatches(record)) return 'killed';
    await delay(100);
  }
  return 'still-running';
}

export function processRecordMatches(record) {
  return processMatches(record);
}
