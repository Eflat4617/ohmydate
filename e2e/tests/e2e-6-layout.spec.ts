import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../helpers/app';
import {
  approveCandidateWithBlocks,
  createApprovedGoal,
  createPlanFromGoal,
  editableBlocksForToday,
  getWorkSession,
  setContinuousWeeklyAvailability,
} from '../helpers/planner';
import { readState } from '../helpers/state';

// E2E-6 (M6-02 part, 11 §2): Today → start a focus session → the adaptive
// layout switches to focus with an undo toast → undo restores Today while the
// session keeps running → "자동 전환 끄기" persists across a reload. Every
// mode reachable on the real stack is scanned with axe (0 critical/serious).
// Notes linking / AI evidence (the rest of E2E-6) belong to M6-03.

const state = readState();
const account = { email: state.layoutEmail, password: state.layoutPassword };
const LAYOUT_TOAST = '레이아웃이 바뀌었어요';

async function blockingAxeViolations(page: Page) {
  // Let entrance animations finish so a fading panel is not misread as low contrast.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity),
  );
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

function frame(page: Page) {
  return page.locator('.adaptive-frame');
}

async function expectMode(page: Page, mode: string): Promise<void> {
  await expect(frame(page)).toHaveAttribute('data-layout-mode', mode);
}

function layoutToast(page: Page) {
  return page.locator('.toast', { hasText: LAYOUT_TOAST });
}

function sessionIdFrom(page: Page): string {
  const id = new URL(page.url()).pathname.split('/').at(-1);
  if (id === undefined || id.length === 0) throw new Error('focus URL did not contain a session id');
  return id;
}

async function completeAndReview(page: Page): Promise<void> {
  await page.getByRole('button', { name: '완료' }).click();
  await expect(page.getByRole('heading', { name: '이번 세션은 어땠나요?' })).toBeVisible();
  await page.getByRole('radio', { name: '일부만' }).check();
  await page.getByRole('button', { name: '회고 저장' }).click();
  await expect(page.getByRole('heading', { name: '추정 피드백' })).toBeVisible();
}

