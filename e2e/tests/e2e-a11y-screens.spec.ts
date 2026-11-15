import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { login } from '../helpers/app';
import { installBrowserClockAt, testClock } from '../helpers/clock';
import { nextLocalMorningMs } from '../helpers/day-clock';
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
// API + Vikunja. E2E-1 covers login/inbox, E2E-2 계획 세우기 (목표·질문·단계), E2E-3
// its 일정안 and E2E-4 Today/Focus; this adds projects, availability,
// commitments, focus (incl. calm mode), the review sheet, notifications and
// AI settings, at desktop width (nav rail) and phone width (bottom nav). It
// also completes and reviews a session with Calm mode on at both widths and
// checks that "Back to Today" and the navigation come back (UI-POLISHR-1).
// HOLO-03A (was M5-03): 재계획 with nothing waiting and AI 분석 at both widths
// (a proposal, its reject dialog and the suppressed state are scanned by
// E2E-5R), and the first two stages of 계획 세우기 at both widths.
// CAL-01 adds the month page (한달) at both widths: today is picked at first
// and its list holds the 약속 seeded below.
// CAL-04 adds 캘린더 연동 (/settings/calendar) at both widths, in whatever
// status the test stack's server reports (without a Google client file:
// the one-time setup). The web tests and the mock sweep cover every status.
// HOLO-01 adds 개요 (/overview), the dashboard, at both widths in the default
// (dark) theme: its five cards have finished loading, exactly one filled
// button is on the screen, and one sentence names what is next.
// HOLO-02 adds 플래너 (/planner): the week grid (the 약속 seeded below is on
// it, under its own accessible name) and the day view beside its timetable,
// at both widths; 약속 추가 is the screen's one filled button. `/month` above
// is the same screen's month view. It also adds 타임 트래커 (/tracker): the
// timer card with its task picker and the week's record, at both widths.

