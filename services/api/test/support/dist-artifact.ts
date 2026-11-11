import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared services/api build artifact.
 *
 * Each Vitest invocation builds services/api/dist exactly once in globalSetup
 * and stamps it with a random per-invocation build id. Consumers assert the
 * stamp before spawning `dist/main.js`, so a stale, missing, or foreign build
 * fails loudly instead of silently testing old code.
 *
 * Cross-invocation exclusion (two Vitest runs, the build-smoke test, or a
 * crashed previous run) uses a token-owned directory lock. Stale locks are
 * reclaimed only through an atomic rename to a unique tombstone, so exactly
 * one waiter can win the reclaim.
 */

export const API_DIST_BUILD_ID_KEY = 'ohmydateApiDistBuildId' as const;

declare module 'vitest' {
  export interface ProvidedContext {
    readonly ohmydateApiDistBuildId: string;
  }
}

export const defaultApiRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface ApiDistArtifact {
  readonly apiRoot: string;
  readonly distDir: string;
  readonly mainPath: string;
  readonly migratePath: string;
  readonly buildIdPath: string;
}

export interface DistLockOptions {
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly ownerGraceMs?: number;
  readonly isAlive?: (pid: number) => boolean;
  /**
   * Test seam: runs after the staging owner directory is fully written but
   * before it is atomically published at the lock path. Lets a deterministic
   * test pause publication while a second waiter reclaims a crashed lease.
   */
  readonly beforePublish?: () => Promise<void> | void;
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
}

const defaultPollMs = 100;
const defaultTimeoutMs = 15 * 60_000;
const defaultOwnerGraceMs = 5_000;

export function apiDistArtifact(apiRoot: string = defaultApiRoot): ApiDistArtifact {
  const distDir = join(apiRoot, 'dist');
  return {
    apiRoot,
    distDir,
    mainPath: join(distDir, 'main.js'),
    migratePath: join(distDir, 'db', 'migrate.js'),
    buildIdPath: join(distDir, '.build-id'),
  };
}

export function hasApiDistArtifact(artifact: ApiDistArtifact): boolean {
  return existsSync(artifact.mainPath) && existsSync(artifact.migratePath);
}

export function writeApiDistBuildId(artifact: ApiDistArtifact, buildId: string): void {
  if (typeof buildId !== 'string' || buildId.trim() === '') {
    throw new Error('api dist build id must be a non-empty string');
  }
  if (!hasApiDistArtifact(artifact)) {
    throw new Error(
      `cannot stamp ${artifact.distDir}: compiled artifact is missing (expected ${artifact.mainPath})`,
    );
  }
  writeFileSync(artifact.buildIdPath, `${buildId}\n`, 'utf8');
}

export function readApiDistBuildId(artifact: ApiDistArtifact): string | undefined {
  try {
    const raw = readFileSync(artifact.buildIdPath, 'utf8').trim();
    return raw === '' ? undefined : raw;
  } catch {
    return undefined;
  }
}

export function assertApiDistArtifact(
  artifact: ApiDistArtifact,
  expectedBuildId: string,
): void {
  if (typeof expectedBuildId !== 'string' || expectedBuildId.trim() === '') {
    throw new Error('api dist assertion requires the current vitest invocation build id');
  }
  if (!existsSync(artifact.mainPath) || !existsSync(artifact.migratePath)) {
    throw new Error(
      `services/api/dist artifact is missing (${artifact.mainPath}); vitest globalSetup must build it`,
    );
  }
  if (!existsSync(artifact.buildIdPath)) {
    throw new Error(
      `services/api/dist build id is missing (${artifact.buildIdPath}); the artifact was rebuilt outside this vitest invocation`,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(artifact.buildIdPath, 'utf8');
  } catch (error) {
    throw new Error(`services/api/dist build id is unreadable`, { cause: error });
  }
  const buildId = raw.trim();
  if (!/^[0-9a-f][0-9a-f-]{7,}$/iu.test(buildId)) {
    throw new Error(`services/api/dist build id is corrupt: ${JSON.stringify(buildId)}`);
  }
  if (buildId !== expectedBuildId) {
    throw new Error(
      `services/api/dist build id mismatch: dist was built as "${buildId}" but this vitest invocation expects "${expectedBuildId}"`,
    );
  }
}

export function runApiDistBuild(apiRoot: string = defaultApiRoot): void {
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
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === code
  );
}

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Token-owned cross-process directory lock.
 *
 * acquire: write the owner into a unique, fully written staging directory and
 * then atomically rename it onto the lock path; the rename itself is the
 * acquire and fails while a non-empty holder directory exists. A stale holder
 * (owner process gone, or owner file absent beyond the grace period) is removed
 * only by renaming the exact observed directory to a unique tombstone and
 * re-verifying the owner token there; if a replacement lease was published in
 * between, it is put back instead. The filesystem makes exactly one reclaimer
 * win that rename. release removes the directory only when the stored token is
 * still ours.
 */
export class DistLock {
  readonly #dir: string;
  readonly #token: string;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #ownerGraceMs: number;
  readonly #isAlive: (pid: number) => boolean;
  readonly #beforePublish: (() => Promise<void> | void) | undefined;
  #held = false;

  constructor(dir: string, token: string = randomUUID(), options: DistLockOptions = {}) {
    if (token.trim() === '') throw new Error('dist lock token must be non-empty');
    this.#dir = dir;
    this.#token = token;
    this.#pollMs = options.pollMs ?? defaultPollMs;
    this.#timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.#ownerGraceMs = options.ownerGraceMs ?? defaultOwnerGraceMs;
    this.#isAlive = options.isAlive ?? defaultIsAlive;
    this.#beforePublish = options.beforePublish;
  }

