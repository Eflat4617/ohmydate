import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { login } from '../helpers/app';
import {
  approveCandidateWithBlocks,
  createApprovedGoalWithSingleStep,
  createOverlappingCommitment,
  createPlanFromGoal,
  listCommitmentIntervals,
  listScheduleBlockIntervals,
  setContinuousWeeklyAvailability,
  type IntervalDto,
  type PlanDto,
} from '../helpers/planner';
import { readState } from '../helpers/state';

// UI-POLISH: axe sweep of the screens E2E-1..4 do not scan, against the real
// API + Vikunja. E2E-1 covers login/inbox, E2E-2 the wizard, E2E-3 the plan
// comparison and E2E-4 Today/Focus; this adds projects, availability,
// commitments, focus (incl. calm mode), the review sheet, notifications and
// AI settings, at desktop width (nav rail) and phone width (bottom nav). It
// also completes and reviews a session with Calm mode on at both widths and
// checks that "Back to Today" and the navigation come back (UI-POLISHR-1).

const state = readState();
const account = { email: state.plansEmail, password: state.plansPassword };
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };
const GRID_MS = 5 * 60_000;

async function blockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    }));
}

/**
 * Wait for entrance animations (dialog/sheet/toast fade-ins) to finish so axe
 * measures final colours, not a half-transparent frame. Infinite animations
 * (spinner, skeleton shimmer) are ignored.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function expectAccessible(page: Page, screen: string): Promise<void> {
  await settleAnimations(page);
  expect(await blockingAxeViolations(page), `${screen}: critical/serious axe violations`).toEqual(
    [],
  );
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scrollWidth,
    `${screen}: page must not scroll horizontally (${JSON.stringify(overflow)})`,
  ).toBeLessThanOrEqual(overflow.clientWidth);
}

/**
 * Like editableBlocksForToday, but steps over intervals that are already busy
 * (earlier suites leave approved blocks on this account) so the approval does
 * not collide with them.
 */
function blocksAroundBusy(
  plan: PlanDto,
  busy: readonly IntervalDto[],
  now: number,
): { taskId: string; startAt: string; endAt: string }[] {
  const candidate = plan.candidates.find((entry) => entry.feasible) ?? plan.candidates[0];
  if (candidate === undefined) throw new Error('plan has no candidate to approve');
  const taken = busy.map((interval) => ({
    start: Date.parse(interval.startAt),
    end: Date.parse(interval.endAt),
  }));
  const sorted = [...candidate.blocks].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  let cursor = Math.ceil((now + GRID_MS) / GRID_MS) * GRID_MS;
  return sorted.map((block) => {
    const duration = Date.parse(block.endAt) - Date.parse(block.startAt);
    for (;;) {
      const clash = taken.find(
        (interval) => cursor < interval.end + GRID_MS && interval.start < cursor + duration + GRID_MS,
      );
      if (clash === undefined) break;
      cursor = Math.ceil((clash.end + GRID_MS) / GRID_MS) * GRID_MS;
    }
    const placed = { start: cursor, end: cursor + duration };
    taken.push(placed);
    cursor = placed.end + GRID_MS;
    return {
      taskId: block.taskId,
      startAt: new Date(placed.start).toISOString(),
      endAt: new Date(placed.end).toISOString(),
    };
  });
}

