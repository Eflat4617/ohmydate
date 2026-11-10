import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  expectVikunjaDone,
  expectVikunjaTitle,
  externalIdOf,
  fetchVikunjaTask,
  login,
  waitForPlannerTask,
} from '../helpers/app';
import { readState } from '../helpers/state';

const state = readState();

async function quickAdd(page: Page, title: string): Promise<void> {
  await page.getByLabel('Quick add task').fill(title);
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

async function editTask(page: Page, currentTitle: string, nextTitle: string): Promise<void> {
  await page.getByRole('button', { name: `Edit title of ${currentTitle}` }).click();
  await page.getByLabel('Task title').fill(nextTitle);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(nextTitle, { exact: true })).toBeVisible();
}

test.describe('E2E-1 — web -> API -> Vikunja vertical slice', () => {
  test.describe.configure({ mode: 'serial' });

  test('creates, edits, resolves a 412 conflict and completes a task', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const createdTitle = `E2E slice ${suffix}`;
    const firstEdit = `${createdTitle} first edit`;
    const secondEdit = `${createdTitle} second context edit`;
    const conflictEdit = `${createdTitle} overwritten`;

    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await login(pageA, state);

    await quickAdd(pageA, createdTitle);
    const created = await waitForPlannerTask(pageA, state, createdTitle);
    const externalId = externalIdOf(created);
    expect((await fetchVikunjaTask(state, externalId)).title).toBe(createdTitle);

    await editTask(pageA, createdTitle, firstEdit);
    await expectVikunjaTitle(state, externalId, firstEdit);

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await login(pageB, state);
    await editTask(pageB, firstEdit, secondEdit);
    await expectVikunjaTitle(state, externalId, secondEdit);

    await pageA.getByRole('button', { name: `Edit title of ${firstEdit}` }).click();
    await pageA.getByLabel('Task title').fill(conflictEdit);
    await pageA.getByRole('button', { name: 'Save' }).click();

    const dialog = pageA.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('This task changed elsewhere');
    await expect(dialog).toContainText(secondEdit);

    await dialog.getByRole('button', { name: 'Overwrite with my edit' }).click();
    await expect(dialog).toBeHidden();
    await expect(pageA.getByText(conflictEdit, { exact: true })).toBeVisible();
    await expectVikunjaTitle(state, externalId, conflictEdit);

    await pageA.getByRole('button', { name: `Mark ${conflictEdit} complete` }).click();
    await expect(
      pageA.locator('.task-item', { hasText: conflictEdit }).getByText('Done'),
    ).toBeVisible();
    await expectVikunjaDone(state, externalId);

    await contextA.close();
    await contextB.close();
  });

  test('login and quick add work keyboard-only with Tab and Enter', async ({ browser }) => {
    const title = `Keyboard task ${Date.now().toString(36)}`;
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${state.webUrl}/login`);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Email')).toBeFocused();
    await page.keyboard.type(state.email);

    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Password')).toBeFocused();
    await page.keyboard.type(state.password);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Inbox' })).toBeVisible();

    let focusedId = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.keyboard.press('Tab');
      focusedId = await page.evaluate(() => document.activeElement?.id ?? '');
      if (focusedId === 'quick-add-title') break;
    }
    expect(focusedId).toBe('quick-add-title');

    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await expect(page.getByText(title, { exact: true })).toBeVisible();

    const task = await waitForPlannerTask(page, state, title);
    expect((await fetchVikunjaTask(state, externalIdOf(task))).title).toBe(title);

    await context.close();
  });

  test('offline banner appears and disables mutations', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);

    await context.setOffline(true);
    await expect(page.getByText(/You are offline\. Viewing cached data/)).toBeVisible();
    await expect(page.getByLabel('Quick add task')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Add task' })).toBeDisabled();

    await context.setOffline(false);
    await expect(page.getByText(/You are offline\. Viewing cached data/)).toBeHidden();

    await context.close();
  });

  test('login and inbox have no critical or serious axe violations', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${state.webUrl}/login`);
    await expect(page.getByRole('heading', { name: 'Sign in to OhMyDate' })).toBeVisible();
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
