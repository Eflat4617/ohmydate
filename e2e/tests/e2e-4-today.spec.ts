import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../helpers/app';
import {
  approveCandidateWithBlocks,
  createApprovedGoal,
  createPlanFromGoal,
  editableBlocksForToday,
  getWorkSession,
  listNotifications,
  setContinuousWeeklyAvailability,
} from '../helpers/planner';
import { readState } from '../helpers/state';

const state = readState();
const account = { email: state.todayEmail, password: state.todayPassword };

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

async function openNotifications(page: Page): Promise<void> {
  await page.locator('.nav-rail').getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
}

test.describe('E2E-4 — Today focus flow, feedback and notification dedupe', () => {
  test.describe.configure({ mode: 'serial', timeout: 300_000 });

  test('starts from an approved plan, completes a session, reviews it and keeps one notification', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await login(page, state, account);

    await setContinuousWeeklyAvailability(page, state);
    const goal = await createApprovedGoal(page, state, `E2E today goal ${suffix}`, {
      estimatedScope: 'large',
      independentDraft: true,
    });
    if (goal.goalId === undefined) throw new Error('approved goal id is missing');
    const plan = await createPlanFromGoal(page, state, goal.goalId);
    const edited = editableBlocksForToday(plan);
    const approved = await approveCandidateWithBlocks(page, state, plan, edited);
    expect(approved.blocks.length).toBeGreaterThanOrEqual(2);
    const notifyBlock = approved.blocks[0];
    if (notifyBlock === undefined) throw new Error('approved plan has no block to notify');
    const sessionBlock = approved.blocks[1];
    if (sessionBlock === undefined) throw new Error('approved plan has no block to start from');

    await page.goto(`${state.webUrl}/today`);
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    const cards = page.locator('.today-card');
    await expect(cards).toHaveCount(3, { timeout: 20_000 });
    expect(await blockingAxeViolations(page)).toEqual([]);

    await cards.nth(1).getByRole('button', { name: 'Start focus' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
    await expect(page.locator('.focus-timer')).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);

    await page.keyboard.press('f');
    await expect(page.locator('.focus-timer')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByText('Focusing', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', { name: 'How did the session go?' }),
    ).toBeVisible();
    await page.getByRole('radio', { name: 'Partial' }).check();
    await page.getByRole('checkbox', { name: 'Task was larger' }).check();
    await page.getByLabel('Note (optional, private)').fill('E2E focus review note.');
    await page.getByRole('button', { name: 'Submit review' }).click();
    await expect(page.getByRole('heading', { name: 'Estimation feedback' })).toBeVisible();
    await expect(page.getByText(/Estimated .* · actual/)).toBeVisible();

    let notificationId = '';
    await expect
      .poll(
        async () => {
          const items = await listNotifications(page, state);
          const match = items.find((item) => item.dedupeKey.includes(notifyBlock.id));
          notificationId = match?.id ?? '';
          return match?.state ?? null;
        },
        { timeout: 90_000, intervals: [2_000, 3_000] },
      )
      .toBe('sent');

    await page.waitForTimeout(65_000);
    const afterSecondSweep = (await listNotifications(page, state)).filter((item) =>
      item.dedupeKey.includes(notifyBlock.id),
    );
    expect(afterSecondSweep).toHaveLength(1);
    expect(afterSecondSweep[0]?.id).toBe(notificationId);

    await page.reload();
    await openNotifications(page);
    const row = page.locator(`[data-notification-id="${notificationId}"]`);
    await expect(row).toHaveCount(1);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /Dismiss notification/ }).click();
    await expect(row).toHaveCount(0);
    await expect
      .poll(async () => {
        const items = await listNotifications(page, state);
        return items.find((item) => item.id === notificationId)?.state ?? null;
      })
      .toBe('dismissed');

    await page.reload();
    await openNotifications(page);
    await expect(page.locator(`[data-notification-id="${notificationId}"]`)).toHaveCount(0);
    await context.close();
  });

  test('replays local pause/resume events exactly once after reconnecting', async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await login(page, state, account);

    await page.goto(`${state.webUrl}/today`);
    const cards = page.locator('.today-card');
    await expect(cards).toHaveCount(3, { timeout: 20_000 });
    await cards.first().getByRole('button', { name: 'Start focus' }).click();
    await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').at(-1);
    if (sessionId === undefined || sessionId.length === 0) {
      throw new Error('focus URL did not contain a session id');
    }
    await expect(page.getByText('Focusing', { exact: true })).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText(/Offline · timer keeps running locally/)).toBeVisible();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByText('Paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.getByText('Focusing', { exact: true })).toBeVisible();
    await expect(page.getByText(/2 focus events saved on this device/)).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByText(/Saved focus events uploaded/)).toBeVisible({ timeout: 20_000 });

    const replayed = await getWorkSession(page, state, sessionId);
    expect(replayed.state).toBe('active');
    expect(replayed.version).toBe(3);
    expect(replayed.focusedSec).toBeGreaterThanOrEqual(0);
    expect(replayed.pausedSec).toBeGreaterThanOrEqual(0);

    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(
      page.getByRole('heading', { name: 'How did the session go?' }),
    ).toBeVisible();
    const completed = await getWorkSession(page, state, sessionId);
    expect(completed.state).toBe('completed');
    expect(completed.version).toBe(4);
    await context.close();
  });
});
