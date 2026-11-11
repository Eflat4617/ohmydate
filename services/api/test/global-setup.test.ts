import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  apiDistArtifact,
  assertApiDistArtifact,
  createApiBuildWorkspace,
  type ApiBuildWorkspace,
  type ApiDistArtifact,
} from './support/dist-artifact.js';
import { fakeSharedDistMain, makeFakeRepo, type FakeRepo } from './support/fake-repo.js';
import {
  setupApiDistBuild,
  type ApiDistBuildSetupDeps,
  type ProvidedApiDist,
} from './support/global-setup.js';

const project = {} as TestProject;

async function seedStampedArtifact(
  artifact: ApiDistArtifact,
  buildId: string,
): Promise<void> {
  await mkdir(join(artifact.distDir, 'db'), { recursive: true });
  await writeFile(artifact.mainPath, '// stale main\n', 'utf8');
  await writeFile(artifact.migratePath, '// stale migrate\n', 'utf8');
  await writeFile(artifact.buildIdPath, `${buildId}\n`, 'utf8');
}

describe('api dist global setup', () => {
  test('builds on every invocation, each in a new workspace, even when a stamped artifact already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-global-setup-'));
    const events: string[] = [];
    const workspaces: ApiBuildWorkspace[] = [];
    let invocation = 0;
    let workspaceCount = 0;
    const deps: ApiDistBuildSetupDeps = {
      sweepWorkspaces: async () => {
        events.push('sweep');
      },
      createWorkspace: async () => {
        workspaceCount += 1;
        const workspaceRoot = join(root, `ws-${String(workspaceCount)}`);
        const workspace: ApiBuildWorkspace = {
          root: workspaceRoot,
          apiRoot: join(workspaceRoot, 'services', 'api'),
          ownerPid: process.pid,
        };
        await mkdir(workspace.apiRoot, { recursive: true });
        workspaces.push(workspace);
        events.push(`create:${workspace.apiRoot}`);
        return workspace;
      },
      removeWorkspace: async (workspace) => {
        events.push(`remove:${workspace.apiRoot}`);
      },
      build: (workspace) => {
        events.push(`build:${workspace.apiRoot}`);
      },
      createBuildId: () => `build-${++invocation}`,
      stampBuildId: (artifact, buildId) => {
        events.push(`stamp:${artifact.distDir}:${buildId}`);
      },
      provide: (_target, provided) => {
        events.push(`provide:${provided.buildId}:${provided.apiRoot}`);
      },
    };

    try {
      const firstTeardown = await setupApiDistBuild(project, deps);
      const first = workspaces[0];
      if (first === undefined) throw new Error('first workspace was not created');
      // A complete, stamped artifact from the previous invocation is on disk
      // and looks fresh; the next invocation must still build, elsewhere.
      await seedStampedArtifact(apiDistArtifact(first.apiRoot), 'build-1');
      const secondTeardown = await setupApiDistBuild(project, deps);
      const second = workspaces[1];
      if (second === undefined) throw new Error('second workspace was not created');

      expect(second.apiRoot).not.toBe(first.apiRoot);
      expect(events).toEqual([
        'sweep',
        `create:${first.apiRoot}`,
        `build:${first.apiRoot}`,
        `stamp:${join(first.apiRoot, 'dist')}:build-1`,
        `provide:build-1:${first.apiRoot}`,
        'sweep',
        `create:${second.apiRoot}`,
        `build:${second.apiRoot}`,
        `stamp:${join(second.apiRoot, 'dist')}:build-2`,
        `provide:build-2:${second.apiRoot}`,
      ]);

      // Teardown removes exactly the invocation's own workspace, once.
      events.length = 0;
      await secondTeardown();
      await secondTeardown();
      expect(events).toEqual([`remove:${second.apiRoot}`]);
      await firstTeardown();
      expect(events).toEqual([`remove:${second.apiRoot}`, `remove:${first.apiRoot}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('removes the workspace and provides nothing when the build fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-global-setup-fail-'));
    const events: string[] = [];
    const workspace: ApiBuildWorkspace = {
      root,
      apiRoot: join(root, 'services', 'api'),
      ownerPid: process.pid,
    };
    const deps: ApiDistBuildSetupDeps = {
      sweepWorkspaces: async () => {
        events.push('sweep');
      },
      createWorkspace: async () => {
        events.push('create');
        return workspace;
      },
      removeWorkspace: async (removed) => {
        events.push(`remove:${removed.root}`);
      },
      build: () => {
        events.push('build');
        throw new Error('compile failed');
      },
      stampBuildId: () => {
        events.push('stamp');
      },
      provide: () => {
        events.push('provide');
      },
    };

    try {
      await expect(setupApiDistBuild(project, deps)).rejects.toThrow(/compile failed/u);
      expect(events).toEqual(['sweep', 'create', 'build', `remove:${root}`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('removes the workspace when the built artifact cannot be stamped', async () => {
    const repo = await makeFakeRepo();
    const provided: ProvidedApiDist[] = [];
    try {
      await expect(
        setupApiDistBuild(project, {
          sweepWorkspaces: async () => undefined,
          createWorkspace: () =>
            createApiBuildWorkspace({ repoRoot: repo.repoRoot, baseDir: repo.baseDir }),
          // A "build" that produces no artifact: the real stamp must refuse it.
          build: () => undefined,
          provide: (_target, value) => {
            provided.push(value);
          },
        }),
      ).rejects.toThrow(/compiled artifact is missing/u);
      expect(provided).toEqual([]);
      expect(await readdir(repo.baseDir)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });
});

/**
 * FU-58F regression for the FU-57R2 / FU-61-58R-1 finding chain.
 *
 * The reviewer's three-contender schedule needed one lock path that a stale
 * reclaimer could move while a third contender published onto it. Here the
 * same three contenders run against the real workspace, build and stamp code
 * (only the repository is a fixture): there is no path any two of them share,
 * so no interleaving can hand one invocation another's artifact.
 */
describe('concurrent vitest invocations', () => {
  interface Invocation {
    readonly provided: ProvidedApiDist;
    readonly artifact: ApiDistArtifact;
    readonly teardown: () => Promise<void>;
  }

  async function invoke(repo: FakeRepo): Promise<Invocation> {
    let provided: ProvidedApiDist | undefined;
    const teardown = await setupApiDistBuild(project, {
      sweepWorkspaces: async () => undefined,
      createWorkspace: () =>
        createApiBuildWorkspace({ repoRoot: repo.repoRoot, baseDir: repo.baseDir }),
      provide: (_target, value) => {
        provided = value;
      },
    });
    if (provided === undefined) throw new Error('setup provided nothing');
    return { provided, artifact: apiDistArtifact(provided.apiRoot), teardown };
  }

  test('two concurrent setups get distinct artifacts and neither can see the other', async () => {
    const repo = await makeFakeRepo();
    try {
      const [a, b] = await Promise.all([invoke(repo), invoke(repo)]);

      expect(a.provided.apiRoot).not.toBe(b.provided.apiRoot);
      expect(a.provided.buildId).not.toBe(b.provided.buildId);
      expect(a.artifact.distDir).not.toBe(b.artifact.distDir);
      expect(a.provided.apiRoot.startsWith(repo.baseDir)).toBe(true);
      expect(b.provided.apiRoot.startsWith(repo.baseDir)).toBe(true);

      // Each consumer accepts only its own invocation's artifact.
      expect(() => assertApiDistArtifact(a.artifact, a.provided.buildId)).not.toThrow();
      expect(() => assertApiDistArtifact(b.artifact, b.provided.buildId)).not.toThrow();
      expect(() => assertApiDistArtifact(a.artifact, b.provided.buildId)).toThrow(/mismatch/u);
      expect(() => assertApiDistArtifact(b.artifact, a.provided.buildId)).toThrow(/mismatch/u);

      await a.teardown();
      await b.teardown();
      expect(await readdir(repo.baseDir)).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('three contenders: teardown and a later rebuild never touch an artifact in use', async () => {
    const repo = await makeFakeRepo();
    try {
      // A and B overlap, as two test runs started together do.
      const [a, b] = await Promise.all([invoke(repo), invoke(repo)]);
      const bMain = await readFile(b.artifact.mainPath, 'utf8');
      expect(bMain).toBe('// source-v1\n');

      // A finishes and cleans up while B is still consuming its artifact.
      await a.teardown();
      expect(existsSync(a.artifact.distDir)).toBe(false);
      expect(() => assertApiDistArtifact(b.artifact, b.provided.buildId)).not.toThrow();

      // C starts in the gap A left, from newer sources. Under the old shared
      // dist this is the contender that took over the artifact B was using.
      await repo.setSource('source-v2');
      const c = await invoke(repo);
      expect(c.provided.apiRoot).not.toBe(a.provided.apiRoot);
      expect(c.provided.apiRoot).not.toBe(b.provided.apiRoot);
      expect(c.provided.buildId).not.toBe(b.provided.buildId);
      expect(await readFile(c.artifact.mainPath, 'utf8')).toBe('// source-v2\n');

      // B still holds exactly what it built: same id, same bytes.
      expect(() => assertApiDistArtifact(b.artifact, b.provided.buildId)).not.toThrow();
      expect(await readFile(b.artifact.mainPath, 'utf8')).toBe(bMain);
      expect(() => assertApiDistArtifact(b.artifact, c.provided.buildId)).toThrow(/mismatch/u);
      expect(() => assertApiDistArtifact(c.artifact, b.provided.buildId)).toThrow(/mismatch/u);

      // B's teardown leaves C intact; C's leaves nothing.
      await b.teardown();
      expect(() => assertApiDistArtifact(c.artifact, c.provided.buildId)).not.toThrow();
      await c.teardown();
      expect(await readdir(repo.baseDir)).toEqual([]);

      // The checkout's own dist was never built into, stamped, or removed.
      expect(await readFile(join(repo.apiRoot, 'dist', 'main.js'), 'utf8')).toBe(
        fakeSharedDistMain,
      );
      expect(await readdir(join(repo.apiRoot, 'dist'))).toEqual(['main.js']);
    } finally {
      await repo.cleanup();
    }
  });

  test('a setup that fails next to a healthy one removes only its own workspace', async () => {
    const repo = await makeFakeRepo();
    try {
      const healthy = await invoke(repo);
      await expect(
        setupApiDistBuild(project, {
          sweepWorkspaces: async () => undefined,
          createWorkspace: () =>
            createApiBuildWorkspace({ repoRoot: repo.repoRoot, baseDir: repo.baseDir }),
          build: () => {
            throw new Error('compile failed');
          },
        }),
      ).rejects.toThrow(/compile failed/u);

      expect(await readdir(repo.baseDir)).toHaveLength(1);
      expect(() =>
        assertApiDistArtifact(healthy.artifact, healthy.provided.buildId),
      ).not.toThrow();
      await healthy.teardown();
    } finally {
      await repo.cleanup();
    }
  });
});
