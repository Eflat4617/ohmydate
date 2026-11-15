import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { login } from '../helpers/app';
import { installBrowserClock, testClock } from '../helpers/clock';
import {
  calendarBlockSelector,
  daysBetween,
  describeCandidates,
  describeEdit,
  findAvailabilityExitEdit,
  findFeasibleNudge,
  findOverlapEdit,
  instantMs,
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
  const match = /\/plan\/schedule\/([0-9a-f-]{36})/.exec(url);
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

/** HOLO-03A: the three schedules are a radio group of cards. */
async function selectCandidate(page: Page, candidateIndex: number): Promise<void> {
  const radio = page.locator('.plan-option').nth(candidateIndex).locator('input[type="radio"]');
  if (!(await radio.isChecked())) await radio.check({ force: true });
  await expect(radio).toBeChecked();
}

/** Navigate the week grid until it shows the Monday-based week containing `date`. */
async function showWeekOf(page: Page, date: string): Promise<void> {
  const week = page.locator('section.plan-week');
  const current = await week.getAttribute('data-week-start');
  if (current === null || !/^\d{4}-\d{2}-\d{2}$/.test(current)) throw new Error(`week start not found: ${current}`);
  const target = weekStartOf(date);
  const weeks = daysBetween(current, target) / 7;
  const button = page.locator(weeks > 0 ? '[data-plan-week-next]' : '[data-plan-week-previous]');
  for (let step = 0; step < Math.abs(weeks); step += 1) await button.click();
  await expect(week).toHaveAttribute('data-week-start', target);
}

/**
 * Focus the rendered block, press the edit's key, and wait for the preview of
 * exactly the edited state (no fixed sleep). Keyboard focus stays on the same
 * button because every edit keeps the block on its calendar column. On the
 * week grid a plain arrow walks between items; Alt+arrow moves a block of the
 * schedule being chosen by five minutes.
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
  for (let press = 0; press < edit.presses; press += 1) await page.keyboard.press(`Alt+${edit.key}`);
  const result = await preview;
  await expect(page.locator(calendarBlockSelector(edit.moved, timeZone))).toHaveCount(1);
  await expect(page.locator('[data-plan-draft-state]')).toHaveText('고친 일정안');
  await expect(page.locator('[data-plan-problems]').getByText('고친 내용을 확인하는 중…')).toBeHidden();
  return result;
}

async function resetEdits(page: Page): Promise<void> {
  await page.locator('[data-plan-reset]').click();
  await expect(page.locator('[data-plan-violations]')).toHaveCount(0);
  await expect(page.locator('[data-plan-draft-state]')).toHaveText('만들어진 그대로');
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

test.describe('E2E-3 — 일정안 (compare, edit on the grid, confirm) and stale-availability approval', () => {
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
    const goalTitle = `E2E plan goal ${suffix}`;
    const goal = await createApprovedGoal(pageA, state, goalTitle, {
      estimatedScope: 'large',
      independentDraft: true,
      nowMs: clock.nowMs(),
    });
    if (goal.goalId === undefined) throw new Error('approved goal id is missing');

    // FU-98: the plain picker shows this just-approved plan as the first,
    // expanded folder, and one "모두 선택" picks every one of its tasks.
    // (The old address `/plans/new` leads to the same stage of the flow.)
    await pageA.goto(`${state.webUrl}/plans/new`);
    await pageA.waitForURL(/\/plan\/schedule$/);
    await expect(pageA.locator('[data-plan-rail] [data-stage="schedule"]')).toHaveAttribute('data-state', 'current');
    const folder = pageA.locator(`[data-group-key="goal:${goal.goalId}"]`);
    await expect(folder).toBeVisible();
    await expect(pageA.locator('.picker-group').first()).toHaveAttribute('data-group-key', `goal:${goal.goalId}`);
    await expect(folder.getByRole('button', { name: new RegExp(goalTitle) })).toHaveAttribute('aria-expanded', 'true');
    const selectAll = folder.getByRole('checkbox', { name: `${goalTitle} 작업 모두 선택` });
    const folderTasks = folder.locator('.task-picker input[type="checkbox"]');
    const folderTaskCount = await folderTasks.count();
    expect(folderTaskCount, 'the approved plan has open tasks in its folder').toBeGreaterThan(1);
    await selectAll.check();
    for (let index = 0; index < folderTaskCount; index += 1) await expect(folderTasks.nth(index)).toBeChecked();
    await expect(pageA.locator('[data-scope-summary]')).toHaveText(`작업 ${folderTaskCount}개 선택 (계획 1개)`);
    await folderTasks.first().uncheck();
    await expect(selectAll).not.toBeChecked();
    expect(await selectAll.evaluate((input) => (input as HTMLInputElement).indeterminate)).toBe(true);
    await selectAll.check();
    await expect(pageA.locator('[data-scope-summary]')).toHaveText(`작업 ${folderTaskCount}개 선택 (계획 1개)`);
    expect(await blockingAxeViolations(pageA)).toEqual([]);

    // The flow accepts what came before: a goal in the address is already the scope.
    await pageA.goto(`${state.webUrl}/plan/schedule?goalId=${goal.goalId}`);
    await expect(pageA.locator('[data-scope-summary]')).toContainText(`계획 「${goalTitle}」`);
    await expect(pageA.locator('[data-scope-list] li')).toHaveCount(folderTaskCount);
    // Hours to plan within exist, so the flow does not ask for them again.
    await expect(pageA.locator('[data-plan-hours]')).toHaveCount(0);
    const generatedAtMs = clock.nowMs();
    await pageA.locator('[data-plan-create]').click();
    await pageA.waitForURL(/\/plan\/schedule\/[0-9a-f-]{36}/);
    const planId = planIdFromUrl(pageA.url());

    await expect(pageA.locator('.plan-option')).toHaveCount(3);
    await expect(pageA.locator('[data-plan-title]')).toBeVisible();
    // One filled button on the screen, and it is the next step.
    await expect(pageA.locator('.plan-page .btn--primary')).toHaveCount(1);
    await expect(pageA.locator('[data-plan-approve]')).toHaveText('이 일정으로 확정');
    // What is not confirmed never looks confirmed: the picked schedule is drawn as proposals.
    await expect(pageA.locator('.wg-item[data-kind="proposal"]').first()).toBeVisible();

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
    // The finding is said in words; its code stays as data.
    await expect(pageA.locator('[data-plan-violations] li[data-code="H2"]').first()).toBeVisible();
    await resetEdits(pageA);

    // Negative path 2: sliding a block into its same-day neighbour → H1.
    const overlapEdit = findOverlapEdit(generated.candidates, timeZone, generated.horizon);
    if (overlapEdit === null) throw new Error(`no same-day block pair to overlap:\n${schedule}`);
    test.info().annotations.push({ type: 'edit:H1', description: describeEdit(overlapEdit, timeZone) });
    const overlapPreview = await applyKeyboardEdit(pageA, overlapEdit, timeZone);
    expect(overlapPreview.feasible).toBe(false);
    expect(overlapPreview.violations.map((violation) => violation.code)).toContain('H1');
    await expect(pageA.locator('[data-plan-violations] li[data-code="H1"]').first()).toBeVisible();
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
    await expect(pageA.locator('[data-plan-violations]')).toHaveCount(0);
    await expect(pageA.locator('[data-plan-valid]')).toBeVisible();

    const approveRequest = pageA.waitForRequest(
      (request) =>
        request.method() === 'POST' && new URL(request.url()).pathname.endsWith(':approve'),
    );
    const firstApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.locator('[data-plan-approve]').click();
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
    // The hand-off: confirmed, with the next step of the loop as the one filled control.
    const next = pageA.locator('[data-plan-next]');
    await expect(next).toBeVisible();
    await expect(pageA.locator('[data-plan-rail] [data-stage="confirmed"]')).toHaveAttribute('data-state', 'done');
    await expect(next.locator('[data-plan-next-primary]')).toHaveCount(1);
    await expect(pageA.locator('.plan-page .btn--primary')).toHaveCount(1);
    // Confirmed blocks are drawn as blocks: no proposal is left on the grid.
    await expect(pageA.locator('.wg-item[data-kind="proposal"]')).toHaveCount(0);

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

    // Choosing again from the confirmed plan goes back to the three schedules.
    await pageA.locator('[data-plan-choose]').click();
    await expect(pageA.locator('.plan-option')).toHaveCount(3);
    await expect(next).toBeHidden();

    const staleApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.locator('[data-plan-approve]').click();
    expect((await staleApproval).status()).toBe(412);
    const conflictPanel = pageA.locator('[data-plan-stale]');
    await expect(conflictPanel).toBeVisible();
    await expect(conflictPanel).toHaveAttribute('role', 'alert');
    await expect(conflictPanel).toContainText('그사이 가용 시간이나 약속이 바뀌었어요.');
    // A stale schedule cannot be confirmed: making it again is the one way on.
    await expect(pageA.locator('[data-plan-approve]')).toHaveCount(0);

    const regenerate = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':regenerate'),
    );
    await pageA.locator('[data-plan-regenerate]').click();
    expect((await regenerate).status()).toBe(201);
    await expect(pageA.locator('[data-plan-status]')).toHaveText('지금 가용 시간과 약속으로 일정안을 다시 만들었어요.');
    await expect(conflictPanel).toHaveCount(0);
    await expect(next).toBeHidden();

    const secondApproval = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(':approve'),
    );
    await pageA.locator('[data-plan-approve]').click();
    expect((await secondApproval).status()).toBe(201);
    await expect(next).toBeVisible();

    await contextA.close();
  });
});
