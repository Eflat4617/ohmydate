import { expect } from '@playwright/test';
import type { E2EState } from './state';

/**
 * Vikunja, read directly: the system of record behind the planner API on the
 * default (`ts`) target. Nothing here exists on the `core` target — specs
 * reach it through `helpers/driver.ts` (`record`).
 */
export interface PlannerTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly external?: readonly { readonly provider: string; readonly externalId: string }[];
}

export interface VikunjaTaskBody {
  readonly id: number;
  readonly title: string;
  readonly done?: boolean;
  readonly project_id?: number;
}

export function externalIdOf(task: PlannerTask): string {
  const external = task.external?.find((reference) => reference.provider === 'vikunja');
  if (external === undefined) {
    throw new Error(`planner task ${task.id} has no vikunja external id`);
  }
  return external.externalId;
}

export async function fetchVikunjaTask(
  state: E2EState,
  externalId: string,
): Promise<VikunjaTaskBody> {
  const response = await fetch(`${state.vikunjaUrl}/api/v2/tasks/${externalId}`, {
    headers: { authorization: `Bearer ${state.vikunjaToken}` },
  });
  expect(response.ok, `Vikunja GET /tasks/${externalId} -> ${response.status}`).toBeTruthy();
  return (await response.json()) as VikunjaTaskBody;
}

export async function expectVikunjaTitle(
  state: E2EState,
  externalId: string,
  title: string,
): Promise<void> {
  await expect
    .poll(async () => (await fetchVikunjaTask(state, externalId)).title, {
      message: `Vikunja task ${externalId} title should become "${title}"`,
    })
    .toBe(title);
}

export async function expectVikunjaDone(
  state: E2EState,
  externalId: string,
): Promise<void> {
  await expect
    .poll(async () => (await fetchVikunjaTask(state, externalId)).done === true, {
      message: `Vikunja task ${externalId} should be done`,
    })
    .toBe(true);
}

export interface VikunjaProjectBody {
  readonly id: number;
  readonly title: string;
  readonly is_archived?: boolean;
}

/** A project as Vikunja holds it, found by its (unique) title — archived ones included. */
export async function fetchVikunjaProject(
  state: E2EState,
  title: string,
): Promise<VikunjaProjectBody | undefined> {
  const query = new URLSearchParams({ q: title, per_page: '50', is_archived: 'true' });
  const response = await fetch(`${state.vikunjaUrl}/api/v2/projects?${query.toString()}`, {
    headers: { authorization: `Bearer ${state.vikunjaToken}` },
  });
  expect(response.ok, `Vikunja GET /projects -> ${response.status}`).toBeTruthy();
  const body = (await response.json()) as { items?: VikunjaProjectBody[] } | VikunjaProjectBody[];
  const items = Array.isArray(body) ? body : (body.items ?? []);
  return items.find((project) => project.title === title);
}
