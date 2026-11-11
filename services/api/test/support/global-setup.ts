import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { TestProject } from 'vitest/node';
import {
  API_DIST_BUILD_ID_KEY,
  acquireDistLease,
  apiDistArtifact,
  releaseDistLease,
  runApiDistBuild,
  writeApiDistBuildId,
  type ApiDistArtifact,
} from './dist-artifact.js';

export interface ApiDistBuildSetupDeps {
  readonly artifact?: ApiDistArtifact;
  readonly acquireLease?: () => Promise<unknown>;
  readonly releaseLease?: () => Promise<boolean>;
  readonly build?: (apiRoot: string) => void;
  readonly stampBuildId?: (artifact: ApiDistArtifact, buildId: string) => void;
  readonly createBuildId?: () => string;
  readonly provide?: (project: TestProject, buildId: string) => void;
  readonly removeArtifact?: (distDir: string) => Promise<void>;
}

/**
 * Build services/api/dist exactly once per Vitest invocation, then publish a
 * random build id to every worker through the provided context. Consumers
 * assert their dist carries this id before spawning it.
 *
 * The build always runs, even when a stamped artifact from an earlier
 * invocation looks fresh: caching by build id or mtime would let stale code be
 * tested (FU-57R2). Dependencies are injectable only so the regression test can
 * prove this without spawning real compilers.
 */
export async function setupApiDistBuild(
  project: TestProject,
  deps: ApiDistBuildSetupDeps = {},
): Promise<void> {
  const artifact = deps.artifact ?? apiDistArtifact();
  const acquireLease = deps.acquireLease ?? acquireDistLease;
  const releaseLease = deps.releaseLease ?? releaseDistLease;
  const build = deps.build ?? runApiDistBuild;
  const stampBuildId = deps.stampBuildId ?? writeApiDistBuildId;
  const createBuildId = deps.createBuildId ?? randomUUID;
  const provide =
    deps.provide ??
    ((target: TestProject, buildId: string) =>
      target.provide(API_DIST_BUILD_ID_KEY, buildId));
  const removeArtifact =
    deps.removeArtifact ??
    ((distDir: string) => rm(distDir, { recursive: true, force: true }));

  await acquireLease();
  try {
    await removeArtifact(artifact.distDir);
    build(artifact.apiRoot);
    const buildId = createBuildId();
    stampBuildId(artifact, buildId);
    provide(project, buildId);
  } finally {
    await releaseLease();
  }
}

export default async function setup(project: TestProject): Promise<void> {
  await setupApiDistBuild(project);
}
