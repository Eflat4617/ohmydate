import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import {
  externalIdOf,
  fetchPlannerTasks,
  fetchVikunjaTask,
  login,
  waitForPlannerTask,
} from '../helpers/app';
import { readState } from '../helpers/state';

const state = readState();

async function tabUntil(page: Page, predicate: () => Promise<boolean>, attempts = 40): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('keyboard focus target was not reached');
}

async function activeId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

async function skipAllQuestions(page: Page): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    if (await page.getByRole('heading', { name: /4단계 · 단계 초안/ }).isVisible()) return;
    const cards = page.locator('.question-card');
    const count = await cards.count();
    if (count === 0) return;
    await cards.first().getByRole('button', { name: '건너뛰기' }).click();
    await page.waitForTimeout(120);
  }
  throw new Error('the interview did not reach the draft step');
}

async function blockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
}

test.describe('E2E-2 — planning wizard against the real API', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('creates an assignment, never asks a provided due date, edits and approves the draft', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `E2E wizard ${suffix}`;
    const editedStep = `요구사항 정리 ${suffix}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);

    await page.goto(`${state.webUrl}/plan/new`);
    await expect(page.getByRole('heading', { name: '1단계 · 기본정보' })).toBeVisible();

    await page.locator('#wizard-title').fill(title);
    await page.locator('#wizard-due').fill('2026-11-30T18:00');
    await page.locator('#wizard-description').fill('E2E-2 assignment description sent as description.');
    await page.getByRole('button', { name: '다음' }).click();

    await expect(
      page.getByRole('heading', { name: /3단계 · 질문|4단계 · 단계 초안/ }),
    ).toBeVisible();
    const bodyText = await page.locator('body').innerText();
    // Questions render in Korean by field; the provided due date is never asked.
    expect(bodyText).not.toContain('언제까지 끝내야 하나요?');
    expect(bodyText).not.toContain('When is it due?');
    expect(bodyText).toContain('무엇을 결과물로 만들어야 하나요?');

    await skipAllQuestions(page);
    await expect(page.getByRole('heading', { name: '4단계 · 단계 초안' })).toBeVisible();

    await page.locator('#step-title-s1').fill(editedStep);
    await page.getByRole('button', { name: '초안 승인' }).click();
    await expect(page.getByRole('heading', { name: '초안 승인 완료' })).toBeVisible();

    await page.goto(`${state.webUrl}/inbox`);
    await expect(page.getByText(editedStep, { exact: true })).toBeVisible();

    const plannerTask = await waitForPlannerTask(page, state, editedStep);
    const vikunjaTask = await fetchVikunjaTask(state, externalIdOf(plannerTask));
    expect(vikunjaTask.title).toBe(editedStep);
    expect(String(vikunjaTask.project_id)).toBe(state.inboxExternalId);

    const remaining = await fetchPlannerTasks(page, state);
    expect(remaining.some((task) => task.title === editedStep)).toBe(true);

    await context.close();
  });

  test('completes the wizard with the keyboard from step 1 through approval', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);

    await page.goto(`${state.webUrl}/plan/new`);
    await expect(page.getByRole('heading', { name: '1단계 · 기본정보' })).toBeVisible();

    await tabUntil(page, async () => (await activeId(page)) === 'wizard-title');
    await page.keyboard.type(`Keyboard wizard ${suffix}`);

    await tabUntil(page, async () => (await activeId(page)) === 'wizard-description');
    await page.keyboard.type('Keyboard-only description');
    await tabUntil(
      page,
      async () =>
        page.evaluate(() => document.activeElement?.textContent?.includes('다음') ?? false),
    );
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', { name: /3단계 · 질문|4단계 · 단계 초안/ }),
    ).toBeVisible();

    for (let guard = 0; guard < 12; guard += 1) {
      if (await page.getByRole('heading', { name: '4단계 · 단계 초안' }).isVisible()) break;
      await tabUntil(
        page,
        async () =>
          page.evaluate(() => {
            const element = document.activeElement;
            return (
              element instanceof HTMLButtonElement &&
              !element.disabled &&
              (element.textContent?.includes('건너뛰기') ?? false)
            );
          }),
      );
      const answered = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith('/answers'),
      );
      await page.keyboard.press('Enter');
      expect((await answered).ok()).toBe(true);
      await page.waitForTimeout(100);
    }
    await expect(page.getByRole('heading', { name: '4단계 · 단계 초안' })).toBeVisible();

    await tabUntil(page, async () => (await activeId(page)) === 'step-title-s1');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(`Keyboard edited ${suffix}`);
    await tabUntil(
      page,
      async () =>
        page.evaluate(() => document.activeElement?.textContent?.includes('초안 승인') ?? false),
    );
    await page.keyboard.press('Enter');

    await expect(page.getByRole('heading', { name: '초안 승인 완료' })).toBeVisible();

    await context.close();
  });

  test('wizard page has no critical or serious axe violations', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);
    await page.goto(`${state.webUrl}/plan/new`);
    await expect(page.getByRole('heading', { name: '1단계 · 기본정보' })).toBeVisible();

    expect(await blockingAxeViolations(page)).toEqual([]);

    await context.close();
  });
});