test.describe('E2E-6 — adaptive layout: focus switch, undo, auto switch off', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test('Today → focus switch with undo; auto switch off survives a reload', async ({ browser }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await login(page, state, account);

    await setContinuousWeeklyAvailability(page, state);
    const goal = await createApprovedGoal(page, state, `E2E layout goal ${suffix}`, {
      estimatedScope: 'large',
      independentDraft: true,
    });
    if (goal.goalId === undefined) throw new Error('approved goal id is missing');
    const plan = await createPlanFromGoal(page, state, goal.goalId);
    const approved = await approveCandidateWithBlocks(page, state, plan, editableBlocksForToday(plan));
    expect(approved.blocks.length).toBeGreaterThanOrEqual(2);

    await test.step('overview on Today (axe)', async () => {
      await page.goto(`${state.webUrl}/today`);
      await expect(page.getByRole('heading', { name: '오늘', level: 1 })).toBeVisible();
      await expect(page.locator('.today-card').first()).toBeVisible({ timeout: 20_000 });
      await expectMode(page, 'overview');
      await expect(page.locator('.nav-rail')).toBeVisible();
      await expect(page.locator('[data-panel="related-notes"]')).toContainText('아직 연결된 노트가 없어요');
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    let firstSession = '';
    await test.step('starting a focus session from Today switches the layout to focus', async () => {
      await page.locator('.today-card').first().getByRole('button', { name: '집중 시작' }).click();
      await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
      firstSession = sessionIdFrom(page);
      await expectMode(page, 'focus');
      await expect(page.locator('.focus-timer')).toBeVisible();
      await expect(page.locator('[data-layout-item="CurrentTaskCard"]')).toBeVisible();
      await expect(page.locator('[data-layout-item="RelatedNotes"]')).toBeVisible();
      await expect(layoutToast(page)).toBeVisible();
      await expect(layoutToast(page).getByRole('button', { name: '되돌리기' })).toBeVisible();
      await expect(layoutToast(page).getByRole('button', { name: '자동 전환 끄기' })).toBeVisible();
      await expect(page.locator('[data-layout-announcer]')).toHaveText('화면 배치를 바꿨어요: 집중');
      await expect(page.locator('.nav-rail')).toBeVisible();
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await test.step('toast undo restores Today; the session keeps running', async () => {
      await layoutToast(page).getByRole('button', { name: '되돌리기' }).click();
      await page.waitForURL(/\/today$/);
      await expectMode(page, 'overview');
      await expect(page.getByRole('heading', { name: '오늘', level: 1 })).toBeVisible();
      await expect(layoutToast(page)).toHaveCount(0);
      await expect(page.locator('[data-layout-announcer]')).toHaveText('화면 배치를 되돌렸어요: 기본');
      // Focus is kept inside the layout, not dropped on <body>.
      await expect(page.locator('[data-layout-region="primary"]')).toBeFocused();
      const running = await getWorkSession(page, state, firstSession);
      expect(running.state).toBe('active');
      await expect(page.getByRole('button', { name: '세션 이어가기' })).toBeVisible();
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await test.step('planning and notes layouts (axe)', async () => {
      await page.locator('.nav-rail').getByRole('link', { name: '계획 세우기' }).click();
      await expect(page.getByRole('heading', { name: '1단계 · 기본정보' })).toBeVisible();
      // The undo turned this session's focus layout down, so the planning rule
      // decides; the page stays primary and the running session stays reachable.
      await expectMode(page, 'planning');
      await expect(page.locator('[data-layout-region="primary"] [data-layout-item="PlanningWorkspace"]')).toBeVisible();
      await expect(page.locator('[data-layout-item="ActiveSessionCard"]')).toBeVisible();
      expect(await blockingAxeViolations(page)).toEqual([]);

      await page.goto(`${state.webUrl}/notes`);
      await expect(page.getByRole('heading', { name: '노트', level: 1 })).toBeVisible();
      await expect(page.locator('[data-layout-item="NotesWorkspace"]')).toBeVisible();
      await expect(page.locator('[data-layout-item="ActiveSessionCard"]')).toBeVisible();
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await test.step('finish the first session from the layout', async () => {
      await page.locator('[data-layout-item="ActiveSessionCard"]').getByRole('link', { name: '세션으로 돌아가기' }).click();
      await page.waitForURL(new RegExp(`/focus/${firstSession}$`));
      await expectMode(page, 'focus');
      await completeAndReview(page);
      // The Focus screen (with its feedback) stays until the user leaves it.
      await expect(page).toHaveURL(new RegExp(`/focus/${firstSession}$`));
      await page.getByRole('button', { name: '오늘로 돌아가기' }).click();
      await page.waitForURL(/\/today$/);
      await expectMode(page, 'overview');
    });

    let secondSession = '';
    await test.step('"자동 전환 끄기" from the toast turns automatic switching off', async () => {
      const cards = page.locator('.today-card');
      await cards.nth(1).getByRole('button', { name: '집중 시작' }).click();
      await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
      secondSession = sessionIdFrom(page);
      await expect(layoutToast(page)).toBeVisible();
      await layoutToast(page).getByRole('button', { name: '자동 전환 끄기' }).click();
      await expect(page.locator('.toast', { hasText: '자동 전환을 껐어요' })).toBeVisible();
      // Turning it off does not change the layout on screen.
      await expectMode(page, 'focus');
    });

    await test.step('the setting persists across a reload', async () => {
      await page.reload();
      await expect(page.locator('.focus-timer')).toBeVisible();
      await page.locator('.nav-rail').getByRole('link', { name: '레이아웃' }).click();
      await expect(page.getByRole('heading', { name: '레이아웃', level: 1 })).toBeVisible();
      await expect(page.getByRole('switch', { name: '상황에 맞춰 화면 배치를 자동으로 바꾸기' })).not.toBeChecked();
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await test.step('with auto switching off, Today no longer offers a layout undo', async () => {
      await page.goto(`${state.webUrl}/focus/${secondSession}`);
      await expect(page.locator('.focus-timer')).toBeVisible();
      await completeAndReview(page);
      await page.getByRole('button', { name: '오늘로 돌아가기' }).click();
      await page.waitForURL(/\/today$/);
      const cards = page.locator('.today-card');
      const target = (await cards.count()) > 2 ? cards.nth(2) : cards.first();
      await target.getByRole('button', { name: '집중 시작' }).click();
      // Focus still opens (the user asked for it), but not as an automatic switch.
      await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
      await expectMode(page, 'focus');
      await expect(layoutToast(page)).toHaveCount(0);
      await completeAndReview(page);
    });

    await context.close();
  });
});
