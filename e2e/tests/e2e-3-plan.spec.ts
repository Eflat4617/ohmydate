import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { login } from '../helpers/app';
import { installBrowserClock, testClock } from '../helpers/clock';
import {
  calendarBlockSelector,
  dateFromKoreanLabel,
  daysBetween,
  describeCandidates,
  describeEdit,
  findAvailabilityExitEdit,
  findFeasibleNudge,
  findOverlapEdit,
  instantMs,
  koreanDateLabel,
  localDate,
  sameBlock,
  weekStartOf,
  type EditContext,
  type EditableBlock,
  type KeyboardEdit,
  type TaskConstraints,
} from '../helpers/plan-edit';
import {
  apiFetch,
  createApprovedGoal,
  createOverlappingCommitment,
  expectOk,
  getAvailability,
  getTaskConstraints,
  listCommitmentIntervals,
  listScheduleBlockIntervals,
  setWeeklyAvailability,
  type PlanDto,
  type PreviewEditDto,
} from '../helpers/planner';
import { readState } from '../helpers/state';

const state = readState();
const clock = testClock(state);

/** A feasible edit must not move a block to before "now" plus this margin. */
const NOT_BEFORE_MARGIN_MS = 10 * 60 * 1000;
const PREVIEW_TIMEOUT_MS = 15_000;

function planIdFromUrl(url: string): string {
  const match = /\/plans\/([0-9a-f-]{36})/.exec(url);
  if (match?.[1] === undefined) throw new Error(`plan id missing from URL: ${url}`);
  return match[1];
}

async function loadPlan(page: Page, planId: string): Promise<PlanDto> {
  const response = await apiFetch(page, state, `/plans/${planId}`);
  return (await expectOk(response, 'GET /plans/{id}')) as PlanDto;
}

async function loadEditContext(page: Page, plan: PlanDto): Promise<EditContext> {
  const availability = await getAvailability(page, state);
  const [commitments, scheduled] = await Promise.all([
    listCommitmentIntervals(page, state, plan.horizon.start, plan.horizon.end),
    listScheduleBlockIntervals(page, state, plan.horizon.start, plan.horizon.end),
  ]);
  const taskIds = [
    ...new Set(plan.candidates.flatMap((candidate) => candidate.blocks.map((block) => block.taskId))),
  ];
  const tasks = new Map<string, TaskConstraints>();
  for (const taskId of taskIds) {
    tasks.set(taskId, await getTaskConstraints(page, state, taskId));
  }
  return {
    horizon: plan.horizon,
    timeZone: plan.timeZone,
    availability,
    occupied: [...commitments, ...scheduled],
    tasks,
    notBeforeMs: clock.nowMs() + NOT_BEFORE_MARGIN_MS,
  };
}

/** Resolves with the preview-edit result whose request carried `expected`. */
async function previewFor(page: Page, edit: KeyboardEdit): Promise<PreviewEditDto> {
  const response = await page.waitForResponse(
    (candidate) => {
      const request = candidate.request();
      if (request.method() !== 'POST') return false;
      if (!new URL(candidate.url()).pathname.endsWith(':preview-edit')) return false;
      const body = request.postDataJSON() as { blocks?: EditableBlock[] } | null;
      return sameBlock(body?.blocks?.[edit.blockIndex], edit.moved);
    },
    { timeout: PREVIEW_TIMEOUT_MS },
  );
  expect(response.status(), 'preview-edit status').toBe(200);
  return (await response.json()) as PreviewEditDto;
}