  get directory(): string {
    return this.#dir;
  }

  get token(): string {
    return this.#token;
  }

  get held(): boolean {
    return this.#held;
  }

  async acquire(): Promise<void> {
    if (this.#held) return;
    const deadline = Date.now() + this.#timeoutMs;
    for (;;) {
      if (await this.#tryPublish()) {
        this.#held = true;
        return;
      }
      const owner = await this.#readOwner(this.#dir);
      if (owner === undefined) {
        if (await this.#isOlderThan(this.#dir, this.#ownerGraceMs)) {
          await this.#reclaim(undefined);
        }
      } else if (!this.#isAlive(owner.pid)) {
        await this.#reclaim(owner.token);
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for dist lock ${this.#dir}`);
      }
      await delay(this.#pollMs);
    }
  }

  /** Returns true only when this instance removed a lock still owned by its token. */
  async release(): Promise<boolean> {
    if (!this.#held) return false;
    this.#held = false;
    const owner = await this.#readOwner(this.#dir);
    if (owner === undefined || owner.token !== this.#token) return false;
    // Rename our lease away atomically instead of removing files in place: a
    // concurrent acquirer can then publish only after the lock path is free,
    // and it can never observe (or be clobbered by) a half-removed directory.
    const tombstone = `${this.#dir}.released-${randomUUID()}`;
    try {
      await rename(this.#dir, tombstone);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    }
    const moved = await this.#readOwner(tombstone);
    if (moved === undefined || moved.token !== this.#token) {
      // Our lease was replaced between the read and the rename. Put it back;
      // this release must not destroy someone else's live lease.
      try {
        await rename(tombstone, this.#dir);
      } catch (error) {
        throw new Error(`dist lock release raced for ${this.#dir}`, { cause: error });
      }
      return false;
    }
    await rm(tombstone, { recursive: true, force: true });
    return true;
  }

  /**
   * Publish our ownership atomically: build a complete owner directory under a
   * unique staging name, then rename it onto the lock path. Rename succeeds
   * only when the lock path is free (or an empty leftover directory), so no
   * waiter can ever observe a directory without its owner token.
   */
  async #tryPublish(): Promise<boolean> {
    const staging = `${this.#dir}.owner-${randomUUID()}`;
    let published = false;
    try {
      await mkdir(staging);
      await writeFile(
        join(staging, 'owner.json'),
        `${JSON.stringify({ token: this.#token, pid: process.pid } satisfies LockOwner)}\n`,
        'utf8',
      );
      if (this.#beforePublish !== undefined) await this.#beforePublish();
      try {
        await rename(staging, this.#dir);
      } catch (error) {
        if (
          isErrno(error, 'EEXIST') ||
          isErrno(error, 'ENOTEMPTY') ||
          isErrno(error, 'ENOTDIR')
        ) {
          return false;
        }
        throw error;
      }
      published = true;
      return true;
    } finally {
      if (!published) await rm(staging, { recursive: true, force: true });
    }
  }

  async #reclaim(expectedToken: string | undefined): Promise<void> {
    // Re-read the owner now: never reclaim a lease other than the one observed
    // as stale. An atomically published replacement always carries its owner
    // token, so a changed/absent token means someone else won.
    const observed = await this.#readOwner(this.#dir);
    if (expectedToken === undefined) {
      if (observed !== undefined) return;
    } else if (observed === undefined || observed.token !== expectedToken) {
      return;
    }

    const tombstone = `${this.#dir}.tombstone-${randomUUID()}`;
    try {
      await rename(this.#dir, tombstone);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    const moved = await this.#readOwner(tombstone);
    const movedIsObserved =
      expectedToken === undefined
        ? moved === undefined
        : moved !== undefined && moved.token === expectedToken;
    if (!movedIsObserved) {
      // A replacement lease was published between our stale read and the
      // rename. Put the live lock back; never proceed to acquire on top of it.
      try {
        await rename(tombstone, this.#dir);
      } catch (error) {
        throw new Error(
          `dist lock reclamation raced for ${this.#dir}; refusing to grant a second lease`,
          { cause: error },
        );
      }
      return;
    }
    await rm(tombstone, { recursive: true, force: true });
  }

  async #readOwner(dir: string): Promise<LockOwner | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, 'owner.json'), 'utf8'),
      ) as Partial<LockOwner>;
      if (typeof parsed.token === 'string' && typeof parsed.pid === 'number') {
        return { token: parsed.token, pid: parsed.pid };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async #isOlderThan(path: string, ms: number): Promise<boolean> {
    try {
      const info = await stat(path);
      return Date.now() - info.mtimeMs > ms;
    } catch {
      return false;
    }
  }
}

const defaultLockDir = join(
  tmpdir(),
  `ohmydate-api-dist-${createHash('sha256').update(defaultApiRoot).digest('hex').slice(0, 16)}.lock`,
);

let defaultLease: DistLock | undefined;
let leaseDepth = 0;

/**
 * Lease the shared dist artifact for the lifetime of a test file. Reentrant
 * within a process so a file may nest acquisitions.
 */
export async function acquireDistLease(): Promise<DistLock> {
  if (leaseDepth === 0) {
    const lock = new DistLock(defaultLockDir, randomUUID());
    await lock.acquire();
    defaultLease = lock;
  }
  leaseDepth += 1;
  if (defaultLease === undefined) throw new Error('dist lease invariant violated');
  return defaultLease;
}

export async function releaseDistLease(): Promise<boolean> {
  if (leaseDepth === 0) return false;
  leaseDepth -= 1;
  if (leaseDepth > 0) return true;
  const lock = defaultLease;
  defaultLease = undefined;
  return lock === undefined ? false : lock.release();
}
