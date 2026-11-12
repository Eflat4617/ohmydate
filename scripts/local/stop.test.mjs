import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext, processAlive } from './common.mjs';
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

describe('stop', () => {
  test('SIGTERM stops a detached process and removes its pid file', async () => {
    const runDir = await tempDir();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    children.push(child);
    child.unref();
    await writeFile(join(runDir, 'api.pid'), `${String(child.pid)}\n`, { mode: 0o600 });

    const context = createContext({
      ...process.env,
      OHMYDATE_LOCAL_RUN_DIR: runDir,
    });
    const results = await stopLocal({ context, timeoutMs: 5_000 });

    expect(results.find((entry) => entry.name === 'api')?.status).toMatch(/terminated|killed/u);
    expect(processAlive(child.pid)).toBe(false);
    expect(await readdir(runDir)).toEqual([]);
  });

  test('reports not-running when there is no pid file', async () => {
    const runDir = await tempDir();
    const context = createContext({
      ...process.env,
      OHMYDATE_LOCAL_RUN_DIR: runDir,
    });
    const results = await stopLocal({ context, timeoutMs: 1_000 });
    expect(results.map((entry) => entry.status)).toEqual(['not-running', 'not-running']);
  });
});
