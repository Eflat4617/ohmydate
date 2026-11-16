import { expect, type Page } from '@playwright/test';
import { driver } from './driver';
import type { E2EState } from './state';
import type { PlannerTask } from './vikunja';

// Vikunja is the default target's system of record. A spec that also runs on
// the `core` target asks `record` (helpers/driver.ts) instead of these.
export {
  expectVikunjaDone,
  expectVikunjaTitle,
  externalIdOf,
  fetchVikunjaTask,
  type PlannerTask,
  type VikunjaTaskBody,
} from './vikunja';
export { driver, expectStoredTask, type StoredFolder, type StoredTask } from './driver';

/** The system of record behind the planner API on this run's target. */
export const record = driver.record;

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

/**
 * HOLO-05: a context for a test that points at the 할 일 canvas. Its to-dos
 * sway a few pixels, and a pointer action waits for its target to hold still —
 * so these tests ask for reduced motion, under which every to-do is exactly
 * where it was left. (The keyboard needs no such thing: Enter on a to-do opens it.)
 */
export const STILL_CANVAS = { reducedMotion: 'reduce' } as const;

/** 할 일, from wherever the page is: the canvas (HOLO-05), with the inbox as its open water. */
export async function openInbox(page: Page): Promise<void> {
  await openPlace(page, '할 일');
  await expect(page.locator('[data-tasks-place]')).toHaveAttribute('data-tasks-view', 'canvas');
  await expect(page.locator('[data-todo-canvas]')).toBeVisible();
}

/** A to-do on the canvas, by its title. */
export function canvasTodo(page: Page, title: string) {
  return page.locator('[data-todo]').filter({ has: page.getByText(title, { exact: true }) });
}

/** The one floating detail, opened on a to-do (a click, or the same to-do again if it is already open). */
export async function openTodoDetail(page: Page, title: string) {
  const card = page.locator('[data-todo-card]');
  const todo = canvasTodo(page, title);
  await expect(todo).toBeVisible();
  if ((await todo.getAttribute('data-open')) !== 'true') await todo.click();
  await expect(card).toBeVisible();
  await expect(card.getByLabel('작업 제목')).toHaveValue(title);
  return card;
}

/**
 * 담기 (the top bar's field): a line with no day or time in it is put down at
 * once as a to-do, and floats up on the canvas.
 */
export async function putDownTodo(page: Page, title: string): Promise<void> {
  const input = page.locator('.app-topbar [data-capture-input]');
  await input.click();
  await input.fill(title);
  await input.press('Enter');
  await expect(page.locator('.app-topbar [data-capture-done]')).toContainText(title);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-capture-panel]')).toHaveCount(0);
}

/**
 * Signs in. HOLO-04: the app opens on 개요; the start guide, if it opens, is put away.
 *
 * How a page gets in is the target's (helpers/driver.ts): the login form on
 * the default target, the boot hand-off on `core` — where there is one owner,
 * so `account` picks nobody.
 */
export async function login(
  page: Page,
  state: E2EState,
  account: { readonly email: string; readonly password: string } = state,
): Promise<void> {
  await driver.signIn(page, account);
  // The app opens on 개요 — unless a focus session is already running, in
  // which case the adaptive layout takes the owner straight to the timer
  // (sometimes before 개요 has painted). Either one is "signed in and open".
  await expect(
    page.locator('[data-overview], .adaptive-frame[data-layout-mode="focus"]').first(),
  ).toBeVisible();
  await settleStartGuide(page);
}

export async function fetchPlannerTasks(
  page: Page,
  state: E2EState,
): Promise<readonly PlannerTask[]> {
  void state;
  const response = await driver.request(page, '/tasks');
  expect(response.ok(), `GET /api/v1/tasks -> ${response.status()}`).toBeTruthy();
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
