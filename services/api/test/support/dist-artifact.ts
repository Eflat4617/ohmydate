import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Private services/api build artifact (FU-58F).
 *
 * Root cause of the FU-57R2 / FU-61-58R-1 finding chain: every Vitest
 * invocation rebuilt and consumed the single `services/api/dist` directory, so
 * correctness depended on a cross-process lock with stale-owner takeover. No
 * verify-then-rename takeover is atomic, and even a perfect lock could not stop
 * another invocation from rebuilding the artifact between two consumers.
 *
 * The design removes the shared mutable state instead. Each invocation creates
 * its own build workspace: a private directory tree that mirrors the inputs of
 * the real `pnpm run build` through symlinks and receives its own `dist`.
 * globalSetup builds there (always, never cached), stamps a random build id,
 * and provides the workspace path and id to the workers; teardown removes it.
 * Nothing in a Vitest invocation reads or writes `services/api/dist`, so two
 * invocations have no artifact in common and nothing needs to be locked.
 *
 * Workspace names embed the owning pid in the same atomic mkdtemp that creates
 * them, so a workspace is never observable without its owner. The sweep only
 * removes workspaces whose owner process is gone; it never takes anything over.
 */

export const API_DIST_BUILD_ID_KEY = 'ohmydateApiDistBuildId' as const;
export const API_DIST_ROOT_KEY = 'ohmydateApiDistRoot' as const;

declare module 'vitest' {
  export interface ProvidedContext {
    readonly ohmydateApiDistBuildId: string;
    /** `services/api` directory of this invocation's private build workspace. */
    readonly ohmydateApiDistRoot: string;
  }
}

/** The checked-out services/api. Vitest never builds into or runs from its dist. */
export const defaultApiRoot = fileURLToPath(new URL('../..', import.meta.url));
export const defaultRepoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
export const pnpmRunShimPath = fileURLToPath(
  new URL('./pnpm-run-shim.mjs', import.meta.url),
);

export interface ApiDistArtifact {
  readonly apiRoot: string;
  readonly distDir: string;
  readonly mainPath: string;
  readonly migratePath: string;
  readonly buildIdPath: string;
}

export function apiDistArtifact(apiRoot: string): ApiDistArtifact {
  if (typeof apiRoot !== 'string' || apiRoot.trim() === '') {
    throw new Error('api dist artifact requires the build workspace api root');
  }
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

export interface ApiBuildWorkspace {
  /** Private mirror of the repository root. */
  readonly root: string;
  /** Private mirror of services/api; the build writes `dist` here. */
  readonly apiRoot: string;
  readonly ownerPid: number;
}

export interface ApiBuildWorkspaceOptions {
  readonly repoRoot?: string;
  readonly baseDir?: string;
  readonly pid?: number;
}

export interface ApiBuildWorkspaceSweepOptions {
  readonly baseDir?: string;
  readonly isAlive?: (pid: number) => boolean;
}

/** Per-checkout parent of all build workspaces, so worktrees never share one. */
export const defaultWorkspaceBaseDir = join(
  tmpdir(),
  `ohmydate-api-build-${createHash('sha256').update(defaultApiRoot).digest('hex').slice(0, 16)}`,
);

const workspaceNamePattern = /^ws-(\d+)-/u;
// Package-manager state is deliberately not mirrored: the workspace must never
// look like an installable project whose node_modules links back to the checkout.
const repoRootSkip = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);
const apiRootSkip = new Set(['dist', 'node_modules', 'test']);

async function linkEntries(
  from: string,
  to: string,
  include: (name: string, isDirectory: boolean) => boolean,
): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (include(entry.name, entry.isDirectory())) {
      await symlink(join(from, entry.name), join(to, entry.name));
    }
  }
}

/** node_modules is mirrored entry by entry so the directory itself stays private. */
function isMirroredModuleEntry(name: string): boolean {
  return name === '.bin' || !name.startsWith('.');
}

/**
 * Create a private build workspace owned by `pid`.
 *
 * Inputs (sources, configs, dependencies) are symlinks to the checkout and are
 * only ever read. Everything the build or a consumer writes or resolves by
 * relative path (`dist`, the spawned `.mjs` fixtures, the build-smoke script) is
 * a real file inside the workspace.
 */
