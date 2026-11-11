import { expect, type Page } from '@playwright/test';
import type { E2EState } from './state';

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

export async function login(page: Page, state: E2EState): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${state.webUrl}/login`);
    await page.getByLabel('Email').fill(state.email);
    await page.getByLabel('Password').fill(state.password);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/auth/login'),
    );
    await page.getByRole('button', { name: 'Sign in' }).click();
    const response = await responsePromise;
    if (response.status() === 429) {
      // The dev API allows five logins per minute per IP+email and exposes a
      // fixed 60s window. Earlier E2E-1 scenarios use the whole budget, so wait
      // for the window to roll over instead of failing the later suites.
      await page.waitForTimeout(61_000);
      continue;
    }
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();
    return;
  }
  throw new Error('login was rate limited for three consecutive windows');
}

export async function fetchPlannerTasks(
  page: Page,
  state: E2EState,
): Promise<readonly PlannerTask[]> {
  const response = await page.request.get(`${state.apiUrl}/api/v1/tasks`);
  expect(response.ok(), `GET /api/v1/tasks -> ${response.status}`).toBeTruthy();
  const body = (await response.json()) as { items: PlannerTask[] };
  return body.items;
}

export async function waitForPlannerTask(
  page: Page,
  state: E2EState,
  title: string,
): Promise<PlannerTask> {
  let found: PlannerTask | undefined;
  await expect
    .poll(
      async () => {
        const tasks = await fetchPlannerTasks(page, state);
        found = tasks.find((task) => task.title === title);
        return found !== undefined;
      },
      { message: `planner task "${title}" should exist` },
    )
    .toBe(true);
  return found as PlannerTask;
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
