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
} from './dist-artifact.js';

/**
 * Build services/api/dist exactly once per Vitest invocation, then publish a
 * random build id to every worker through the provided context. Consumers
 * assert their dist carries this id before spawning it.
 */
export default async function setup(project: TestProject): Promise<void> {
  const artifact = apiDistArtifact();
  await acquireDistLease();
  try {
    await rm(artifact.distDir, { recursive: true, force: true });
    runApiDistBuild(artifact.apiRoot);
    const buildId = randomUUID();
    writeApiDistBuildId(artifact, buildId);
    project.provide(API_DIST_BUILD_ID_KEY, buildId);
  } finally {
    await releaseDistLease();
  }
}
