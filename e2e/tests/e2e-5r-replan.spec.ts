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
 *    the first block in the UI (the plan page's approved schedule, FU-71:
 *    `POST /schedule-blocks/{id}:lock`) and add a commitment over the second
 *    block.
 * 2. The leader-only detection sweep (05 §11, every 5 min) creates exactly one
 *    commitment_conflict proposal; Today and the notifications surface it.
 * 3. Approving it in the UI moves only the overlapped block; the locked block
 *    keeps its row and times, the others keep their times.
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

async function blockingAxeViolations(page: Page) {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
  });
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

/**
 * FU-71: lock a block the way a user does — the plan page's approved schedule,
 * paging forward to the block's week when the plan starts in an earlier one.
 */
async function lockInUi(page: Page, planId: string, block: ApprovedBlockDto): Promise<void> {
  const weekRead = () =>
    page.waitForResponse(
      (candidate) => candidate.request().method() === 'GET' && candidate.url().includes('/schedule-blocks?'),
    );
  let read = weekRead();
  await page.goto(`${state.webUrl}/plans/${planId}`);
  await expect(page.getByRole('heading', { name: '일정안 비교', level: 1 })).toBeVisible();
  const row = page.locator(`[data-approved-block-id="${block.id}"]`);
  for (let week = 0; week < 3; week += 1) {
    await read;
    const shown = await row.waitFor({ state: 'visible', timeout: 3_000 }).then(
      () => true,
      () => false,
    );
    if (shown) break;
    read = weekRead();
    await page.getByRole('button', { name: '다음 주' }).click();
  }
  await expect(row).toBeVisible();
  const toggle = row.getByRole('button', { name: '블록 고정', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // FU-86: the row's task title and time describe the toggle, so rows differ for a screen reader.
  const title = (await row.locator('.approved-schedule-title').innerText()).trim();
  expect(title.length).toBeGreaterThan(0);
  await expect(toggle).toHaveAccessibleDescription(new RegExp(`^${escapeRegExp(title)} .*\\d{1,2}:\\d{2}`));
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === 'POST' && candidate.url().endsWith(`/schedule-blocks/${block.id}:lock`),
  );
  await toggle.focus();
  await page.keyboard.press('Enter');
  const locked = await response;
  expect(locked.status()).toBe(200);
  const headers = locked.request().headers();
  expect(headers['if-match']).toBe(`W/"${block.version}"`);
  expect(headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  // FU-86: the same button, now pressed; its name does not change with the state.
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAccessibleName('블록 고정');
  await expect(toggle).toBeEnabled();
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

    await test.step('Today shows one calm banner and the notifications link to it', async () => {
      await page.goto(`${state.webUrl}/today`);
      await expect(page.getByRole('heading', { name: '오늘', exact: true })).toBeVisible();
      const banner = page.locator('[data-replan-banner]');
      await expect(banner).toHaveCount(1);
      await expect(banner).toContainText('재계획 제안 1개가 기다리고 있어요');
      await expect(banner).toContainText('약속과 겹치는 블록이 있어요');
      expect(await blockingAxeViolations(page)).toEqual([]);

      await page.locator('.nav-rail').getByRole('button', { name: '알림' }).click();
      const panel = page.getByRole('dialog', { name: '알림' });
      await expect(panel.locator('[data-open-proposal]')).toHaveCount(1);
      await expect(panel.locator('[data-open-proposal]')).toHaveAttribute('href', `/replan/${proposalId}`);
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await banner.getByRole('link', { name: '제안 확인하기' }).click();
      await page.waitForURL(new RegExp(`/replan/${proposalId}$`));
    });

    // ── 3. The diff shows only the moved block; approval applies only it ──
    await test.step('the detail screen lists only the changed block and the locked block as unchanged', async () => {
      await expect(page.getByRole('heading', { name: '약속과 겹침', level: 1 })).toBeVisible();
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
      await expect(page.locator('[data-metric="slack"] td')).toHaveCount(2);
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
      await page.goto(`${state.webUrl}/today`);
      await expect(page.getByRole('heading', { name: '오늘', exact: true })).toBeVisible();
      await expect(page.locator('[data-replan-banner]')).toHaveCount(0);
      await page.locator('[data-replan-request]').click();
      await page.waitForURL(/\/replan\/[0-9a-f-]{36}$/);
      requestedId = page.url().split('/').at(-1) ?? '';
      expect(requestedId).not.toBe(proposalId);
      await expect(page.getByRole('heading', { name: '직접 요청', level: 1 })).toBeVisible();
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
      await page.locator('[data-replan-request]').click();
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

    await test.step('the replan list shows the history read-only', async () => {
      await page.locator('.breadcrumb a').click();
      await expect(page.getByRole('heading', { name: '재계획 제안', level: 1 })).toBeVisible();
      await expect(page.locator('.replan-item')).toHaveCount(2);
      await expect(page.locator(`[data-proposal-id="${proposalId}"]`)).toContainText('승인됨');
      await expect(page.locator(`[data-proposal-id="${requestedId}"]`)).toContainText('거절됨');
      expect(await blockingAxeViolations(page)).toEqual([]);
    });

    await context.close();
  });
});
