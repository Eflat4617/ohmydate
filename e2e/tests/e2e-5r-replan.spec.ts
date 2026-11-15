import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { login } from '../helpers/app';
import {
  answerIntakeWithSkip,
  apiFetch,
  approveCandidateWithBlocks,
  approveIntakeDraft,
  createIntakeGoal,
  createOverlappingCommitment,
  createPlanFromGoal,
  expectOk,
  idempotencyKey,
  listNotifications,
  replaceIntakeDraftWithSteps,
  setContinuousWeeklyAvailability,
  type ApprovedBlockDto,
} from '../helpers/planner';
import { readState } from '../helpers/state';

/**
 * E2E-5R (M5-03): replanning against the real API + Vikunja.
 *
 * 1. Approve a four-task plan (P50 = P90, so no deadline-risk trigger), lock
 *    the first block in the UI (the confirmed plan's week grid: the block's
 *    card, FU-71: `POST /schedule-blocks/{id}:lock`) and add a commitment over
 *    the second block.
 * 2. The leader-only detection sweep (05 §11, every 5 min) creates exactly one
 *    commitment_conflict proposal; 오늘 (the replan card) and the notifications
 *    surface it.
 * 3. 재계획 shows 전 → 후 in words and on the week grid; approving it moves
 *    only the overlapped block; the locked block keeps its row and times, the
 *    others keep their times; the hand-off leads to 오늘.
 * 4. "재계획 요청" → reject (24 h same-reason suppression explained) → asking
 *    again is 409 replan_suppressed, shown with a human-readable wait.
 */

const state = readState();
const account = { email: state.replanEmail, password: state.replanPassword };
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const MINUTE = 60_000;
const GRID = 5 * MINUTE;
/** Detection runs every 300 s from API start; allow two ticks (a lost leader lock skips one). */
const DETECTION_TIMEOUT_MS = 11 * MINUTE;

interface ProposalDto {
  readonly id: string;
  readonly state: string;
  readonly planId: string;
  readonly basePlanVersion: number;
  readonly before?: {
    readonly blocks: readonly { id: string; taskId: string; startAt: string; endAt: string; locked: boolean }[];
    readonly metrics: { readonly totalFocusMin: number; readonly minSlackMin: number };
  };
  readonly version: number;
  readonly availabilityVersion: number;
  readonly trigger: {
    readonly kind: string;
    readonly reason: string;
    readonly affectedTaskIds: readonly string[];
  };
  readonly candidate: { readonly blocks: readonly { taskId: string; startAt: string; endAt: string }[] };
}

/** Wait for entrance animations to end (a card slides in); infinite ones (a spinner) are ignored. */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function blockingAxeViolations(page: Page) {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({ id: violation.id, impact: violation.impact, targets: violation.nodes.map((node) => node.target) }));
}

async function listProposals(page: Page, stateFilter?: string): Promise<ProposalDto[]> {
  const query = stateFilter === undefined ? '?limit=50' : `?state=${stateFilter}&limit=50`;
  const body = (await expectOk(await apiFetch(page, state, `/replan-proposals${query}`), 'GET /replan-proposals')) as {
    items: ProposalDto[];
  };
  return body.items;
}

async function activeBlocks(page: Page, fromMs: number): Promise<ApprovedBlockDto[]> {
  const from = new Date(Math.floor(fromMs / MINUTE) * MINUTE).toISOString();
  const to = new Date(Math.floor(fromMs / MINUTE) * MINUTE + 14 * 24 * 60 * MINUTE).toISOString();
  const body = (await expectOk(
    await apiFetch(page, state, `/schedule-blocks?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=500`),
    'GET /schedule-blocks',
  )) as { items: ApprovedBlockDto[] };
  return body.items.filter((block) => block.status !== 'superseded');
}

