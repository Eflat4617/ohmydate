import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { agentRunStatuses } from '../helpers/db';
import { login } from '../helpers/app';
import { readState } from '../helpers/state';

/**
 * FU-76 E2E-AI — 계획 세우기 waiting for a slow AI (the API's fake
 * provider answers the AI-wait owner after `aiWaitLatencyMs`, ~5 s): calm
 * progress with elapsed time, 취소 lands on the manual path (server run
 * cancelled), and a reload mid-call resumes by polling — the run completes
 * once and the draft appears without re-submitting.
 */

const state = readState();
const account = { email: state.aiWaitEmail, password: state.aiWaitPassword };
const DECOMPOSITION_TITLE = 'AI가 단계를 만들고 있어요 · 보통 30초–1분';

async function blockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }));
}

const QUESTIONS = 'form[data-plan-questions]';
const STEPS = '#step-title-s1';

async function startPlan(page: Page, title: string): Promise<Locator> {
  await page.goto(`${state.webUrl}/plan`);
  await expect(page.locator('#plan-goal-title')).toBeVisible();
  await page.locator('#plan-goal-title').fill(title);
  await page.locator('#plan-goal-due').fill('2026-12-20T18:00');
  await page.locator('[data-plan-start]').click();

  // Type detection waits for the slow AI with a calm progress state.
  const panel = page.getByTestId('ai-wait');
  await expect(panel).toContainText('AI가 비슷한 작업을 찾고 있어요');
  await expect(panel.getByRole('timer')).toContainText('지났어요');
  // The wait belongs to 질문: the rail already says so.
  await expect(page.locator('[data-plan-rail] [data-stage="questions"]')).toHaveAttribute('data-state', 'current');
  await expect(page.locator(`${QUESTIONS}, [data-plan-type]`).first()).toBeVisible({
    timeout: state.aiWaitLatencyMs + 15_000,
  });
  return panel;
}

/** Answer 모름 to every question until the request that starts the decomposition is waiting. */
async function answerUntilDecompositionWait(page: Page, panel: Locator): Promise<void> {
  for (let guard = 0; guard < 15; guard += 1) {
    if (await panel.isVisible()) return;
    if (await page.locator(STEPS).isVisible()) {
      throw new Error('reached the steps without waiting for the AI');
    }
    if (await page.locator('[data-plan-type]').isVisible()) {
      await page.locator('[data-plan-type-no]').click();
    } else if (await page.locator(QUESTIONS).isVisible()) {
      const send = page.locator('[data-plan-answer]');
      if (await send.isEnabled()) {
        const unknown = page.locator(`${QUESTIONS} input[data-idk]`);
        for (let index = 0; index < (await unknown.count()); index += 1) {
          const box = unknown.nth(index);
          if ((await box.isEnabled()) && !(await box.isChecked())) await box.check();
        }
        await send.click();
      }
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error('the decomposition wait never started');
}

test.describe('E2E-AI — long AI calls in 계획 세우기 (FU-76)', () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });

  test('shows progress with elapsed time and 취소 lands on the manual path; the server run is cancelled', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'decomposition');

    const title = `AI 대기 취소 ${Date.now().toString(36)}`;
    const panel = await startPlan(page, title);
    await answerUntilDecompositionWait(page, panel);

    await expect(panel).toContainText(DECOMPOSITION_TITLE);
    await expect(panel.getByRole('timer')).toContainText('지났어요');
    await expect(panel).toContainText('새로 고쳐도 AI 작업은 계속돼요');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('ai-wait-heading');
    expect(await blockingAxeViolations(page)).toEqual([]);

    await panel.getByRole('button', { name: '취소' }).click();
    await expect(page.locator(STEPS)).toBeVisible();
    await expect(page.locator('[data-plan-rail] [data-stage="steps"]')).toHaveAttribute('data-state', 'current');
    await expect(page.getByTestId('ai-cancelled')).toContainText('AI 작업을 취소했어요');
    await expect(panel).toBeHidden();
    // Manual draft, inputs kept (the work step is the user's own title).
    await expect(page.locator('#step-title-s1')).toHaveValue('Prepare the workspace and inputs');
    await expect(page.locator('#step-title-s2')).toHaveValue(title);

    await expect
      .poll(async () => (await agentRunStatuses(state, state.aiWaitOwnerId, 'decomposition')).slice(before.length))
      .toEqual(['cancelled']);
    await context.close();
  });

  test('a reload during the decomposition resumes by polling; the run completes once and the draft appears', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'decomposition');

    const panel = await startPlan(page, `AI 대기 새로고침 ${Date.now().toString(36)}`);
    await answerUntilDecompositionWait(page, panel);
    await expect(panel).toContainText(DECOMPOSITION_TITLE);

    let answerPosts = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && /\/intake-sessions\/[^/]+\/answers$/.test(new URL(request.url()).pathname)) {
        answerPosts += 1;
      }
    });
    await page.reload();

    // Resumed from the session state, not re-submitted.
    await expect(panel).toContainText(DECOMPOSITION_TITLE);
    await expect(page.locator('#step-title-s1')).toHaveValue('자료 모으기', {
      timeout: state.aiWaitLatencyMs + 20_000,
    });
    await expect(panel).toBeHidden();
    await expect(page.locator('#step-title-s2')).toHaveValue('초안 작성하기');
    expect(answerPosts).toBe(0);

    await expect
      .poll(async () => (await agentRunStatuses(state, state.aiWaitOwnerId, 'decomposition')).slice(before.length))
      .toEqual(['succeeded']);
    await context.close();
  });
});
