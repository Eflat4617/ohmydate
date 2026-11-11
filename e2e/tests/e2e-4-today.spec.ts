import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../helpers/app';
import {
  apiFetch,
  approveCandidateWithBlocks,
  createApprovedGoal,
  createApprovedGoalWithSingleStep,
  createPlanFromGoal,
  editableBlocksForToday,
  expectOk,
  getWorkSession,
  idempotencyKey,
  listNotifications,
  setContinuousWeeklyAvailability,
} from '../helpers/planner';
import { readState } from '../helpers/state';

const state = readState();
const account = { email: state.todayEmail, password: state.todayPassword };

async function scheduleBlock(
  page: Page,
  blockId: string,
  from: string,
  to: string,
): Promise<{ id: string; startAt: string; endAt: string } | undefined> {
  const response = await apiFetch(
    page,
    state,
    `/schedule-blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`,
  );
  const body = (await expectOk(response, 'GET /schedule-blocks')) as {
    items: { id: string; startAt: string; endAt: string }[];
  };
  return body.items.find((block) => block.id === blockId);
}

async function allowTenMinuteSessions(page: Page, taskIds: readonly string[]): Promise<void> {
  for (const taskId of new Set(taskIds)) {
    const taskResponse = await apiFetch(page, state, `/tasks/${taskId}`);
    const task = (await expectOk(taskResponse, 'GET /tasks/{id}')) as { version: number };
    const response = await apiFetch(page, state, `/tasks/${taskId}`, {
      method: 'PATCH',
      headers: {
        'If-Match': `W/"${task.version}"`,
        'Idempotency-Key': idempotencyKey(),
      },
      body: { session: { minMinutes: 10, maxMinutes: 30 }, splittable: true },
    });
    await expectOk(response, 'PATCH /tasks/{id}');
  }
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

async function openNotifications(page: Page): Promise<void> {
  await page.locator('.nav-rail').getByRole('button', { name: '알림' }).click();
  await expect(page.getByRole('dialog', { name: '알림' })).toBeVisible();
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
    await expect(page.getByRole('heading', { name: '오늘', exact: true })).toBeVisible();
    const cards = page.locator('.today-card');
    await expect(cards).toHaveCount(3, { timeout: 20_000 });
    expect(await blockingAxeViolations(page)).toEqual([]);

    await cards.nth(1).getByRole('button', { name: '집중 시작' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
    await expect(page.locator('.focus-timer')).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);

    await page.keyboard.press('f');
    await expect(page.locator('.focus-timer')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByText('일시정지됨', { exact: true })).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.getByText('집중하는 중', { exact: true })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(
      page.getByRole('heading', { name: '이번 세션은 어땠나요?' }),
    ).toBeVisible();
    await page.getByRole('radio', { name: '일부만' }).check();
    await page.getByRole('checkbox', { name: '생각보다 컸어요' }).check();
    await page.getByLabel('메모 (선택, 나만 볼 수 있어요)').fill('E2E focus review note.');
    await page.getByRole('button', { name: '회고 저장' }).click();
    await expect(page.getByRole('heading', { name: '추정 피드백' })).toBeVisible();
    await expect(page.getByText(/예상 .* · 실제/)).toBeVisible();

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
    await row.getByRole('button', { name: /알림 지우기/ }).click();
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
    await cards.first().getByRole('button', { name: '집중 시작' }).click();
    await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
    const sessionId = page.url().split('/').at(-1);
    if (sessionId === undefined || sessionId.length === 0) {
      throw new Error('focus URL did not contain a session id');
    }
    await expect(page.getByText('집중하는 중', { exact: true })).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText(/오프라인 · 타이머는 이 기기에서 계속 돌아가요/)).toBeVisible();
    await page.getByRole('button', { name: '일시정지' }).click();
    await expect(page.getByText('일시정지됨', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '다시 시작' }).click();
    await expect(page.getByText('집중하는 중', { exact: true })).toBeVisible();
    await expect(page.getByText(/집중 기록 2개를 이 기기에 저장했어요/)).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByText(/저장해 둔 집중 기록을 모두 올렸어요/)).toBeVisible({ timeout: 20_000 });

    const replayed = await getWorkSession(page, state, sessionId);
    expect(replayed.state).toBe('active');
    expect(replayed.version).toBe(3);
    expect(replayed.focusedSec).toBeGreaterThanOrEqual(0);
    expect(replayed.pausedSec).toBeGreaterThanOrEqual(0);

    await page.getByRole('button', { name: '완료' }).click();
    await expect(
      page.getByRole('heading', { name: '이번 세션은 어땠나요?' }),
    ).toBeVisible();
    const completed = await getWorkSession(page, state, sessionId);
    expect(completed.state).toBe('completed');
    expect(completed.version).toBe(4);
    await context.close();
  });

  test('shows only the current plan cards when two approved plans have blocks today', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await login(page, state, { email: state.plansEmail, password: state.plansPassword });
    await setContinuousWeeklyAvailability(page, state);

    const firstTitle = `E2E older plan ${suffix}`;
    const secondTitle = `E2E current plan ${suffix}`;
    const firstGoal = await createApprovedGoalWithSingleStep(page, state, firstTitle);
    if (firstGoal.goalId === undefined) throw new Error('first goal id is missing');
    const firstPlan = await createPlanFromGoal(page, state, firstGoal.goalId);
    const firstEdited = editableBlocksForToday(firstPlan);
    const firstApproved = await approveCandidateWithBlocks(page, state, firstPlan, firstEdited);
    const olderBlock = firstApproved.blocks[0];
    if (olderBlock === undefined) throw new Error('older plan has no block');

    const secondGoal = await createApprovedGoalWithSingleStep(page, state, secondTitle);
    if (secondGoal.goalId === undefined) throw new Error('second goal id is missing');
    const secondPlan = await createPlanFromGoal(page, state, secondGoal.goalId);
    const olderEnd = Math.max(...firstApproved.blocks.map((block) => Date.parse(block.endAt)));
    const secondEdited = editableBlocksForToday(secondPlan, olderEnd);
    const currentApproved = await approveCandidateWithBlocks(page, state, secondPlan, secondEdited);
    if (currentApproved.blocks[0] === undefined) throw new Error('current plan has no block');

    await page.goto(`${state.webUrl}/today`);
    const cards = page.locator('.today-card');
    await expect(cards).toHaveCount(Math.min(currentApproved.blocks.length, 3), {
      timeout: 20_000,
    });
    await expect(page.locator('.today-card', { hasText: firstTitle })).toHaveCount(0);

    await allowTenMinuteSessions(
      page,
      currentApproved.blocks.map((block) => block.taskId),
    );
    const anchor = currentApproved.blocks[0];
    if (anchor === undefined) throw new Error('current plan has no anchor block');
    const rangeFrom = new Date(Date.parse(anchor.startAt) - 86_400_000).toISOString();
    const rangeTo = new Date(Date.parse(anchor.startAt) + 2 * 86_400_000).toISOString();

    for (const label of [`${secondTitle} prep`, `${secondTitle} work`, `${secondTitle} review`]) {
      const card = page.locator('.today-card', { hasText: label });
      await expect(card).toBeVisible();
      await expect(card.getByRole('button', { name: '축소' })).toBeEnabled();
      const blockId = await card.getAttribute('data-block-id');
      if (blockId === null) throw new Error(`card ${label} has no block id`);
      const beforeShrink = await scheduleBlock(page, blockId, rangeFrom, rangeTo);
      if (beforeShrink === undefined) throw new Error(`schedule block ${blockId} is missing`);

      await card.getByRole('button', { name: '축소' }).click();
      await page.locator('#shrink-minutes').fill('10');
      await page.getByRole('button', { name: '축소 미리보기' }).click();
      await expect(page.getByRole('heading', { name: '제안 미리보기' })).toBeVisible();
      let approveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.includes('/today/proposals/'),
      );
      await page.getByRole('button', { name: '제안 승인' }).click();
      expect((await approveResponse).status()).toBe(201);
      await expect(page.getByRole('heading', { name: '제안 미리보기' })).toBeHidden();

      const refreshed = page.locator('.today-card', { hasText: label });
      await expect(refreshed.getByRole('button', { name: '재배치' })).toBeEnabled({
        timeout: 20_000,
      });
      const shrunkBlockId = (await refreshed.getAttribute('data-block-id')) ?? blockId;
      const expectedEnd = new Date(Date.parse(beforeShrink.startAt) + 10 * 60_000).toISOString();
      await expect
        .poll(async () => (await scheduleBlock(page, shrunkBlockId, rangeFrom, rangeTo))?.endAt)
        .toBe(expectedEnd);

      const beforeReschedule = await scheduleBlock(page, shrunkBlockId, rangeFrom, rangeTo);
      if (beforeReschedule === undefined) {
        throw new Error(`schedule block ${shrunkBlockId} disappeared`);
      }
      await refreshed.getByRole('button', { name: '재배치' }).click();
      await expect(page.getByRole('heading', { name: '제안 미리보기' })).toBeVisible();
      approveResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.includes('/today/proposals/'),
      );
      await page.getByRole('button', { name: '제안 승인' }).click();
      expect((await approveResponse).status()).toBe(201);
      await expect(page.getByRole('heading', { name: '제안 미리보기' })).toBeHidden();

      const rescheduled = page.locator('.today-card', { hasText: label });
      await expect(rescheduled).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => await rescheduled.getAttribute('data-block-id'), {
          timeout: 20_000,
        })
        .not.toBe(shrunkBlockId);
      const rescheduledBlockId = await rescheduled.getAttribute('data-block-id');
      if (rescheduledBlockId === null) throw new Error(`card ${label} has no refreshed block id`);
      await expect
        .poll(async () => (await scheduleBlock(page, rescheduledBlockId, rangeFrom, rangeTo)) !== undefined, {
          timeout: 20_000,
        })
        .toBe(true);
      const afterReschedule = await scheduleBlock(page, rescheduledBlockId, rangeFrom, rangeTo);
      expect(afterReschedule).toBeDefined();
      expect(afterReschedule?.startAt).not.toBe(beforeReschedule.startAt);
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    await context.close();
  });
});
