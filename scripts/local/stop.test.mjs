import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext, processAlive } from './common.mjs';
import {
  createMarker,
  pidFilePath,
  PROCESS_MARKER_ENV,
  writePidRecord,
} from './pid.mjs';
import { stopLocal } from './stop.mjs';

const tempDirs = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-stop-'));
  tempDirs.push(dir);
  return dir;
}

function spawnInterval(env = process.env) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  children.push(child);
  child.unref();
  return child;
}

function contextFor(runDir) {
  return createContext({ ...process.env, OHMYDATE_LOCAL_RUN_DIR: runDir });
}

describe('stop', () => {
  test('SIGTERM stops a matching detached process and removes its pid file', async () => {
    const runDir = await tempDir();
    const marker = createMarker();
    const child = spawnInterval({ ...process.env, [PROCESS_MARKER_ENV]: marker });
    await writePidRecord(runDir, 'api', child.pid, marker);

    const results = await stopLocal({ context: contextFor(runDir), timeoutMs: 5_000 });

    expect(results.find((entry) => entry.name === 'api')?.status).toMatch(/terminated|killed/u);
    expect(processAlive(child.pid)).toBe(false);
    expect(await readdir(runDir)).toEqual([]);
  });

  test('a foreign live PID is neither signalled nor reported as running', async () => {
    const runDir = await tempDir();
    const foreign = spawnInterval();
    // A PID file whose marker does not belong to the live process.
    await writeFile(
      pidFilePath(runDir, 'api'),
      `${JSON.stringify({ pid: foreign.pid, marker: createMarker(), startTime: '0' })}\n`,
      { mode: 0o600 },
    );

    const results = await stopLocal({ context: contextFor(runDir), timeoutMs: 1_000 });

    expect(results.find((entry) => entry.name === 'api')?.status).toBe('stale');
    expect(processAlive(foreign.pid)).toBe(true);
    expect(await readdir(runDir)).toEqual([]);
  });

  test('a dead PID is cleaned up without a signal', async () => {
    const runDir = await tempDir();
    const marker = createMarker();
    const child = spawnInterval({ ...process.env, [PROCESS_MARKER_ENV]: marker });
    await writePidRecord(runDir, 'api', child.pid, marker);
    process.kill(-child.pid, 'SIGKILL');
    await new Promise((resolveGone) => {
      const deadline = Date.now() + 2_000;
      const poll = () => {
        if (!processAlive(child.pid) || Date.now() > deadline) resolveGone();
        else globalThis.setTimeout(poll, 20);
      };
      poll();
    });

    const results = await stopLocal({ context: contextFor(runDir), timeoutMs: 1_000 });

    expect(results.find((entry) => entry.name === 'api')?.status).toBe('stale');
    expect(await readdir(runDir)).toEqual([]);
  });

  test('reports not-running when there is no pid file', async () => {
    const runDir = await tempDir();
    const results = await stopLocal({ context: contextFor(runDir), timeoutMs: 1_000 });
    expect(results.map((entry) => entry.status)).toEqual(['not-running', 'not-running']);
  });
});