test.describe('UI-POLISH — axe on every remaining screen (real API)', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test('projects, availability, commitments, focus, review, notifications and AI settings have no critical or serious axe violations; Calm mode keeps an exit after completing', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const title = `E2E a11y ${suffix}`;
    const commitmentTitle = `E2E a11y commitment ${suffix}`;
    const context = await browser.newContext({ timezoneId: 'UTC', viewport: DESKTOP });
    const page = await context.newPage();
    await login(page, state, account);

    await test.step('seed a plan with blocks today and one commitment', async () => {
      await setContinuousWeeklyAvailability(page, state);
      const goal = await createApprovedGoalWithSingleStep(page, state, title);
      if (goal.goalId === undefined) throw new Error('approved goal id is missing');
      const plan = await createPlanFromGoal(page, state, goal.goalId);
      const now = Date.now();
      // The list endpoints take minute-precision instants.
      const minute = Math.floor(now / 60_000) * 60_000;
      const from = new Date(minute - 86_400_000).toISOString();
      const to = new Date(minute + 2 * 86_400_000).toISOString();
      const busy = [
        ...(await listScheduleBlockIntervals(page, state, from, to)),
        ...(await listCommitmentIntervals(page, state, from, to)),
      ];
      const approved = await approveCandidateWithBlocks(
        page,
        state,
        plan,
        blocksAroundBusy(plan, busy, now),
      );
      expect(approved.blocks.length).toBeGreaterThan(0);
      // A finished half hour at the start of today (UTC): inside the
      // Commitments page's default week range, clear of the new blocks.
      const dayStart = new Date(now);
      dayStart.setUTCHours(0, 0, 0, 0);
      await createOverlappingCommitment(
        page,
        state,
        dayStart.toISOString(),
        new Date(dayStart.getTime() + 30 * 60_000).toISOString(),
        commitmentTitle,
      );
    });

    for (const viewport of [DESKTOP, PHONE]) {
      const size = `${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport);

      await test.step(`projects + project detail (${size})`, async () => {
        await page.goto(`${state.webUrl}/projects`);
        await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
        const firstProject = page.locator('.project-link').first();
        await expect(firstProject).toBeVisible();
        await expectAccessible(page, `projects ${size}`);

        const projectTitle = (await firstProject.locator('.project-title').innerText()).trim();
        await firstProject.click();
        await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
        await expect(page.getByText(/^\d+ tasks?$/)).toBeVisible();
        await expectAccessible(page, `project detail ${size}`);
      });

      await test.step(`availability (${size})`, async () => {
        await page.goto(`${state.webUrl}/settings/availability`);
        await expect(page.getByRole('heading', { name: 'Availability', level: 1 })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Save availability' })).toBeVisible();
        await expectAccessible(page, `availability ${size}`);
      });

      await test.step(`commitments (${size})`, async () => {
        await page.goto(`${state.webUrl}/commitments`);
        await expect(page.getByRole('heading', { name: 'Commitments', level: 1 })).toBeVisible();
        await expect(page.locator('.commitment-title', { hasText: commitmentTitle })).toBeVisible();
        await expectAccessible(page, `commitments ${size}`);
      });

      await test.step(`AI settings (${size})`, async () => {
        await page.goto(`${state.webUrl}/settings/ai`);
        await expect(page.getByRole('heading', { name: 'AI settings', level: 1 })).toBeVisible();
        await expectAccessible(page, `AI settings ${size}`);
      });

      await test.step(`notifications panel (${size})`, async () => {
        await page.goto(`${state.webUrl}/today`);
        await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
        if (viewport === PHONE) {
          await page.getByRole('button', { name: 'More', exact: true }).click();
          await page
            .getByRole('dialog', { name: 'More' })
            .getByRole('button', { name: 'Notifications' })
            .click();
        } else {
          await page.locator('.nav-rail').getByRole('button', { name: 'Notifications' }).click();
        }
        const panel = page.getByRole('dialog', { name: 'Notifications' });
        await expect(panel).toBeVisible();
        await expect(panel.getByText('Loading notifications…')).toHaveCount(0);
        await expectAccessible(page, `notifications ${size}`);
        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
      });
    }

    // UI-POLISHR-1: complete and review with Calm mode still on. Completing
    // must leave Calm mode so "Back to Today" and the navigation come back.
    const calmRuns = [
      { viewport: DESKTOP, block: `${title} prep`, nav: '.nav-rail' },
      { viewport: PHONE, block: `${title} work`, nav: '.bottom-nav' },
    ];
    for (const run of calmRuns) {
      const size = `${run.viewport.width}x${run.viewport.height}`;
      await test.step(`focus, calm mode, complete and review while calm (${size})`, async () => {
        await page.setViewportSize(run.viewport);
        await page.goto(`${state.webUrl}/today`);
        const card = page.locator('.today-card', { hasText: run.block });
        await expect(card).toBeVisible({ timeout: 20_000 });
        await card.getByRole('button', { name: 'Start focus' }).click();
        await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
        await expect(page.locator('.focus-timer')).toBeVisible();
        await expect(page.getByText('Focusing', { exact: true })).toBeVisible();
        const nav = page.locator(run.nav);
        const back = page.getByRole('button', { name: 'Back to Today' });
        await expect(nav).toBeVisible();
        await expectAccessible(page, `focus ${size}`);

        const calm = page.getByRole('button', { name: 'Calm mode' });
        await calm.click();
        await expect(calm).toHaveAttribute('aria-pressed', 'true');
        await expect(nav).toBeHidden();
        await expect(back).toBeHidden();
        await expectAccessible(page, `focus calm mode ${size}`);

        // Complete without leaving Calm mode first.
        await page.getByRole('button', { name: 'Complete' }).click();
        await expect(page.getByRole('heading', { name: 'How did the session go?' })).toBeVisible();
        await expect(calm).toHaveCount(0);
        await expect(back).toBeVisible();
        await expect(nav).toBeVisible();
        await page.getByRole('radio', { name: 'Partial' }).check();
        await page.getByRole('checkbox', { name: 'Task was larger' }).check();
        await expectAccessible(page, `review sheet after calm ${size}`);

        await page.getByRole('button', { name: 'Submit review' }).click();
        await expect(page.getByRole('heading', { name: 'Estimation feedback' })).toBeVisible();
        await expect(back).toBeVisible();
        await expect(nav).toBeVisible();
        await expectAccessible(page, `review feedback after calm ${size}`);

        await back.click();
        await expect(page.getByRole('heading', { name: 'Today', level: 1 })).toBeVisible();
        await expect(nav).toBeVisible();
      });
    }

    await context.close();
  });
});
