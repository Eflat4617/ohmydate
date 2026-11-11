import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { apiDistArtifact, type ApiDistArtifact } from './support/dist-artifact.js';
import { setupApiDistBuild, type ApiDistBuildSetupDeps } from './support/global-setup.js';

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
  test('rebuilds on every invocation even when a stamped artifact already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-global-setup-'));
    const artifact = apiDistArtifact(root);
    const events: string[] = [];
    let invocation = 0;
    const deps: ApiDistBuildSetupDeps = {
      artifact,
      acquireLease: async () => {
        events.push('acquire');
        return {};
      },
      releaseLease: async () => {
        events.push('release');
        return true;
      },
      removeArtifact: async (distDir) => {
        events.push('remove');
        await rm(distDir, { recursive: true, force: true });
      },
      build: (apiRoot) => {
        events.push(`build:${apiRoot}`);
      },
      createBuildId: () => `build-${++invocation}`,
      stampBuildId: () => {
        events.push('stamp');
      },
      provide: (_target, buildId) => {
        events.push(`provide:${buildId}`);
      },
    };

    try {
      await seedStampedArtifact(artifact, 'build-from-previous-invocation');
      await setupApiDistBuild(project, deps);
      await seedStampedArtifact(artifact, 'build-1');
      await setupApiDistBuild(project, deps);

      expect(events).toEqual([
        'acquire',
        'remove',
        `build:${root}`,
        'stamp',
        'provide:build-1',
        'release',
        'acquire',
        'remove',
        `build:${root}`,
        'stamp',
        'provide:build-2',
        'release',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('releases the lease when the build fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-global-setup-fail-'));
    const artifact = apiDistArtifact(root);
    const events: string[] = [];
    const deps: ApiDistBuildSetupDeps = {
      artifact,
      acquireLease: async () => {
        events.push('acquire');
        return {};
      },
      releaseLease: async () => {
        events.push('release');
        return true;
      },
      removeArtifact: async (distDir) => {
        events.push('remove');
        await rm(distDir, { recursive: true, force: true });
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
      await seedStampedArtifact(artifact, 'build-from-previous-invocation');
      await expect(setupApiDistBuild(project, deps)).rejects.toThrow(/compile failed/u);
      expect(events).toEqual(['acquire', 'remove', 'build', 'release']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
