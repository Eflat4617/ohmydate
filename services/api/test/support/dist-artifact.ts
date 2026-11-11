import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  type Dirent,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared services/api build artifact.
 *
 * Tests used to spawn `pnpm run build` from individual beforeAll hooks, so
 * parallel vitest workers raced writing services/api/dist. The artifact is
 * now produced once (root vitest globalSetup) and every consumer validates a
 * build stamp. A cross-process lock owns both the build and any destructive
 * rebuild (the build-smoke test) so consumers never observe a half-written
 * dist.
 */

export const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
export const distDir = join(apiRoot, 'dist');
export const distMain = join(distDir, 'main.js');
export const distMigrate = join(distDir, 'db', 'migrate.js');

const stampPath = join(distDir, '.build-stamp.json');
const lockRoot = join(
  tmpdir(),
  `ohmydate-api-dist-${createHash('sha256').update(apiRoot).digest('hex').slice(0, 16)}.lock`,
);
const ownerPath = join(lockRoot, 'owner.json');
const lockPollMs = 100;
const lockTimeoutMs = 15 * 60_000;
const lockStaleMs = 30 * 60_000;

const sourceRoots = [
  join(apiRoot, 'src'),
  join(apiRoot, '..', '..', 'packages', 'domain', 'src'),
  join(apiRoot, '..', '..', 'packages', 'contracts', 'src'),
  join(apiRoot, '..', '..', 'packages', 'llm', 'src'),
  join(apiRoot, '..', '..', 'packages', 'provider-vikunja', 'src'),
  join(apiRoot, '..', '..', 'packages', 'scheduler', 'src'),
];

interface BuildStamp {
  readonly completedAt: number;
}

let leaseDepth = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newestMtimeMs(root: string): number {
  let newest = 0;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || !existsSync(current)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (mtime > newest) newest = mtime;
      } catch {
        // File vanished between readdir and stat.
      }
    }
  }
  return newest;
}

function sourceFingerprint(): number {
  let newest = 0;
  for (const root of sourceRoots) {
    const mtime = newestMtimeMs(root);
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function readStamp(): BuildStamp | undefined {
  try {
    const parsed = JSON.parse(readFileSync(stampPath, 'utf8')) as Partial<BuildStamp>;
    return typeof parsed.completedAt === 'number' ? { completedAt: parsed.completedAt } : undefined;
  } catch {
    return undefined;
  }
}

export function isApiDistFresh(): boolean {
  if (!existsSync(distMain) || !existsSync(distMigrate)) return false;
  const stamp = readStamp();
  if (stamp === undefined) return false;
  return stamp.completedAt >= sourceFingerprint();
}

export function writeApiDistStamp(): void {
  writeFileSync(
    stampPath,
    `${JSON.stringify({ completedAt: Date.now() } satisfies BuildStamp)}\n`,
    'utf8',
  );
}

export function buildApiDist(): void {
  const execPath = process.env['npm_execpath'];
  const isJsEntry = execPath !== undefined && /\.(c|m)?js$/.test(execPath);
  const command = isJsEntry ? process.execPath : (execPath ?? 'pnpm');
  const prefix = isJsEntry ? [execPath as string] : [];
  const build = spawnSync(command, [...prefix, 'run', 'build'], {
    cwd: apiRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`build failed: ${build.stdout}\n${build.stderr}`);
  }
  writeApiDistStamp();
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function lockIsStale(): Promise<boolean> {
  let age: number;
  try {
    const info = await stat(lockRoot);
    age = Date.now() - info.mtimeMs;
  } catch {
    return false;
  }
  if (age > lockStaleMs) return true;
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number') return !processAlive(owner.pid);
  } catch {
    // Owner file missing or half-written: only reclaim after a short grace.
    return age > 5_000;
  }
  return false;
}

async function acquireProcessLock(): Promise<void> {
  const deadline = Date.now() + lockTimeoutMs;
  for (;;) {
    try {
      await mkdir(lockRoot);
      await writeFile(ownerPath, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await lockIsStale()) {
        rmSync(lockRoot, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${lockRoot}`, { cause: error });
      }
      await delay(lockPollMs);
    }
  }
}

async function releaseProcessLock(): Promise<void> {
  await rm(lockRoot, { recursive: true, force: true });
}

/**
 * Hold the dist lease for the lifetime of a test file. Reentrant within a
 * process (a file may also run the build-smoke script under its own lease).
 */
export async function acquireDistLease(): Promise<void> {
  if (leaseDepth === 0) await acquireProcessLock();
  leaseDepth += 1;
}

export async function releaseDistLease(): Promise<void> {
  if (leaseDepth === 0) return;
  leaseDepth -= 1;
  if (leaseDepth === 0) await releaseProcessLock();
}

/** Ensure dist exists and matches the sources; no-op when the stamp is fresh. */
export async function ensureApiDist(): Promise<void> {
  if (isApiDistFresh()) return;
  const owned = leaseDepth === 0;
  if (owned) await acquireDistLease();
  try {
    if (!isApiDistFresh()) buildApiDist();
  } finally {
    if (owned) await releaseDistLease();
  }
}

/** Rewrite the stamp after an out-of-band rebuild (build-smoke) kept dist fresh. */
export function markApiDistBuilt(): void {
  if (existsSync(distMain) && existsSync(distMigrate)) writeApiDistStamp();
}
