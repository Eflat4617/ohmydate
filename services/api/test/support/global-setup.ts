import { randomUUID } from 'node:crypto';
import type { TestProject } from 'vitest/node';
import {
  API_DIST_BUILD_ID_KEY,
  API_DIST_ROOT_KEY,
  apiDistArtifact,
  createApiBuildWorkspace,
  removeApiBuildWorkspace,
  runApiDistBuild,
  sweepDeadApiBuildWorkspaces,
  writeApiDistBuildId,
  type ApiBuildWorkspace,
  type ApiDistArtifact,
} from './dist-artifact.js';

export interface ProvidedApiDist {
  readonly buildId: string;
  /** `services/api` directory of the private build workspace. */
  readonly apiRoot: string;
}

export interface ApiDistBuildSetupDeps {
  readonly sweepWorkspaces?: () => Promise<unknown>;
  readonly createWorkspace?: () => Promise<ApiBuildWorkspace>;
  readonly removeWorkspace?: (workspace: ApiBuildWorkspace) => Promise<void>;
  readonly build?: (workspace: ApiBuildWorkspace) => void;
  readonly stampBuildId?: (artifact: ApiDistArtifact, buildId: string) => void;
  readonly createBuildId?: () => string;
  readonly provide?: (project: TestProject, provided: ProvidedApiDist) => void;
}

/**
 * Build the services/api artifact exactly once per Vitest invocation, inside a
 * build workspace that only this invocation knows, then publish its location
 * and a random build id to every worker through the provided context.
 * Consumers assert that their artifact carries this id before spawning it.
 *
 * The build always runs: there is no previous artifact to reuse, because each
 * invocation starts from a new, empty workspace (FU-57R2: caching by build id
 * or mtime would let stale code be tested). The workspace is removed by the
 * returned teardown, or immediately when setup fails. Dependencies are
 * injectable only so the regression tests can drive this without compilers.
 */
export async function setupApiDistBuild(
  project: TestProject,
  deps: ApiDistBuildSetupDeps = {},
): Promise<() => Promise<void>> {
  const sweepWorkspaces = deps.sweepWorkspaces ?? (() => sweepDeadApiBuildWorkspaces());
  const createWorkspace = deps.createWorkspace ?? (() => createApiBuildWorkspace());
  const removeWorkspace = deps.removeWorkspace ?? removeApiBuildWorkspace;
  const build = deps.build ?? runApiDistBuild;
  const stampBuildId = deps.stampBuildId ?? writeApiDistBuildId;
  const createBuildId = deps.createBuildId ?? randomUUID;
  const provide =
    deps.provide ??
    ((target: TestProject, provided: ProvidedApiDist) => {
      target.provide(API_DIST_BUILD_ID_KEY, provided.buildId);
      target.provide(API_DIST_ROOT_KEY, provided.apiRoot);
    });

  await sweepWorkspaces();
  const workspace = await createWorkspace();
  try {
    build(workspace);
    const buildId = createBuildId();
    stampBuildId(apiDistArtifact(workspace.apiRoot), buildId);
    provide(project, { buildId, apiRoot: workspace.apiRoot });
  } catch (error) {
    await removeWorkspace(workspace);
    throw error;
  }

  let removed = false;
  return async () => {
    if (removed) return;
    removed = true;
    await removeWorkspace(workspace);
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  return setupApiDistBuild(project);
}
