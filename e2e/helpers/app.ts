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

/**
 * HOLO-04: a brand-new owner is met by the start guide (FLOW.md §3) — it opens
 * by itself the first time an owner without hours is seen on a device, and
 * every test starts on a fresh device. These suites set hours through the API,
 * so they put the guide away the way a person would (닫기); 개요 then keeps
 * the rest as its "시작 마무리" card. Waits until the shell has decided, so a
 * guide that opens a moment after 개요 never lands on top of a later step.
 */
export async function settleStartGuide(page: Page): Promise<'closed' | 'not-shown'> {
  const shell = page.locator('.app-shell[data-first-run-state]');
  await expect(shell).not.toHaveAttribute('data-first-run-state', 'pending');
  if ((await shell.getAttribute('data-first-run-state')) !== 'open') return 'not-shown';
  await page.locator('[data-first-run-close]').click();
  await expect(page.locator('[data-first-run]')).toBeHidden();
  await expect(shell).toHaveAttribute('data-first-run-state', 'idle');
  return 'closed';
}

/** HOLO-04: go to one of the sidebar's places by its link, as a person does. */
export async function openPlace(page: Page, name: '개요' | '할 일' | '계획' | '플래너' | '집중' | '분석' | '노트' | '설정'): Promise<void> {
  // A link is named by its place alone (the key hint beside it is not part of the name).
  await page.locator('.nav-rail').getByRole('link', { name, exact: true }).click();
}

/** HOLO-04: 로그아웃 lives in the account menu of the top bar. */
export async function signOut(page: Page): Promise<void> {
  await page.locator('[data-user-menu]').click();
  await page.locator('[data-user-sign-out]').click();
}

/** 할 일 › 인박스, from wherever the page is. */
export async function openInbox(page: Page): Promise<void> {
  await openPlace(page, '할 일');
  await expect(page.getByRole('heading', { name: '인박스' })).toBeVisible();
}

/** Signs in. HOLO-04: the app opens on 개요; the start guide, if it opens, is put away. */
export async function login(
  page: Page,
  state: E2EState,
  account: { readonly email: string; readonly password: string } = state,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${state.webUrl}/login`);
    await page.getByLabel('이메일').fill(account.email);
    await page.getByLabel('비밀번호').fill(account.password);
    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/auth/login'),
    );
    await page.getByRole('button', { name: '로그인' }).click();
    const response = await responsePromise;
    if (response.status() === 429) {
      // The dev API allows five logins per minute per IP+email and exposes a
      // fixed 60s window. Earlier E2E-1 scenarios use the whole budget, so wait
      // for the window to roll over instead of failing the later suites.
      await page.waitForTimeout(61_000);
      continue;
    }
    await expect(page.locator('[data-overview]')).toBeVisible();
    await settleStartGuide(page);
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
