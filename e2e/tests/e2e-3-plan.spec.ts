import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../helpers/app';
import {
  apiFetch,
  createApprovedGoal,
  createOverlappingCommitment,
  expectOk,
  setWeeklyAvailability,
  type PlanDto,
} from '../helpers/planner';
import { readState } from '../helpers/state';

const state = readState();

function planIdFromUrl(url: string): string {
  const match = /\/plans\/([0-9a-f-]{36})/.exec(url);
  if (match?.[1] === undefined) throw new Error(`plan id missing from URL: ${url}`);
  return match[1];
}

async function loadPlan(page: Page, planId: string): Promise<PlanDto> {
  const response = await apiFetch(page, state, `/plans/${planId}`);
  return (await expectOk(response, 'GET /plans/{id}')) as PlanDto;
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

test.describe('E2E-3 — plan comparison and stale-availability approval', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test('compares candidates, previews an edit, approves, detects 412 and regenerates', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await login(pageA, state);

    await setWeeklyAvailability(pageA, state);
    const goal = await createApprovedGoal(pageA, state, `E2E plan goal ${suffix}`, {
      estimatedScope: 'large',
      independentDraft: true,
    });
    if (goal.goalId === undefined) throw new Error('approved goal id is missing');

    await pageA.goto(`${state.webUrl}/plans/new?goalId=${goal.goalId}`);
    await pageA.getByRole('button', { name: 'Generate candidates' }).click();
    await pageA.waitForURL(/\/plans\/[0-9a-f-]{36}$/);
    const planId = planIdFromUrl(pageA.url());

    await expect(pageA.locator('.candidate-card')).toHaveCount(3);
    await expect(pageA.getByRole('heading', { name: /^Plan comparison$/ })).toBeVisible();

    expect(await blockingAxeViolations(pageA)).toEqual([]);

    const generated = await loadPlan(pageA, planId);
    const firstCandidate = generated.candidates[0];
    const firstBlock = firstCandidate?.blocks[0];
    if (firstBlock === undefined) throw new Error('generated plan has no blocks to edit');

    const block = pageA.locator('.calendar-block').first();
    await expect(block).toBeVisible();
    await block.focus();
    for (let index = 0; index < 200; index += 1) {
      await block.press('ArrowDown');
    }
    await expect(pageA.locator('.violation-list li').first()).toBeVisible({ timeout: 15_000 });
    await pageA.getByRole('button', { name: 'Reset edits' }).click();

    const firstApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.getByRole('button', { name: 'Approve this plan' }).click();
    expect((await firstApproval).status()).toBe(201);
    await expect(pageA.getByRole('heading', { name: 'Plan approved' })).toBeVisible();

    const contextB = await browser.newContext({
      storageState: await contextA.storageState(),
    });
    const pageB = await contextB.newPage();
    const commitmentStart = firstBlock.startAt;
    const commitmentEnd = new Date(Date.parse(commitmentStart) + 30 * 60 * 1000).toISOString();
    await createOverlappingCommitment(
      pageB,
      state,
      commitmentStart,
      commitmentEnd,
      `E2E overlap ${suffix}`,
    );
    await contextB.close();

    const staleApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.getByRole('button', { name: 'Approve this plan' }).click();
    expect((await staleApproval).status()).toBe(412);
    const conflictPanel = pageA
      .getByRole('alert')
      .filter({ hasText: 'Availability changed elsewhere' });
    await expect(conflictPanel).toBeVisible();

    const regenerate = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':regenerate'),
    );
    await conflictPanel.getByRole('button', { name: 'Regenerate plan' }).click();
    expect((await regenerate).status()).toBe(201);
    await expect(pageA.getByText('Plan regenerated against the latest availability.')).toBeVisible();
    await expect(pageA.getByRole('heading', { name: 'Plan approved' })).toBeHidden();

    const secondApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.getByRole('button', { name: 'Approve this plan' }).click();
    expect((await secondApproval).status()).toBe(201);
    await expect(pageA.getByRole('heading', { name: 'Plan approved' })).toBeVisible();

    await contextA.close();
  });
});
