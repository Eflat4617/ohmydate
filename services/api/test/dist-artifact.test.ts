import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  type ApiDistArtifact,
  apiBuildWorkspaceEnv,
  apiDistArtifact,
  assertApiDistArtifact,
  createApiBuildWorkspace,
  defaultApiRoot,
  defaultRepoRoot,
  pnpmRunShimPath,
  removeApiBuildWorkspace,
  runApiDistBuild,
  sweepDeadApiBuildWorkspaces,
  writeApiDistBuildId,
} from './support/dist-artifact.js';
import { fakeSharedDistMain, makeFakeRepo } from './support/fake-repo.js';

vi.setConfig({ testTimeout: 15_000 });

async function makeDistArtifact(): Promise<ApiDistArtifact> {
  const root = await mkdtemp(join(tmpdir(), 'ohmydate-dist-artifact-'));
  const artifact = apiDistArtifact(root);
  await mkdir(join(artifact.distDir, 'db'), { recursive: true });
  await writeFile(artifact.mainPath, '// main\n', 'utf8');
  await writeFile(artifact.migratePath, '// migrate\n', 'utf8');
  return artifact;
}

describe('api dist artifact', () => {
  test('accepts the build id stamped by this invocation', async () => {
    const artifact = await makeDistArtifact();
    try {
      const buildId = randomUUID();
      writeApiDistBuildId(artifact, buildId);
      expect(() => assertApiDistArtifact(artifact, buildId)).not.toThrow();
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });

  test('rejects a missing artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-dist-missing-'));
    try {
      const artifact = apiDistArtifact(root);
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(
        /artifact is missing/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a corrupt or missing build id', async () => {
    const artifact = await makeDistArtifact();
    try {
      await writeFile(artifact.buildIdPath, 'not a build id\n', 'utf8');
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(/corrupt/u);

      await rm(artifact.buildIdPath, { force: true });
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(
        /build id is missing/u,
      );
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });

  test('rejects a build id from another invocation', async () => {
    const artifact = await makeDistArtifact();
    try {
      writeApiDistBuildId(artifact, randomUUID());
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(/mismatch/u);
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });

  test('requires an explicit build workspace root', () => {
    expect(() => apiDistArtifact('')).toThrow(/requires the build workspace api root/u);
  });
});

describe('api build workspace', () => {
  test('mirrors build inputs read-only and keeps every written path private', async () => {
    const repo = await makeFakeRepo();
    try {
      const workspace = await createApiBuildWorkspace({
        repoRoot: repo.repoRoot,
        baseDir: repo.baseDir,
      });

      // Owner pid is part of the atomically created name: never ownerless.
      expect(workspace.ownerPid).toBe(process.pid);
      expect(basename(workspace.root)).toMatch(
        new RegExp(`^ws-${String(process.pid)}-.+$`, 'u'),
      );
      expect(workspace.apiRoot).toBe(join(workspace.root, 'services', 'api'));

      // Inputs are links into the checkout.
      for (const input of [
        join(workspace.root, 'tsconfig.base.json'),
        join(workspace.root, 'packages'),
        join(workspace.root, 'node_modules', 'root-dep'),
        join(workspace.root, 'node_modules', '.bin'),
        join(workspace.apiRoot, 'package.json'),
        join(workspace.apiRoot, 'src'),
        join(workspace.apiRoot, 'node_modules', 'api-dep'),
      ]) {
        expect((await lstat(input)).isSymbolicLink(), input).toBe(true);
      }

      // Written or relatively resolved paths are real and private.
      for (const dir of [
        workspace.root,
        workspace.apiRoot,
        join(workspace.root, 'node_modules'),
        join(workspace.apiRoot, 'node_modules'),
      ]) {
        const info = await lstat(dir);
        expect(info.isDirectory() && !info.isSymbolicLink(), dir).toBe(true);
      }
      for (const file of [
        join(workspace.apiRoot, 'test', 'support', 'fixture-app.mjs'),
        join(workspace.root, 'scripts', 'ci', 'build-smoke.mjs'),
        join(workspace.root, '.bin', 'pnpm'),
      ]) {
        const info = await lstat(file);
        expect(info.isFile() && !info.isSymbolicLink(), file).toBe(true);
      }

      // No artifact yet, no package-manager state, nothing beyond build inputs.
      for (const absent of [
        join(workspace.apiRoot, 'dist'),
        join(workspace.root, 'package.json'),
        join(workspace.root, 'pnpm-workspace.yaml'),
        join(workspace.root, 'pnpm-lock.yaml'),
        join(workspace.root, 'node_modules', '.modules.yaml'),
        join(workspace.root, 'docs'),
        join(workspace.apiRoot, 'test', 'example.test.ts'),
        join(workspace.apiRoot, 'test', 'support', 'helper.ts'),
      ]) {
        expect(existsSync(absent), absent).toBe(false);
      }

      await removeApiBuildWorkspace(workspace);
      expect(existsSync(workspace.root)).toBe(false);
      expect(await readdir(repo.baseDir)).toEqual([]);
      // Removing a workspace follows no link back into the checkout.
      expect(existsSync(join(repo.apiRoot, 'src', 'marker.txt'))).toBe(true);
      expect(existsSync(join(repo.repoRoot, 'node_modules', 'root-dep', 'index.js'))).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });

  test('builds through the run shim into the workspace, never the checkout dist', async () => {
    const repo = await makeFakeRepo();
    try {
      const workspace = await createApiBuildWorkspace({
        repoRoot: repo.repoRoot,
        baseDir: repo.baseDir,
      });
      runApiDistBuild(workspace);

      const artifact = apiDistArtifact(workspace.apiRoot);
      expect(await readFile(artifact.mainPath, 'utf8')).toBe('// source-v1\n');
      expect(existsSync(artifact.migratePath)).toBe(true);
      // Both ways a tool can reach pnpm lead to the shim.
      expect(await readFile(join(artifact.distDir, 'npm-execpath.txt'), 'utf8')).toBe(
        pnpmRunShimPath,
      );
      expect((await readFile(join(artifact.distDir, 'pnpm-path.txt'), 'utf8')).trim()).toBe(
        join(workspace.root, '.bin', 'pnpm'),
      );
      expect(await readFile(join(repo.apiRoot, 'dist', 'main.js'), 'utf8')).toBe(
        fakeSharedDistMain,
      );
      expect(existsSync(join(repo.apiRoot, 'dist', 'db'))).toBe(false);
    } finally {
      await repo.cleanup();
    }
  });

  test('refuses to build in the checkout itself', () => {
    expect(() =>
      runApiDistBuild({ root: defaultRepoRoot, apiRoot: defaultApiRoot, ownerPid: process.pid }),
    ).toThrow(/refusing to build the shared/u);
  });

  test('reports a failing build script', async () => {
    const repo = await makeFakeRepo();
    try {
      await rm(join(repo.apiRoot, 'src', 'marker.txt'));
      const workspace = await createApiBuildWorkspace({
        repoRoot: repo.repoRoot,
        baseDir: repo.baseDir,
      });
      expect(() => runApiDistBuild(workspace)).toThrow(/build failed/u);
    } finally {
      await repo.cleanup();
    }
  });

  test('rejects an invalid owner and leaves nothing behind when mirroring fails', async () => {
    const repo = await makeFakeRepo();
    try {
      await expect(
        createApiBuildWorkspace({ repoRoot: repo.repoRoot, baseDir: repo.baseDir, pid: 0 }),
      ).rejects.toThrow(/owner pid/u);
      expect(existsSync(repo.baseDir)).toBe(false);

      await rm(join(repo.repoRoot, 'scripts'), { recursive: true });
      await expect(
        createApiBuildWorkspace({ repoRoot: repo.repoRoot, baseDir: repo.baseDir }),
      ).rejects.toThrow(/ENOENT/u);
      expect(await readdir(repo.baseDir)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('sweep removes only workspaces whose owner process is gone', async () => {
    const repo = await makeFakeRepo();
    const deadPid = 424242;
    const livePid = 424243;
    const isAlive = (pid: number): boolean => pid !== deadPid;
    try {
      expect(await sweepDeadApiBuildWorkspaces({ baseDir: repo.baseDir, isAlive })).toEqual([]);

      const options = { repoRoot: repo.repoRoot, baseDir: repo.baseDir };
      const dead = await createApiBuildWorkspace({ ...options, pid: deadPid });
      const live = await createApiBuildWorkspace({ ...options, pid: livePid });
      runApiDistBuild(live);
      const unrelated = join(repo.baseDir, 'not-a-workspace');
      await mkdir(unrelated);

      expect(await sweepDeadApiBuildWorkspaces({ baseDir: repo.baseDir, isAlive })).toEqual([
        dead.root,
      ]);
      expect(existsSync(dead.root)).toBe(false);
      expect(existsSync(apiDistArtifact(live.apiRoot).mainPath)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);
      // The swept workspace's links were removed, not their targets.
      expect(existsSync(join(repo.apiRoot, 'src', 'marker.txt'))).toBe(true);

      expect(await sweepDeadApiBuildWorkspaces({ baseDir: repo.baseDir, isAlive })).toEqual([]);
      expect(existsSync(live.root)).toBe(true);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('pnpm run shim', () => {
  function shim(args: readonly string[], cwd: string) {
    return spawnSync(process.execPath, [pnpmRunShimPath, ...args], { cwd, encoding: 'utf8' });
  }

  test('runs nothing but "run <script>"', async () => {
    const repo = await makeFakeRepo();
    try {
      for (const args of [['install'], ['run'], ['run', 'build:api', '--extra'], []]) {
        const result = shim(args, repo.apiRoot);
        expect(result.status, args.join(' ')).toBe(64);
        expect(result.stderr).toContain('only "pnpm run <script>" is supported');
      }
      const missing = shim(['run', 'no-such-script'], repo.apiRoot);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('missing script: no-such-script');
      const noManifest = shim(['run', 'build'], repo.baseDir.replace(/workspaces$/u, ''));
      expect(noManifest.status).toBe(1);
      expect(noManifest.stderr).toContain('cannot read');
      // None of the rejected commands built anything.
      expect(await readFile(join(repo.apiRoot, 'dist', 'main.js'), 'utf8')).toBe(
        fakeSharedDistMain,
      );
    } finally {
      await repo.cleanup();
    }
  });

  test('workspace environment routes PATH and npm_execpath to the shim', async () => {
    const repo = await makeFakeRepo();
    try {
      const workspace = await createApiBuildWorkspace({
        repoRoot: repo.repoRoot,
        baseDir: repo.baseDir,
      });
      const bin = join(workspace.root, '.bin');
      const env = apiBuildWorkspaceEnv(workspace, {
        PATH: '/usr/bin',
        npm_execpath: '/real/pnpm.cjs',
      });
      expect(env['PATH']).toBe(`${bin}:/usr/bin`);
      expect(env['npm_execpath']).toBe(pnpmRunShimPath);
      expect(apiBuildWorkspaceEnv(workspace, {})['PATH']).toBe(bin);
    } finally {
      await repo.cleanup();
    }
  });
});