const state = readState();
const account = { email: state.plansEmail, password: state.plansPassword };
/** FU-79: simulate a local morning with room for the plan and a commitment. */
const clock = testClock(state);
const simulatedDayMs = nextLocalMorningMs(clock.nowMs(), 'UTC');
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
    await installBrowserClockAt(context, simulatedDayMs);
    const page = await context.newPage();
    await login(page, state, account);
    const apiNowMs = clock.nowMs();

    await test.step('seed a plan with blocks today and one commitment', async () => {
      await setContinuousWeeklyAvailability(page, state);
      const goal = await createApprovedGoalWithSingleStep(page, state, title, {
        nowMs: apiNowMs,
      });
      if (goal.goalId === undefined) throw new Error('approved goal id is missing');
      const plan = await createPlanFromGoal(page, state, goal.goalId, { nowMs: apiNowMs });
      // The list endpoints take minute-precision instants.
      const minute = Math.floor(simulatedDayMs / 60_000) * 60_000;
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
        blocksAroundBusy(plan, busy, simulatedDayMs),
      );
      expect(approved.blocks.length).toBeGreaterThan(0);
      // A finished half hour at the start of the simulated day (UTC):
      // inside the Commitments page's default week range, clear of the new
      // blocks (the plan starts at 09:05 local).
      const dayStart = new Date(simulatedDayMs);
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

      await test.step(`overview (${size})`, async () => {
        await page.goto(`${state.webUrl}/overview`);
        await expect(
          page.getByRole('heading', { level: 1, name: /좋은 (아침|오후|저녁)(이에요|예요)$/ }),
        ).toBeVisible();
        const cards = page.locator('[data-overview] [data-widget]');
        await expect(cards).toHaveCount(5);
        await expect(page.locator('[data-overview] [data-widget][data-state="ready"]')).toHaveCount(5);
        for (const title of ['진행', '타임 트래커', '오늘 요약', 'AI 도우미', '작업 기록']) {
          await expect(page.getByRole('heading', { name: title, level: 2 })).toBeVisible();
        }
        // The plan seeded above has blocks today (earlier suites may have left
        // others on this account): the dashboard names what is next in one
        // sentence, and exactly one filled button acts on it (07 §4, DESIGN.md).
        await expect(page.locator('[data-next]')).toHaveText(/(블록|세션|집중)/);
        await expect(page.locator('main .btn--primary')).toHaveCount(1);
        await expect(page.locator('main .btn--primary')).toHaveText(/^(집중 시작|이어서 보기)$/);
        // Dark is the default theme; the shell says so on the root element.
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await expectAccessible(page, `overview ${size}`);
      });

      await test.step(`projects + project detail (${size})`, async () => {
        await page.goto(`${state.webUrl}/projects`);
        await expect(page.getByRole('heading', { name: '프로젝트', level: 1 })).toBeVisible();
        const firstProject = page.locator('.project-link').first();
        await expect(firstProject).toBeVisible();
        await expectAccessible(page, `projects ${size}`);

        const projectTitle = (await firstProject.locator('.project-title').innerText()).trim();
        await firstProject.click();
        await expect(page.getByRole('heading', { name: projectTitle, level: 1 })).toBeVisible();
        await expect(page.getByText(/^작업 \d+개$/)).toBeVisible();
        await expectAccessible(page, `project detail ${size}`);
      });

      await test.step(`availability (${size})`, async () => {
        await page.goto(`${state.webUrl}/settings/availability`);
        await expect(page.getByRole('heading', { name: '가용 시간', level: 1 })).toBeVisible();
        await expect(page.getByRole('button', { name: '가용 시간 저장' })).toBeVisible();
        // FU-97 weekly grid: continuous 00:00–24:00 rules (seeded above) show the
        // early hours by themselves and fill every cell; the row editor stays
        // reachable as "시간 직접 입력".
        await expect(page.getByRole('grid', { name: '주간 가용 시간 표' })).toBeVisible();
        await expect(page.getByRole('gridcell', { name: '월요일 00:00~00:30, 작업' })).toBeVisible();
        await expect(page.getByRole('columnheader', { name: '일요일 합계 24시간' })).toBeAttached();
        await expect(page.locator('details[data-direct-entry] > summary')).toHaveText('시간 직접 입력');
        if (viewport === PHONE) {
          // The grid scrolls inside its frame; the page itself never scrolls sideways.
          const widths = await page.evaluate(() => ({
            page: document.documentElement.scrollWidth,
            viewport: window.innerWidth,
          }));
          expect(widths.page).toBeLessThanOrEqual(widths.viewport);
        }
        await expectAccessible(page, `availability ${size}`);
      });

      await test.step(`commitments (${size})`, async () => {
        await page.goto(`${state.webUrl}/commitments`);
        await expect(page.getByRole('heading', { name: '약속', level: 1 })).toBeVisible();
        await expect(page.locator('.commitment-title', { hasText: commitmentTitle })).toBeVisible();
        await expectAccessible(page, `commitments ${size}`);
      });

      await test.step(`month (${size})`, async () => {
        await page.goto(`${state.webUrl}/month`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^\d{4}년 \d{1,2}월$/);
        const grid = page.getByRole('grid', { name: /달력$/ });
        await expect(grid).toBeVisible();
        await expect(grid.getByRole('columnheader')).toHaveCount(7);
        await expect(grid.getByRole('gridcell', { selected: true })).toHaveCount(1);
        await expect(grid.getByRole('gridcell', { selected: true })).toHaveAttribute('aria-label', /오늘/);
        await expect(grid).not.toHaveAttribute('aria-busy', 'true');
        await expect(
          page.locator('[data-month-detail]').getByRole('link', { name: commitmentTitle }),
        ).toBeVisible();
        await expectAccessible(page, `month ${size}`);
      });

      await test.step(`planner week + day (${size})`, async () => {
        await page.goto(`${state.webUrl}/planner`);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          /^(\d{4}년 )?\d{1,2}월 \d{1,2}일 ~ \d{1,2}월 \d{1,2}일$/,
        );
        const week = page.locator('[data-week-grid]');
        await expect(week).toBeVisible();
        await expect(week).not.toHaveAttribute('aria-busy', 'true');
        await expect(page.getByRole('group', { name: /주간 일정$/ })).toBeVisible();
        // The 약속 seeded at 00:00 opens the early hours by itself and is named in full.
        await expect(
          week.getByRole('button', { name: new RegExp(`^약속, ${commitmentTitle}, `) }),
        ).toBeAttached();
        // One tab stop in the grid; one filled button on the screen (07 §4, DESIGN.md).
        await expect(week.locator('.wg-item[tabindex="0"]')).toHaveCount(1);
        await expect(page.locator('main .btn--primary')).toHaveCount(1);
        await expect(page.locator('main .btn--primary')).toHaveText('약속 추가');
        await expectAccessible(page, `planner week ${size}`);

        await page.getByRole('button', { name: '일', exact: true }).click();
        await expect(page).toHaveURL(/\/planner\?view=day/);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(/^(\d{4}년 )?\d{1,2}월 \d{1,2}일 \(.\)$/);
        await expect(page.getByRole('heading', { name: '타임테이블', level: 2 })).toBeVisible();
        await expect(page.locator('[data-planner-day-list]')).toBeVisible();
        await expectAccessible(page, `planner day ${size}`);
      });

      await test.step(`time tracker (${size})`, async () => {
        await page.goto(`${state.webUrl}/tracker`);
        await expect(page.getByRole('heading', { name: '타임 트래커', level: 1 })).toBeVisible();
        await expect(page.getByRole('heading', { name: '타이머', level: 2 })).toBeVisible();
        await expect(page.getByRole('heading', { name: '기록', level: 2 })).toBeVisible();
        const log = page.locator('[data-tracker-log]');
        await expect(log).toHaveAttribute('data-state', 'ready');
        // One filled button on the screen (07 §4, DESIGN.md).
        await expect(page.locator('main .btn--primary')).toHaveCount(1);
        await expect(page.locator('main .btn--primary')).toHaveText(/^(집중 시작|이어서 보기)$/);
        await expectAccessible(page, `time tracker ${size}`);
        // The card is in exactly one of its two states. An earlier suite may have
        // left a session running on this account; otherwise the picker is there,
        // named by its question, with its list wired.
        const idle = page.locator('[data-tracker-idle]');
        await expect(page.locator('[data-tracker-idle], [data-tracker-running]')).toHaveCount(1);
        if ((await idle.count()) === 1) {
          const picker = page.getByRole('combobox', { name: '무엇을 하고 있나요?' });
          await expect(picker).toBeEnabled();
          await expect(picker).toHaveAttribute('aria-expanded', 'false');
          await picker.click();
          await expect(picker).toHaveAttribute('aria-expanded', 'true');
          await expect(page.getByRole('listbox', { name: '무엇을 하고 있나요?' })).toBeVisible();
          await expectAccessible(page, `time tracker picker ${size}`);
          await page.keyboard.press('Escape');
          await expect(picker).toHaveAttribute('aria-expanded', 'false');
        }
      });

      await test.step(`AI settings (${size})`, async () => {
        await page.goto(`${state.webUrl}/settings/ai`);
        await expect(page.getByRole('heading', { name: 'AI 설정', level: 1 })).toBeVisible();
        await expectAccessible(page, `AI settings ${size}`);
      });

      await test.step(`calendar settings (${size})`, async () => {
        await page.goto(`${state.webUrl}/settings/calendar`);
        await expect(page.getByRole('heading', { name: '캘린더 연동', level: 1 })).toBeVisible();
        const status = page.locator('[data-google-status]');
        await expect(status).toBeVisible();
        await expect(status).toHaveAttribute('data-google-status', /^(not_configured|disconnected|connected|needs_reauth)$/);
        // At most one filled button on the page (07 §4, DESIGN.md); the shell's 새 작업 is the rail's own.
        await expect(page.locator('main button.btn--primary')).toHaveCount(
          (await status.getAttribute('data-google-status')) === 'not_configured' ? 0 : 1,
        );
        await expectAccessible(page, `calendar settings ${size}`);
      });

      await test.step(`notifications panel (${size})`, async () => {
        await page.goto(`${state.webUrl}/today`);
        await expect(page.getByRole('heading', { name: '오늘', level: 1 })).toBeVisible();
        if (viewport === PHONE) {
          await page.getByRole('button', { name: '더 보기', exact: true }).click();
          await page
            .getByRole('dialog', { name: '더 보기' })
            .getByRole('button', { name: '알림' })
            .click();
        } else {
          // HOLO-01: the notifications button moved from the sidebar to the top bar.
          await page.locator('.app-topbar').getByRole('button', { name: '알림' }).click();
        }
        const panel = page.getByRole('dialog', { name: '알림' });
        await expect(panel).toBeVisible();
        await expect(panel.getByText('알림을 불러오는 중…')).toHaveCount(0);
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
        await card.getByRole('button', { name: '집중 시작' }).click();
        await page.waitForURL(/\/focus\/[0-9a-f-]{36}$/);
        await expect(page.locator('.focus-timer')).toBeVisible();
        await expect(page.getByText('집중하는 중', { exact: true })).toBeVisible();
        const nav = page.locator(run.nav);
        const back = page.getByRole('button', { name: '오늘로 돌아가기' });
        await expect(nav).toBeVisible();
        await expectAccessible(page, `focus ${size}`);

        const calm = page.getByRole('button', { name: '몰입 모드' });
        await calm.click();
        await expect(calm).toHaveAttribute('aria-pressed', 'true');
        await expect(nav).toBeHidden();
        await expect(back).toBeHidden();
        await expectAccessible(page, `focus calm mode ${size}`);

        // Complete without leaving Calm mode first.
        await page.getByRole('button', { name: '완료' }).click();
        await expect(page.getByRole('heading', { name: '이번 세션은 어땠나요?' })).toBeVisible();
        await expect(calm).toHaveCount(0);
        await expect(back).toBeVisible();
        await expect(nav).toBeVisible();
        await page.getByRole('radio', { name: '일부만' }).check();
        await page.getByRole('checkbox', { name: '생각보다 컸어요' }).check();
        await expectAccessible(page, `review sheet after calm ${size}`);

        await page.getByRole('button', { name: '회고 저장' }).click();
        await expect(page.getByRole('heading', { name: '추정 피드백' })).toBeVisible();
        await expect(back).toBeVisible();
        await expect(nav).toBeVisible();
        await expectAccessible(page, `review feedback after calm ${size}`);

        await back.click();
        await expect(page.getByRole('heading', { name: '오늘', level: 1 })).toBeVisible();
        await expect(nav).toBeVisible();
      });
    }

    // HOLO-03A: 재계획 with nothing waiting, AI 분석 (learned from the two reviews and
    // sessions above), and where a plan starts — at both widths.
    for (const viewport of [DESKTOP, PHONE]) {
      const size = `${viewport.width}x${viewport.height}`;
      await test.step(`재계획 + AI 분석 + 계획 세우기 (${size})`, async () => {
        await page.setViewportSize(viewport);
        await page.goto(`${state.webUrl}/replan`);
        await expect(page.getByRole('heading', { name: '재계획', level: 1 })).toBeVisible();
        await expect(page.locator('[data-replan-none]')).toContainText('지금은 계획대로예요');
        await expect(page.locator('[data-replan-list]')).toBeVisible();
        // An empty state never carries the filled button.
        await expect(page.locator('[data-replan] .btn--primary')).toHaveCount(0);
        await expectAccessible(page, `replan ${size}`);

        // The old address leads to the new page.
        await page.goto(`${state.webUrl}/patterns`);
        await page.waitForURL(/\/insights$/);
        await expect(page.getByRole('heading', { name: 'AI 분석', level: 1 })).toBeVisible();
        await expect(page.locator('.insights-record').first()).toBeVisible();
        // The sessions above were completed on a clamped clock (FU-79), so they may hold no focused minute:
        // either the week chart drawn from them (its numbers also a table of eight weeks), or the honest
        // empty state that leads back to 오늘 — never a chart drawn from nothing.
        const weeks = page.locator('[data-insight="weeks"]');
        await expect(weeks.locator('[data-chart="bars"], [data-insights-empty="weeks"]').first()).toBeVisible();
        if (await weeks.locator('[data-chart="bars"]').isVisible()) {
          await expect(weeks.locator('[data-chart-table] tbody tr')).toHaveCount(8);
          await expect(weeks.locator('[data-insights-empty]')).toHaveCount(0);
        } else {
          await expect(weeks.locator('[data-insights-empty="weeks"] a')).toHaveAttribute('href', '/today');
          await expect(weeks.locator('[data-chart]')).toHaveCount(0);
        }
        // Two reviews are not yet a pattern: either the number (three or more) or the honest empty state.
        await expect(page.locator('[data-estimate-ratio], [data-insights-empty="estimate"]').first()).toBeVisible();
        await expect(page.locator('[data-insight="uses"]')).toContainText('회고 메모의 내용은 쓰지 않아요.');
        await expectAccessible(page, `insights ${size}`);

        await page.goto(`${state.webUrl}/plan`);
        await expect(page.getByRole('heading', { name: '계획 세우기', level: 1 })).toBeVisible();
        await expect(page.locator('#plan-goal-title')).toBeVisible();
        await expect(page.locator('.plan-page .btn--primary')).toHaveCount(1);
        await expectAccessible(page, `plan goal ${size}`);

        await page.goto(`${state.webUrl}/plan/schedule`);
        await expect(page.locator('[data-plan-create]')).toBeVisible();
        await expect(page.locator('[data-scope-summary]')).toBeVisible();
        await expect(page.locator('.plan-page .btn--primary')).toHaveCount(1);
        await expectAccessible(page, `plan scope ${size}`);
      });
    }

    await context.close();
  });
});