function overlaps(left: { startAt: string; endAt: string }, right: { startAt: string; endAt: string }): boolean {
  return Date.parse(left.startAt) < Date.parse(right.endAt) && Date.parse(right.startAt) < Date.parse(left.endAt);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * FU-86F: page-relative boxes (scroll-independent) of the confirmed plan's
 * hand-off, its week grid, and the open block card with its lock toggle.
 */
async function lockLayout(page: Page): Promise<Record<string, Box>> {
  return page.evaluate(() => {
    const boxes: Record<string, Box> = {};
    const add = (key: string, element: Element | null) => {
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      boxes[key] = { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
    };
    add('next', document.querySelector('[data-plan-next]'));
    add('grid', document.querySelector('.plan-week-frame'));
    add('card', document.querySelector('[data-planner-card="block"]'));
    add('toggle', document.querySelector('[data-planner-card="block"] button[data-block-lock]'));
    return boxes;
  });
}

function expectSameLayout(actual: Record<string, Box>, expected: Record<string, Box>, when: string): void {
  expect(Object.keys(actual).sort(), `${when}: the same parts`).toEqual(Object.keys(expected).sort());
  for (const [key, box] of Object.entries(expected)) {
    for (const side of ['x', 'y', 'width', 'height'] as const) {
      const moved = Math.abs((actual[key]?.[side] ?? Number.NaN) - box[side]);
      expect(moved, `${when}: ${key} ${side} moved by ${moved}px`).toBeLessThanOrEqual(0.5);
    }
  }
}

/**
 * FU-71: lock a block the way a user does (HOLO-03A) — the confirmed plan
 * draws its blocks on the week grid; a block's card carries the lock. The grid
 * is paged forward to the block's week when the plan starts in an earlier one.
 *
 * (That an edit of a schedule being chosen is held while a lock is being
 * saved — FU-86F — needs a proposal and a confirmed block on one grid, which
 * one plan never has; apps/web/test/block-lock.spec.ts covers it.)
 */
async function lockInUi(page: Page, planId: string, block: ApprovedBlockDto): Promise<void> {
  const weekRead = () =>
    page.waitForResponse(
      (candidate) => candidate.request().method() === 'GET' && candidate.url().includes('/schedule-blocks?'),
    );
  let read = weekRead();
  // The old address of a plan still leads to it.
  await page.goto(`${state.webUrl}/plans/${planId}`);
  await page.waitForURL(new RegExp(`/plan/schedule/${planId}`));
  await expect(page.locator('[data-plan-next]')).toBeVisible();
  await expect(page.locator('[data-plan-rail] [data-stage="confirmed"]')).toHaveAttribute('data-state', 'done');
  const item = page.locator(`.wg-item[data-item^="block:${block.id}@"]`).first();
  for (let week = 0; week < 3; week += 1) {
    await read;
    const shown = await item.waitFor({ state: 'attached', timeout: 3_000 }).then(
      () => true,
      () => false,
    );
    if (shown) break;
    read = weekRead();
    await page.locator('[data-plan-week-next]').click();
  }
  // A confirmed block is drawn as a block: never as a proposal.
  await expect(item).toHaveAttribute('data-kind', 'block');
  await expect(page.locator('.wg-item[data-kind="proposal"]')).toHaveCount(0);
  await item.click();
  const card = page.locator('[data-planner-card="block"]');
  await expect(card).toBeVisible();
  const toggle = card.getByRole('button', { name: '블록 고정', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // FU-86: the card's task title and time describe the toggle, so blocks differ for a screen reader.
  const title = (await card.locator('#planner-card-title').innerText()).trim();
  expect(title.length).toBeGreaterThan(0);
  await expect(toggle).toHaveAccessibleDescription(new RegExp(`^${escapeRegExp(title)} .*\\d{1,2}:\\d{2}`));
  // FU-86F: the lock answer is held so the page can be measured while it is out.
  // (The card slides in over a few frames: measure it once it has arrived.)
  await settleAnimations(page);
  const layoutBefore = await lockLayout(page);
  expect(Object.keys(layoutBefore).sort()).toEqual(['card', 'grid', 'next', 'toggle']);
  let releaseLock: () => void = () => {};
  const lockHeld = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const isLockRequest = (url: URL) => url.pathname.endsWith(`/schedule-blocks/${block.id}:lock`);
  await page.route(isLockRequest, async (route) => {
    await lockHeld;
    await route.continue();
  });
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' && candidate.url().endsWith(`/schedule-blocks/${block.id}:lock`),
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-busy', 'true');
  await settleAnimations(page);
  // Pressing the toggle moves nothing: the hand-off, the grid, the card and the toggle keep their boxes
  // (FU-86R: a note above the calendar pushed them down, and a second click hit something else).
  expectSameLayout(await lockLayout(page), layoutBefore, 'lock out');
  releaseLock();
  const locked = await response;
  await page.unroute(isLockRequest);
  expect(locked.status()).toBe(200);
  const headers = locked.request().headers();
  expect(headers['if-match']).toBe(`W/"${block.version}"`);
  expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  // FU-86: the same button, now pressed; its name does not change with the state.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAccessibleName('블록 고정');
  await expect(toggle).toBeEnabled();
  // Settled: nothing has moved, and the block on the grid carries its lock.
  await settleAnimations(page);
  expectSameLayout(await lockLayout(page), layoutBefore, 'lock settled');
  await expect(item).toHaveClass(/wg-item--locked/);
}

test.describe('E2E-5R — replan proposal flow (real API)', () => {
  test.describe.configure({ mode: 'serial', timeout: 18 * MINUTE });

  test('a commitment conflict is proposed once, approval moves only the changed block, and a rejected reason stays suppressed', async ({
    browser,
  }) => {
    const suffix = Date.now().toString(36);
    const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    await login(page, state, account);

    // ── 1. Approved plan, one locked block, one overlapping commitment ─────
    const startMs = Date.now();
    const t0 = Math.ceil((startMs + 3 * 60 * MINUTE) / GRID) * GRID;
    let approvedBlocks: ApprovedBlockDto[] = [];
    let lockedBlock: ApprovedBlockDto | undefined;
    let movedBlock: ApprovedBlockDto | undefined;
    let conflict = { startAt: '', endAt: '' };
    let planId = '';

    await test.step('approve a four-task plan and lock its first block', async () => {
      await setContinuousWeeklyAvailability(page, state, 600);
      const created = await createIntakeGoal(page, state, {
        title: `E2E replan goal ${suffix}`,
        description: 'E2E-5R synthetic replan goal.',
        dueAt: new Date(startMs + 7 * 24 * 60 * MINUTE).toISOString(),
        estimatedScope: 'small',
        maxFocusMinutes: 60,
      });
      const answered = await answerIntakeWithSkip(page, state, created);
      const step = (key: string, kind: string) => ({
        key,
        title: `E2E replan ${key} ${suffix}`,
        deliverable: `Deliverable ${key}`,
        doneCriteria: `Done ${key}`,
        kind,
        estimate: { p50Minutes: 30, p90Minutes: 30 },
        dependsOn: [],
        splittable: false,
      });
      const prepared = await replaceIntakeDraftWithSteps(page, state, answered, [
        step('s1', 'prep'),
        step('s2', 'work'),
        step('s3', 'work'),
        step('s4', 'review'),
      ]);
      const goal = await approveIntakeDraft(page, state, prepared);
      if (goal.goalId === undefined) throw new Error('approved goal id is missing');
      const plan = await createPlanFromGoal(page, state, goal.goalId);
      planId = plan.id;
      const candidate = plan.candidates.find((entry) => entry.feasible) ?? plan.candidates[0];
      if (candidate === undefined) throw new Error('plan has no candidate');
      const minutesByTask = new Map<string, number>();
      for (const block of candidate.blocks) {
        const minutes = (Date.parse(block.endAt) - Date.parse(block.startAt)) / MINUTE;
        minutesByTask.set(block.taskId, (minutesByTask.get(block.taskId) ?? 0) + minutes);
      }
      expect(minutesByTask.size).toBe(4);
      // One block per task, an hour apart, starting three hours from now.
      const edited = [...minutesByTask.entries()].map(([taskId, minutes], index) => ({
        taskId,
        startAt: new Date(t0 + index * 60 * MINUTE).toISOString(),
        endAt: new Date(t0 + index * 60 * MINUTE + minutes * MINUTE).toISOString(),
      }));
      const version = await approveCandidateWithBlocks(page, state, plan, edited);
      approvedBlocks = [...version.blocks].sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
      expect(approvedBlocks).toHaveLength(4);
      lockedBlock = approvedBlocks[0];
      movedBlock = approvedBlocks[1];
      if (lockedBlock === undefined || movedBlock === undefined) throw new Error('approved blocks missing');
      await lockInUi(page, planId, lockedBlock);
      // The API agrees: locked, same row, same times.
      const stored = (await activeBlocks(page, startMs)).find((block) => block.id === lockedBlock?.id);
      expect(stored?.locked).toBe(true);
      expect(Date.parse(stored?.startAt ?? '')).toBe(Date.parse(lockedBlock.startAt));
      expect(Date.parse(stored?.endAt ?? '')).toBe(Date.parse(lockedBlock.endAt));
    });

    await test.step('keep the next hours busy and add a commitment over the second block', async () => {
      if (movedBlock === undefined) throw new Error('approved blocks missing');
      // Busy until shortly before the plan so a moved block can never start
      // while the proposal is being reviewed (approval rejects started blocks).
      await createOverlappingCommitment(
        page,
        state,
        new Date(Math.floor(startMs / MINUTE) * MINUTE).toISOString(),
        new Date(t0 - 30 * MINUTE).toISOString(),
        `E2E replan busy ${suffix}`,
      );
      conflict = {
        startAt: new Date(Date.parse(movedBlock.startAt) - 10 * MINUTE).toISOString(),
        endAt: new Date(Date.parse(movedBlock.startAt) + 15 * MINUTE).toISOString(),
      };
      await createOverlappingCommitment(page, state, conflict.startAt, conflict.endAt, `E2E replan dinner ${suffix}`);
    });

    // ── 2. Detection creates exactly one proposal ─────────────────────────
    let proposal: ProposalDto | undefined;
    await test.step('the detection sweep proposes the conflict exactly once', async () => {
      await expect
        .poll(
          async () => {
            proposal = (await listProposals(page, 'pending')).find((item) => item.trigger.reason === 'commitment_overlap');
            return proposal !== undefined;
          },
          { timeout: DETECTION_TIMEOUT_MS, intervals: [10_000] },
        )
        .toBe(true);
      if (proposal === undefined || movedBlock === undefined || lockedBlock === undefined) throw new Error('no proposal');
      const all = await listProposals(page);
      expect(all, 'one proposal in total for this owner').toHaveLength(1);
      expect(proposal.trigger.kind).toBe('commitment_conflict');
      expect(proposal.trigger.affectedTaskIds).toEqual([movedBlock.taskId]);
      expect(proposal.candidate.blocks.some((block) => block.taskId === lockedBlock?.taskId)).toBe(false);
      // FU-70: the server names the plan and snapshots every block it replaces or keeps.
      expect(proposal.planId).toBe(planId);
      expect(proposal.basePlanVersion).toBeGreaterThanOrEqual(1);
      expect(proposal.before?.blocks.map((block) => block.id).sort()).toEqual(approvedBlocks.map((block) => block.id).sort());
      expect(proposal.before?.blocks.find((block) => block.id === lockedBlock?.id)?.locked).toBe(true);
      const notices = (await listNotifications(page, state)).filter(
        (item) => item.dedupeKey === `replan_proposal:${proposal?.id}`,
      );
      expect(notices).toHaveLength(1);
    });
    if (proposal === undefined || movedBlock === undefined || lockedBlock === undefined) throw new Error('no proposal');
    const proposalId = proposal.id;

    await test.step('오늘 shows one calm card and the notifications link to it', async () => {
      await page.goto(`${state.webUrl}/overview`);
      await expect(page.getByRole('heading', { name: '오늘', exact: true })).toBeVisible();
      const banner = page.locator('[data-replan-card]');
      await expect(banner).toHaveCount(1);
      await expect(banner).toContainText('일정을 다시 맞출까요?');
      await expect(banner).toContainText('약속과 겹치는 블록이 있어요');
      await expect(banner).toContainText('승인하기 전에는 아무것도 바뀌지 않아요.');
      // The card only links; it is never the screen's filled button.
      await expect(banner.locator('.btn--primary')).toHaveCount(0);
      expect(await blockingAxeViolations(page)).toEqual([]);

      // HOLO-01: the notifications button moved from the sidebar to the top bar.
      await page.locator('.app-topbar').getByRole('button', { name: '알림' }).click();
      const panel = page.getByRole('dialog', { name: '알림' });
      await expect(panel.locator('[data-open-proposal]')).toHaveCount(1);
      await expect(panel.locator('[data-open-proposal]')).toHaveAttribute('href', `/replan/${proposalId}`);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await banner.locator('[data-replan-card-open]').click();
      await page.waitForURL(new RegExp(`/replan/${proposalId}$`));
    });

    // ── 3. The diff shows only the moved block; approval applies only it ──
    await test.step('재계획 shows only the changed block, in words and on the grid, and the locked block as unchanged', async () => {
      await expect(page.getByRole('heading', { name: '재계획', level: 1 })).toBeVisible();
      await expect(page.locator('[data-replan-trigger]')).toHaveText('약속과 겹침');
      await expect(page.locator('[data-proposal-state]')).toHaveText('승인 대기');
      const changes = page.locator('.replan-change');
      await expect(changes).toHaveCount(1);
      await expect(changes.first()).toHaveAttribute('data-task-id', movedBlock?.taskId ?? '');
      await expect(changes.first()).toHaveAttribute('data-change', 'moved');
      const locked = page.locator('[data-locked]');
      await expect(locked).toHaveCount(1);
      await expect(locked).toHaveAttribute('data-block-id', lockedBlock?.id ?? '');
      await expect(locked).toContainText('고정됨');
      await expect(page.getByText('그 밖의 블록 2개는 그대로예요.')).toBeVisible();
      // 전 → 후 as numbers: the value after approval with the value now under it.
      await expect(page.locator('[data-metric="slack"] [data-after]')).toBeVisible();
      await expect(page.locator('[data-metric="slack"] [data-before]')).toHaveText(/^전 /);
      await expect(page.locator('[data-metric="changed"] [data-after]')).toBeVisible();
      // 전 → 후 on the week grid: where the block stood and where it goes. (The locked block may be on the
      // day before the first change, which the grid starts at; the list above names it either way.)
      await expect(page.locator('.replan-week .wg-item[data-kind="ghost"]').first()).toHaveAttribute('data-change', 'moved');
      await expect(page.locator('.replan-week .wg-item[data-kind="proposal"]').first()).toHaveAttribute('data-change', 'moved');
      await expect(page.locator('.replan-week .wg-item--editable')).toHaveCount(0);
      // One filled button: 승인.
      await expect(page.locator('[data-replan] .btn--primary')).toHaveCount(1);
      await expect(page.locator('[data-replan-approve]')).toHaveClass(/btn--primary/);
      // The proposal is in the list beside it, marked as the one on show.
      await expect(page.locator(`[data-proposal-id="${proposalId}"] a`)).toHaveAttribute('aria-current', 'true');
      // FU-62: the API sends coded explanation items, rendered in Korean.
      const explanation = page.locator('.replan-explanation details');
      await expect(explanation).toHaveAttribute('data-explanation', 'coded');
      await expect(explanation.locator('summary')).toHaveText('계산 근거');
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await test.step('approving moves only the overlapped block; the locked block keeps its row', async () => {
      const response = page.waitForResponse(
        (candidate) => candidate.request().method() === 'POST' && candidate.url().endsWith(`/replan-proposals/${proposalId}:approve`),
      );
      await page.locator('[data-replan-approve]').click();
      const approval = await response;
      expect(approval.status()).toBe(201);
      const headers = approval.request().headers();
      expect(headers['if-match']).toBe(`W/"availability:${proposal?.availabilityVersion}"`);
      expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      await expect(page.locator('[data-proposal-state]')).toHaveText('승인됨');
      await expect(page.getByText('제안을 승인했어요. 새 일정이 반영됐어요.').first()).toBeVisible();
      // The hand-off: the one filled control now leads to 오늘, and nothing is drawn as a proposal any more.
      await expect(page.locator('[data-replan-today]')).toHaveAttribute('href', '/overview');
      await expect(page.locator('[data-replan] .btn--primary')).toHaveCount(1);
      await expect(page.locator('.replan-week .wg-item[data-kind="proposal"]')).toHaveCount(0);

      const after = await activeBlocks(page, startMs);
      const planTasks = new Set(approvedBlocks.map((block) => block.taskId));
      const mine = after.filter((block) => planTasks.has(block.taskId));
      expect(mine).toHaveLength(4);
      const keptLocked = mine.find((block) => block.id === lockedBlock?.id);
      expect(keptLocked, 'locked block keeps its row').toBeDefined();
      expect(keptLocked?.locked).toBe(true);
      expect(Date.parse(keptLocked?.startAt ?? '')).toBe(Date.parse(lockedBlock?.startAt ?? ''));
      expect(Date.parse(keptLocked?.endAt ?? '')).toBe(Date.parse(lockedBlock?.endAt ?? ''));
      for (const original of approvedBlocks.slice(2)) {
        const same = mine.find((block) => block.taskId === original.taskId);
        expect(Date.parse(same?.startAt ?? ''), `unchanged block of ${original.taskId}`).toBe(Date.parse(original.startAt));
        expect(Date.parse(same?.endAt ?? '')).toBe(Date.parse(original.endAt));
      }
      const moved = mine.find((block) => block.taskId === movedBlock?.taskId);
      expect(moved).toBeDefined();
      expect(Date.parse(moved?.startAt ?? '')).not.toBe(Date.parse(movedBlock?.startAt ?? ''));
      expect(overlaps(moved as ApprovedBlockDto, conflict)).toBe(false);
      expect(Date.parse(moved?.startAt ?? '')).toBeGreaterThan(Date.now());
      expect((await listProposals(page)).find((item) => item.id === proposalId)?.state).toBe('approved');
    });

    // ── 4. User request → reject → same reason suppressed ─────────────────
    let requestedId = '';
    await test.step('“재계획 요청” creates a user_request proposal that is rejected with the 24 h explanation', async () => {
      await page.goto(`${state.webUrl}/overview`);
      await expect(page.getByRole('heading', { name: '오늘', exact: true })).toBeVisible();
      await expect(page.locator('[data-replan-card]')).toHaveCount(0);
      await page.locator('[data-replan-request]').click();
      await page.waitForURL(/\/replan\/[0-9a-f-]{36}$/);
      requestedId = page.url().split('/').at(-1) ?? '';
      expect(requestedId).not.toBe(proposalId);
      await expect(page.locator('[data-replan-trigger]')).toHaveText('직접 요청');
      await expect(page.locator('[data-proposal-state]')).toHaveText('승인 대기');

      await page.locator('[data-replan-reject]').click();
      const dialog = page.getByRole('dialog', { name: '이 제안을 거절할까요?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('같은 이유(직접 요청)의 재계획 제안은 24시간 동안');
      await expect(dialog).toContainText('직접 요청하는 재계획도 그동안은 다시 요청할 수 없어요.');
      expect(await blockingAxeViolations(page)).toEqual([]);
      await dialog.getByRole('button', { name: '거절하기' }).click();
      await expect(dialog).toBeHidden();
      await expect(page.locator('[data-proposal-state]')).toHaveText('거절됨');
      expect((await listProposals(page)).find((item) => item.id === requestedId)?.state).toBe('rejected');
    });

    await test.step('asking again is replan_suppressed with Retry-After shown as a wait', async () => {
      const response = page.waitForResponse(
        (candidate) => candidate.request().method() === 'POST' && candidate.url().endsWith('/replan-proposals:request'),
      );
      // A settled proposal offers to ask again, at its end.
      await page.locator('[data-replan-again] [data-replan-request]').click();
      const suppressed = await response;
      expect(suppressed.status()).toBe(409);
      expect(((await suppressed.json()) as { code: string }).code).toBe('replan_suppressed');
      const retryAfter = Number(suppressed.headers()['retry-after']);
      expect(retryAfter).toBeGreaterThan(23 * 3600);
      expect(retryAfter).toBeLessThanOrEqual(24 * 3600);
      const status = page.locator('.replan-request-status');
      await expect(status).toContainText('지금은 재계획을 더 요청할 수 없어요.');
      await expect(status).toContainText(/(1일|23시간 \d+분|2[34]시간) 뒤\(\d{1,2}월 \d{1,2}일 \([월화수목금토일]\) 오[전후] \d{1,2}:\d{2}\)에 다시 요청할 수 있어요/);
      await expect(status).toContainText('거절한 이유는 24시간 동안 다시 제안하지 않고, 제안은 하루 2번까지예요.');
      expect(await blockingAxeViolations(page)).toEqual([]);

      // The API agrees without the UI: still suppressed, nothing new pending.
      const direct = await apiFetch(page, state, '/replan-proposals:request', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey() },
        body: { planId },
      });
      expect(direct.status()).toBe(409);
      expect(await listProposals(page, 'pending')).toHaveLength(0);
    });

    await test.step('the list beside the proposal shows the history; with nothing waiting 재계획 says so', async () => {
      const list = page.locator('[data-replan-list]');
      await expect(list.locator('.replan-item')).toHaveCount(2);
      await expect(list.locator(`[data-proposal-id="${proposalId}"]`)).toContainText('승인됨');
      await expect(list.locator(`[data-proposal-id="${requestedId}"]`)).toContainText('거절됨');
      await expect(list.locator(`[data-proposal-id="${requestedId}"] a`)).toHaveAttribute('aria-current', 'true');

      // A history row opens that proposal, read-only.
      await list.locator(`[data-proposal-id="${proposalId}"] a`).click();
      await page.waitForURL(new RegExp(`/replan/${proposalId}$`));
      await expect(page.locator('[data-proposal-state]')).toHaveText('승인됨');
      await expect(page.locator('[data-replan-approve]')).toHaveCount(0);
      await expect(page.locator('[data-replan-reject]')).toHaveCount(0);

      // `/replan` with nothing waiting: the plan is on track, and the history is still there.
      await page.goto(`${state.webUrl}/replan`);
      await expect(page.getByRole('heading', { name: '재계획', level: 1 })).toBeVisible();
      await expect(page.locator('[data-replan-none]')).toContainText('지금은 계획대로예요');
      await expect(page.locator('[data-replan-list] .replan-item')).toHaveCount(2);
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await context.close();
  });
});