export async function createApiBuildWorkspace(
  options: ApiBuildWorkspaceOptions = {},
): Promise<ApiBuildWorkspace> {
  const repoRoot = resolve(options.repoRoot ?? defaultRepoRoot);
  const baseDir = options.baseDir ?? defaultWorkspaceBaseDir;
  const ownerPid = options.pid ?? process.pid;
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
    throw new Error('api build workspace owner pid must be a positive integer');
  }
  const realApiRoot = join(repoRoot, 'services', 'api');

  await mkdir(baseDir, { recursive: true });
  const root = await mkdtemp(join(baseDir, `ws-${String(ownerPid)}-`));
  const apiRoot = join(root, 'services', 'api');
  try {
    // Repository root: shared config files and the workspace package sources.
    await linkEntries(repoRoot, root, (name, isDirectory) =>
      isDirectory ? name === 'packages' : !repoRootSkip.has(name),
    );
    await linkEntries(
      join(repoRoot, 'node_modules'),
      join(root, 'node_modules'),
      isMirroredModuleEntry,
    );
    await linkEntries(realApiRoot, apiRoot, (name) => !apiRootSkip.has(name));
    await linkEntries(
      join(realApiRoot, 'node_modules'),
      join(apiRoot, 'node_modules'),
      isMirroredModuleEntry,
    );

    const realSupport = join(realApiRoot, 'test', 'support');
    const support = join(apiRoot, 'test', 'support');
    await mkdir(support, { recursive: true });
    for (const name of await readdir(realSupport)) {
      if (name.endsWith('.mjs')) await copyFile(join(realSupport, name), join(support, name));
    }

    await mkdir(join(root, 'scripts', 'ci'), { recursive: true });
    await copyFile(
      join(repoRoot, 'scripts', 'ci', 'build-smoke.mjs'),
      join(root, 'scripts', 'ci', 'build-smoke.mjs'),
    );

    // `pnpm` inside the workspace is the run-only shim, never the real CLI.
    const bin = join(root, '.bin');
    await mkdir(bin);
    const shim = join(bin, 'pnpm');
    await writeFile(
      shim,
      `#!/bin/sh\nexec '${process.execPath}' '${pnpmRunShimPath}' "$@"\n`,
      'utf8',
    );
    await chmod(shim, 0o755);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { root, apiRoot, ownerPid };
}

export async function removeApiBuildWorkspace(workspace: ApiBuildWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

/**
 * Remove workspaces left behind by invocations that died before teardown.
 * A workspace whose owner is alive is never touched, so this cannot affect a
 * concurrent invocation. Returns the removed directories.
 */
export async function sweepDeadApiBuildWorkspaces(
  options: ApiBuildWorkspaceSweepOptions = {},
): Promise<string[]> {
  const baseDir = options.baseDir ?? defaultWorkspaceBaseDir;
  const isAlive = options.isAlive ?? defaultIsAlive;
  let names: string[];
  try {
    names = await readdir(baseDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
  const removed: string[] = [];
  for (const name of names) {
    const match = workspaceNamePattern.exec(name);
    if (match === null) continue;
    if (isAlive(Number(match[1]))) continue;
    const dir = join(baseDir, name);
    await rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}

/**
 * Environment for tools run inside a build workspace. Every `pnpm` they reach,
 * through PATH or through `npm_execpath`, is the run-only shim: the real CLI
 * may reinstall dependencies before a script and must never see the workspace.
 */
export function apiBuildWorkspaceEnv(
  workspace: ApiBuildWorkspace,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const bin = join(workspace.root, '.bin');
  const path = base['PATH'];
  return {
    ...base,
    PATH: path === undefined || path === '' ? bin : `${bin}${delimiter}${path}`,
    npm_execpath: pnpmRunShimPath,
    OHMYDATE_API_BUILD_SHIM_BIN: bin,
  };
}

/**
 * Run the unmodified `build` script of services/api inside a build workspace.
 * Refuses the checkout itself: its `dist` is shared with other invocations and
 * with scripts/ci/build-smoke.mjs.
 */
export function runApiDistBuild(workspace: ApiBuildWorkspace): void {
  if (resolve(workspace.apiRoot) === resolve(defaultApiRoot)) {
    throw new Error(
      `refusing to build the shared ${join(defaultApiRoot, 'dist')}; build inside a private workspace`,
    );
  }
  const build = spawnSync(process.execPath, [pnpmRunShimPath, 'run', 'build'], {
    cwd: workspace.apiRoot,
    env: apiBuildWorkspaceEnv(workspace),
    encoding: 'utf8',
  });
  if (build.error !== undefined) throw build.error;
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
