import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_PATH, type E2EState } from '../helpers/state';

/**
 * Global teardown of the `core` target: the core is stopped with SIGTERM (it
 * drains, deletes its ready file and exits 0 — blueprint 15 §1.5), then the
 * run's private directory, with the data file in it, is removed.
 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopCore(pid: number): Promise<void> {
  if (pid <= 0 || !isRunning(pid)) return;
  process.kill(pid, 'SIGTERM');
  // The core's own drain budget is 12 s.
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (!isRunning(pid)) return;
    await delay(200);
  }
  process.kill(pid, 'SIGKILL');
}

/** Only a directory this target made is ever removed: `<tmp>/ohmydate-e2e-core-…`. */
export function isRunDirectory(candidate: string): boolean {
  const resolved = path.resolve(candidate);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('ohmydate-e2e-core-');
}

export default async function coreGlobalTeardown(): Promise<void> {
  let state: E2EState;
  try {
    state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8')) as E2EState;
  } catch {
    return;
  }
  try {
    if (state.core !== undefined) {
      await stopCore(state.core.pid);
      if (isRunDirectory(state.core.runDir)) await fs.rm(state.core.runDir, { recursive: true, force: true });
    }
  } finally {
    await fs.rm(STATE_PATH, { force: true });
  }
}