async function selectCandidate(page: Page, candidateIndex: number): Promise<void> {
  const button = page.locator('.candidate-card').nth(candidateIndex).locator('.candidate-button');
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

/** Navigate the week view until it shows the Monday-based week containing `date`. */
async function showWeekOf(page: Page, date: string): Promise<void> {
  const heading = page.locator('#calendar-title');
  const text = (await heading.textContent()) ?? '';
  const current = text.includes('주간 보기 · ') ? dateFromKoreanLabel(text) : undefined;
  if (current === undefined) throw new Error(`week heading not found: ${text}`);
  const target = weekStartOf(date);
  const weeks = daysBetween(current, target) / 7;
  const button = page.getByRole('button', { name: weeks > 0 ? '다음 주' : '이전 주' });
  for (let step = 0; step < Math.abs(weeks); step += 1) await button.click();
  await expect(heading).toContainText(`주간 보기 · ${koreanDateLabel(target, true)}`);
}

/**
 * Focus the rendered block, press the edit's key, and wait for the preview of
 * exactly the edited state (no fixed sleep). Keyboard focus stays on the same
 * button because every edit keeps the block on its calendar column.
 */
async function applyKeyboardEdit(
  page: Page,
  edit: KeyboardEdit,
  timeZone: string,
): Promise<PreviewEditDto> {
  await selectCandidate(page, edit.candidateIndex);
  await showWeekOf(page, localDate(edit.original.startAt, timeZone));
  const target = page.locator(calendarBlockSelector(edit.original, timeZone));
  await expect(target).toHaveCount(1);
  await target.focus();
  const preview = previewFor(page, edit);
  for (let press = 0; press < edit.presses; press += 1) await page.keyboard.press(edit.key);
  const result = await preview;
  await expect(page.locator(calendarBlockSelector(edit.moved, timeZone))).toHaveCount(1);
  await expect(page.locator('.violation-region').getByText('편집 내용을 확인하는 중…')).toBeHidden();
  return result;
}

async function resetEdits(page: Page): Promise<void> {
  await page.getByRole('button', { name: '편집 되돌리기' }).click();
  await expect(page.locator('.violation-list li')).toHaveCount(0);
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
    await installBrowserClock(contextA, clock);
    const pageA = await contextA.newPage();
    await login(pageA, state);

    await setWeeklyAvailability(pageA, state);
    const goal = await createApprovedGoal(pageA, state, `E2E plan goal ${suffix}`, {
      estimatedScope: 'large',
      independentDraft: true,
      nowMs: clock.nowMs(),
    });
    if (goal.goalId === undefined) throw new Error('approved goal id is missing');

    await pageA.goto(`${state.webUrl}/plans/new?goalId=${goal.goalId}`);
    const generatedAtMs = clock.nowMs();
    await pageA.getByRole('button', { name: '후보 만들기' }).click();
    await pageA.waitForURL(/\/plans\/[0-9a-f-]{36}$/);
    const planId = planIdFromUrl(pageA.url());

    await expect(pageA.locator('.candidate-card')).toHaveCount(3);
    await expect(pageA.getByRole('heading', { name: /^일정안 비교$/ })).toBeVisible();

    expect(await blockingAxeViolations(pageA)).toEqual([]);

    const generated = await loadPlan(pageA, planId);
    const timeZone = generated.timeZone;
    const schedule = describeCandidates(generated.candidates, timeZone);
    test.info().annotations.push({
      type: 'clock',
      description: `${new Date(generatedAtMs).toISOString()} (offset ${clock.offsetMs} ms)`,
    });
    test.info().annotations.push({ type: 'schedule', description: schedule });
    for (const candidate of generated.candidates) {
      for (const block of candidate.blocks) {
        // Sanity for the simulated clock: the API generated from the same "now".
        expect(instantMs(block.startAt), `block starts before generation time\n${schedule}`)
          .toBeGreaterThanOrEqual(generatedAtMs - 60_000);
      }
    }
    const editContext = await loadEditContext(pageA, generated);

    // Negative path 1: pushing a block across its availability window edge → H2.
    const exitEdit = findAvailabilityExitEdit(generated.candidates, editContext);
    if (exitEdit === null) throw new Error(`no block can leave its window:\n${schedule}`);
    test.info().annotations.push({ type: 'edit:H2', description: describeEdit(exitEdit, timeZone) });
    const exitPreview = await applyKeyboardEdit(pageA, exitEdit, timeZone);
    expect(exitPreview.feasible).toBe(false);
    expect(exitPreview.violations.map((violation) => violation.code)).toContain('H2');
    await expect(pageA.locator('.violation-list li').filter({ hasText: 'H2' }).first()).toBeVisible();
    await resetEdits(pageA);

    // Negative path 2: sliding a block into its same-day neighbour → H1.
    const overlapEdit = findOverlapEdit(generated.candidates, timeZone, generated.horizon);
    if (overlapEdit === null) throw new Error(`no same-day block pair to overlap:\n${schedule}`);
    test.info().annotations.push({ type: 'edit:H1', description: describeEdit(overlapEdit, timeZone) });
    const overlapPreview = await applyKeyboardEdit(pageA, overlapEdit, timeZone);
    expect(overlapPreview.feasible).toBe(false);
    expect(overlapPreview.violations.map((violation) => violation.code)).toContain('H1');
    await expect(pageA.locator('.violation-list li').filter({ hasText: 'H1' }).first()).toBeVisible();
    await resetEdits(pageA);

    // Positive path: a single 5-minute move into space the rendered schedule leaves free.
    const nudge = findFeasibleNudge(generated.candidates, editContext);
    if (nudge === null) throw new Error(`no block has 5 free minutes on either side:\n${schedule}`);
    test.info().annotations.push({ type: 'edit:feasible', description: describeEdit(nudge, timeZone) });
    const editedCandidate = generated.candidates[nudge.candidateIndex];
    if (editedCandidate === undefined) throw new Error('edited candidate is missing');
    const firstBlock = editedCandidate.blocks[0];
    if (firstBlock === undefined) throw new Error('generated plan has no blocks to edit');
    const nudgePreview = await applyKeyboardEdit(pageA, nudge, timeZone);
    expect(
      { feasible: nudgePreview.feasible, violations: nudgePreview.violations },
      `a small keyboard edit should remain feasible: ${describeEdit(nudge, timeZone)}\n${schedule}`,
    ).toEqual({ feasible: true, violations: [] });
    await expect(pageA.locator('.violation-list li')).toHaveCount(0);

    const approveRequest = pageA.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname.endsWith(':approve'),
    );
    const firstApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.getByRole('button', { name: '이 일정으로 확정' }).click();
    const editedRequest = (await approveRequest).postDataJSON() as {
      editedBlocks?: readonly { taskId: string; startAt: string; endAt: string }[];
    };
    if (editedRequest.editedBlocks === undefined) throw new Error('expected editedBlocks');
    const changedBlock = editedRequest.editedBlocks.find(
      (edited) =>
        !editedCandidate.blocks.some(
          (original) =>
            original.taskId === edited.taskId &&
            original.startAt === edited.startAt &&
            original.endAt === edited.endAt,
        ),
    );
    if (changedBlock === undefined) throw new Error('keyboard edit did not change a block');
    expect(sameBlock(changedBlock, nudge.moved), 'approved edit is the previewed nudge').toBe(true);

    const firstResponse = await firstApproval;
    expect(firstResponse.status()).toBe(201);
    const approvedVersion = (await firstResponse.json()) as {
      id: string;
      blocks: readonly { taskId: string; startAt: string; endAt: string }[];
    };
    expect(
      approvedVersion.blocks.some(
        (block) =>
          block.taskId === changedBlock.taskId &&
          block.startAt === changedBlock.startAt &&
          block.endAt === changedBlock.endAt,
      ),
    ).toBe(true);
    await expect(pageA.getByRole('heading', { name: '일정 확정 완료' })).toBeVisible();

    const persisted = await loadPlan(pageA, planId);
    expect(persisted.currentVersionId).toBe(approvedVersion.id);
    expect(persisted.version).toBeGreaterThan(generated.version);

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
    await pageA.getByRole('button', { name: '이 일정으로 확정' }).click();
    expect((await staleApproval).status()).toBe(412);
    const conflictPanel = pageA
      .getByRole('alert')
      .filter({ hasText: '다른 곳에서 가용 시간이 바뀌었어요' });
    await expect(conflictPanel).toBeVisible();

    const regenerate = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':regenerate'),
    );
    await conflictPanel.getByRole('button', { name: '일정안 다시 만들기' }).click();
    expect((await regenerate).status()).toBe(201);
    await expect(pageA.getByText('최신 가용 시간으로 일정안을 다시 만들었어요.')).toBeVisible();
    await expect(pageA.getByRole('heading', { name: '일정 확정 완료' })).toBeHidden();

    const secondApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.getByRole('button', { name: '이 일정으로 확정' }).click();
    expect((await secondApproval).status()).toBe(201);
    await expect(pageA.getByRole('heading', { name: '일정 확정 완료' })).toBeVisible();

    await contextA.close();
  });
});
