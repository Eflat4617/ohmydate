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

async function tabUntil(page: Page, predicate: () => Promise<boolean>, attempts = 80): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('keyboard focus target was not reached');
}

async function activeId(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.id ?? '');
}

const STEPS = '#step-title-s1';
const QUESTIONS = 'form[data-plan-questions]';

/** HOLO-03A: the questions are one form; left blank, each is skipped. */
async function skipAllQuestions(page: Page): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    await expect(page.locator(`${STEPS}, ${QUESTIONS}, [data-plan-type]`).first()).toBeVisible();
    if (await page.locator(STEPS).isVisible()) return;
    if (await page.locator('[data-plan-type]').isVisible()) {
      await page.locator('[data-plan-type-no]').click();
      continue;
    }
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/answers'),
    );
    await page.locator('[data-plan-answer]').click();
    expect((await answered).ok()).toBe(true);
    await page.waitForTimeout(120);
  }
  throw new Error('the questions did not reach the steps');
}

/** Confirming the steps leads straight into 일정안: the rail shows 단계 done and 일정안 current. */
async function expectScheduleStage(page: Page): Promise<void> {
  await page.waitForURL(/\/plan\/schedule(\/|\?|$)/, { timeout: 30_000 });
  const rail = page.locator('[data-plan-rail]');
  await expect(rail.locator('[data-stage="steps"]')).toHaveAttribute('data-state', 'done');
  await expect(rail.locator('[data-stage="schedule"]')).toHaveAttribute('data-state', 'current');
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

test.describe('E2E-2 — 계획 세우기 (목표 → 질문 → 단계) against the real API', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('creates an assignment, never asks a provided due date, edits and confirms the steps', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `E2E wizard ${suffix}`;
    const editedStep = `요구사항 정리 ${suffix}`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);

    // The old address still works: it leads to the one flow.
    await page.goto(`${state.webUrl}/plan/new`);
    await page.waitForURL(/\/plan$/);
    await expect(page.getByRole('heading', { name: '계획 세우기', level: 1 })).toBeVisible();
    await expect(page.locator('[data-plan-rail] [data-stage="goal"]')).toHaveAttribute('data-state', 'current');

    await page.locator('#plan-goal-title').fill(title);
    await page.locator('#plan-goal-due').fill('2026-11-30T18:00');
    await page.locator('#plan-goal-description').fill('E2E-2 assignment description sent as description.');
    await page.locator('[data-plan-start]').click();

    await expect(page.locator(`${QUESTIONS}, ${STEPS}`).first()).toBeVisible();
    await page.waitForURL(/\/plan\/[0-9a-f-]{36}$/);
    const bodyText = await page.locator('body').innerText();
    // Questions render in Korean by field; the provided due date is never asked.
    expect(bodyText).not.toContain('언제까지 끝내야 하나요?');
    expect(bodyText).not.toContain('When is it due?');
    expect(bodyText).toContain('무엇을 결과물로 만들어야 하나요?');

    await skipAllQuestions(page);
    await expect(page.locator(STEPS)).toBeVisible();
    await expect(page.locator('[data-plan-rail] [data-stage="steps"]')).toHaveAttribute('data-state', 'current');

    await page.locator(STEPS).fill(editedStep);
    await page.locator('[data-plan-approve-steps]').click();
    await expectScheduleStage(page);

    await page.goto(`${state.webUrl}/tasks`);
    await expect(page.getByText(editedStep, { exact: true })).toBeVisible();

    const plannerTask = await waitForPlannerTask(page, state, editedStep);
    const vikunjaTask = await fetchVikunjaTask(state, externalIdOf(plannerTask));
    expect(vikunjaTask.title).toBe(editedStep);
    expect(String(vikunjaTask.project_id)).toBe(state.inboxExternalId);

    const remaining = await fetchPlannerTasks(page, state);
    expect(remaining.some((task) => task.title === editedStep)).toBe(true);

    await context.close();
  });

  test('goes from the goal to confirmed steps with the keyboard only', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);

    await page.goto(`${state.webUrl}/plan`);
    await expect(page.locator('#plan-goal-title')).toBeVisible();

    await tabUntil(page, async () => (await activeId(page)) === 'plan-goal-title');
    await page.keyboard.type(`Keyboard plan ${suffix}`);

    await tabUntil(page, async () => (await activeId(page)) === 'plan-goal-description');
    await page.keyboard.type('Keyboard-only description');
    await tabUntil(page, async () =>
      page.evaluate(() => document.activeElement?.hasAttribute('data-plan-start') ?? false),
    );
    await page.keyboard.press('Enter');

    await expect(page.locator(`${QUESTIONS}, ${STEPS}, [data-plan-type]`).first()).toBeVisible();

    for (let guard = 0; guard < 12; guard += 1) {
      await expect(page.locator(`${QUESTIONS}, ${STEPS}, [data-plan-type]`).first()).toBeVisible();
      if (await page.locator(STEPS).isVisible()) break;
      // The next enabled control that moves the flow on: "new kind" or the questions' own button.
      await tabUntil(page, async () =>
        page.evaluate(() => {
          const element = document.activeElement;
          return (
            element instanceof HTMLButtonElement &&
            !element.disabled &&
            (element.hasAttribute('data-plan-answer') || element.hasAttribute('data-plan-type-no'))
          );
        }),
      );
      const isAnswer = await page.evaluate(() => document.activeElement?.hasAttribute('data-plan-answer') ?? false);
      if (isAnswer) {
        const answered = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname.endsWith('/answers'),
        );
        await page.keyboard.press('Enter');
        expect((await answered).ok()).toBe(true);
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(100);
    }
    await expect(page.locator(STEPS)).toBeVisible();

    await tabUntil(page, async () => (await activeId(page)) === 'step-title-s1');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(`Keyboard edited ${suffix}`);
    await tabUntil(page, async () =>
      page.evaluate(() => document.activeElement?.hasAttribute('data-plan-approve-steps') ?? false),
    );
    await page.keyboard.press('Enter');

    await expectScheduleStage(page);

    await context.close();
  });

  test('계획 세우기 has no critical or serious axe violations at the goal, the questions and the steps', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state);
    await page.goto(`${state.webUrl}/plan`);
    await expect(page.locator('#plan-goal-title')).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);

    await page.locator('#plan-goal-title').fill(`Axe plan ${Date.now().toString(36)}`);
    await page.locator('[data-plan-start]').click();
    await expect(page.locator(`${QUESTIONS}, ${STEPS}, [data-plan-type]`).first()).toBeVisible();
    if (await page.locator(QUESTIONS).isVisible()) expect(await blockingAxeViolations(page)).toEqual([]);

    await skipAllQuestions(page);
    await expect(page.locator(STEPS)).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);

    await context.close();
  });
});
