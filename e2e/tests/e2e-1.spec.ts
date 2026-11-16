import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import {
  STILL_CANVAS,
  canvasTodo,
  expectVikunjaDone,
  expectVikunjaTitle,
  externalIdOf,
  fetchVikunjaTask,
  login,
  openInbox,
  openTodoDetail,
  putDownTodo,
  waitForPlannerTask,
} from '../helpers/app';
import { readState } from '../helpers/state';

const state = readState();

/** HOLO-05: a to-do is put down with the capture bar and floats up on the canvas. */
async function quickAdd(page: Page, title: string): Promise<void> {
  await putDownTodo(page, title);
  await expect(canvasTodo(page, title)).toBeVisible();
}

/** HOLO-05: the title is edited in the to-do's floating detail. */
async function editTask(page: Page, currentTitle: string, nextTitle: string): Promise<void> {
  const card = await openTodoDetail(page, currentTitle);
  await card.getByLabel('작업 제목').fill(nextTitle);
  await card.getByRole('button', { name: '저장' }).click();
  await expect(canvasTodo(page, nextTitle)).toBeVisible();
  await card.getByRole('button', { name: '닫기' }).click();
  await expect(card).toBeHidden();
}

test.describe('E2E-1 — web -> API -> Vikunja vertical slice', () => {
  test.describe.configure({ mode: 'serial' });

  test('creates, edits, resolves a 412 conflict and completes a task', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const createdTitle = `E2E slice ${suffix}`;
    const firstEdit = `${createdTitle} first edit`;
    const secondEdit = `${createdTitle} second context edit`;
    const conflictEdit = `${createdTitle} overwritten`;

    const contextA = await browser.newContext(STILL_CANVAS);
    const pageA = await contextA.newPage();
    await login(pageA, state);
    await openInbox(pageA);

    await quickAdd(pageA, createdTitle);
    const created = await waitForPlannerTask(pageA, state, createdTitle);
    const externalId = externalIdOf(created);
    const vikunjaTask = await fetchVikunjaTask(state, externalId);
    expect(vikunjaTask.title).toBe(createdTitle);
    expect(String(vikunjaTask.project_id)).toBe(state.inboxExternalId);

    await editTask(pageA, createdTitle, firstEdit);
    await expectVikunjaTitle(state, externalId, firstEdit);

    const contextB = await browser.newContext(STILL_CANVAS);
    const pageB = await contextB.newPage();
    await login(pageB, state);
    await openInbox(pageB);
    await editTask(pageB, firstEdit, secondEdit);
    await expectVikunjaTitle(state, externalId, secondEdit);

    // Context A still shows the first edit: its rename now meets a newer version.
    const cardA = await openTodoDetail(pageA, firstEdit);
    await cardA.getByLabel('작업 제목').fill(conflictEdit);
    const conflictResponsePromise = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/api/v1/tasks/${created.id}`),
    );
    await cardA.getByRole('button', { name: '저장' }).click();
    const conflictResponse = await conflictResponsePromise;
    expect(conflictResponse.status()).toBe(412);
    expect(conflictResponse.headers()['content-type']).toContain('application/problem+json');

    // The conflict dialog (the to-do's own detail is a dialog too, so it is found by its class).
    const dialog = pageA.locator('.conflict-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('다른 곳에서 이 작업이 바뀌었어요');
    await expect(dialog).toContainText(secondEdit);

    await dialog.getByRole('button', { name: '내 수정으로 덮어쓰기' }).click();
    await expect(dialog).toBeHidden();
    await expect(canvasTodo(pageA, conflictEdit)).toBeVisible();
    await expectVikunjaTitle(state, externalId, conflictEdit);

    // 완료, from the detail: the to-do is finished and leaves the surface…
    const finishing = await openTodoDetail(pageA, conflictEdit);
    await finishing.getByRole('button', { name: `${conflictEdit} 완료로 표시` }).click();
    await expect(canvasTodo(pageA, conflictEdit)).toHaveCount(0);
    await expectVikunjaDone(state, externalId);
    // …and the list view still has it, as a finished row.
    await pageA.locator('[data-tasks-view-link="list"]').click();
    await expect(
      pageA.locator('.task-item', { hasText: conflictEdit }).getByText('완료', { exact: true }),
    ).toBeVisible();

    await contextA.close();
    await contextB.close();
  });

  test('login and 담기 work keyboard-only: Tab and Enter sign in, n opens the capture bar, Enter adds and hands off', async ({ browser }) => {
    const title = `Keyboard task ${Date.now().toString(36)}`;
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${state.webUrl}/login`);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('이메일')).toBeFocused();
    await page.keyboard.type(state.email);

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('비밀번호')).toBeFocused();
    await page.keyboard.type(state.password);

    await page.keyboard.press('Enter');
    // HOLO-04: the app opens on 개요, and a new owner is met by the start guide.
    await expect(page.locator('[data-overview]')).toBeVisible();
    const shell = page.locator('.app-shell[data-first-run-state]');
    await expect(shell).not.toHaveAttribute('data-first-run-state', 'pending');
    if ((await shell.getAttribute('data-first-run-state')) === 'open') {
      // The guide holds the keyboard (a modal dialog) and Escape puts it away.
      await expect(page.locator('[data-first-run]')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-first-run]')).toBeHidden();
    }

    // One key from anywhere: the capture bar takes the focus.
    await page.keyboard.press('n');
    const input = page.locator('.app-topbar [data-capture-input]');
    await expect(input).toBeFocused();
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    const done = page.locator('.app-topbar [data-capture-done]');
    await expect(done).toBeVisible();
    await expect(done).toContainText(title);

    const task = await waitForPlannerTask(page, state, title);
    expect((await fetchVikunjaTask(state, externalIdOf(task))).title).toBe(title);

    // The hand-off is the next Enter on the empty line: 계획에 넣기, with this task picked.
    await expect(input).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/plan/schedule\\?taskIds=${task.id}`));

    await context.close();
  });

  test('offline banner appears and disables mutations', async ({ browser }) => {
    const context = await browser.newContext(STILL_CANVAS);
    const page = await context.newPage();
    await login(page, state);
    await openInbox(page);

    const title = `Offline task ${Date.now().toString(36)}`;
    await quickAdd(page, title);
    await waitForPlannerTask(page, state, title);

    let mutationRequests = 0;
    page.on('request', (request) => {
      const method = request.method();
      if (
        method !== 'GET' &&
        method !== 'HEAD' &&
        method !== 'OPTIONS' &&
        request.url().includes('/api/v1/')
      ) {
        mutationRequests += 1;
      }
    });

    await context.setOffline(true);
    await expect(page.getByText(/오프라인이에요\. 저장해 둔 데이터를 보여 드리고 있어요/)).toBeVisible();
    // The canvas reads only: no folder is made, and the to-do's detail changes nothing.
    await expect(page.locator('[data-tasks-place] .offline-note')).toHaveText('오프라인 · 읽기 전용');
    await expect(page.getByRole('button', { name: '폴더 만들기' })).toBeDisabled();
    const card = await openTodoDetail(page, title);
    await expect(card.getByLabel('작업 제목')).toBeDisabled();
    await expect(card.getByRole('button', { name: `${title} 완료로 표시` })).toBeDisabled();
    await expect(card.getByRole('button', { name: `${title} 삭제` })).toBeDisabled();
    await expect(card).toContainText('오프라인이라 지금은 고칠 수 없어요.');
    await page.waitForTimeout(300);
    expect(mutationRequests).toBe(0);

    await context.setOffline(false);
    await expect(page.getByText(/오프라인이에요\. 저장해 둔 데이터를 보여 드리고 있어요/)).toBeHidden();

    await context.close();
  });

  test('login, 개요 and the 할 일 canvas have no critical or serious axe violations', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${state.webUrl}/login`);
    await expect(page.getByRole('heading', { name: 'OhMyDate에 로그인' })).toBeVisible();
    const loginResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const loginBlocking = loginResults.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      loginBlocking.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);

    await login(page, state);
    // HOLO-04: the app opens on 개요 — checked too, before the 할 일 canvas.
    const overviewResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      overviewResults.violations
        .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          targets: violation.nodes.map((node) => node.target),
        })),
    ).toEqual([]);

    await openInbox(page);
    const inboxResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const inboxBlocking = inboxResults.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      inboxBlocking.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);

    await context.close();
  });
});
