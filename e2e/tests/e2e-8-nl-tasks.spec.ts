import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { agentRunStatuses } from '../helpers/db';
import { fetchPlannerTasks, login, waitForPlannerTask } from '../helpers/app';
import { readState } from '../helpers/state';

/**
 * CAL-05 E2E — 인박스 "말로 적기" against the real API with the fake provider.
 *
 * The AI-wait owner's fake AI (`LLM_FAKE_SCRIPTED_OWNERS`) answers after
 * `aiWaitLatencyMs` (~5 s) with the deterministic task_parse reader
 * (services/api/src/adapters/fake-task-parse.ts): the note goes through
 * POST /tasks:parse (agent_run task_parse), the draft is added through the
 * quick add's POST /tasks and shows up in the inbox with its 마감.
 */

const state = readState();
const account = { email: state.aiWaitEmail, password: state.aiWaitPassword };

async function blockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }));
}

test.describe('E2E-8 — 할 일을 말로 적기 (CAL-05)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('types a note, waits for the read, adds the draft and sees it in the inbox with its 마감', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse');

    const title = `보고서 초안 E${Date.now().toString(36)}`;
    await page.goto(`${state.webUrl}/tasks`);
    // HOLO-02: 말로 적기 is folded under one disclosure below the quick add.
    await expect(page.getByRole('heading', { name: '말로 적기' })).toBeHidden();
    await page.getByText('말로 여러 개 적기', { exact: true }).click();
    await expect(page.getByRole('heading', { name: '말로 적기' })).toBeVisible();
    await page.getByLabel('할 일 메모').fill(`내일까지 ${title}, 요즘 너무 피곤하다`);
    await page.getByRole('button', { name: '읽기' }).click();

    const wait = page.getByTestId('task-parse-wait');
    await expect(wait).toContainText('AI가 메모를 읽고 있어요');
    const result = page.getByTestId('task-parse-result');
    await expect(result).toBeVisible({ timeout: state.aiWaitLatencyMs + 20_000 });
    await expect(wait).toHaveCount(0);
    await expect(page.locator('#task-parse-result-heading')).toBeFocused();

    const draft = page.getByTestId('task-draft');
    await expect(draft).toHaveCount(1);
    await expect(draft.getByLabel('할 일 제목')).toHaveValue(title);
    await expect(draft.getByTestId('task-draft-due')).toHaveText(/^마감 \d+월 \d+일 \(.\) 오후 11:59$/);
    await expect(draft).toContainText('시간이 없어 그날 밤 11시 59분까지로 잡았어요.');
    await expect(result.locator('.nl-leftover')).toHaveText('읽지 못한 부분: 요즘 너무 피곤하다');
    // The read saved nothing yet.
    const listed = page.locator('li.task-item').filter({ hasText: title });
    await expect(listed).toHaveCount(0);
    expect(await blockingAxeViolations(page)).toEqual([]);

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/v1/tasks'),
    );
    await draft.getByRole('button', { name: `${title} 추가` }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(Object.keys(response.request().postDataJSON() as Record<string, unknown>).sort()).toEqual(['dueAt', 'title']);
    await expect(draft).toContainText('추가했어요');
    await expect(listed).toHaveCount(1);
    await expect(listed.getByTestId('task-due')).toHaveText(/^마감 \d+월 \d+일 \(.\) 오후 11:59$/);

    const runs = await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse');
    expect(runs.slice(before.length)).toEqual(['succeeded']);

    // Leave the owner as it was: delete the task the test added (after the undo window).
    const deleted = page.waitForResponse(
      (candidate) => candidate.request().method() === 'DELETE' && new URL(candidate.url()).pathname.includes('/api/v1/tasks/'),
      { timeout: 30_000 },
    );
    await listed.getByRole('button', { name: `${title} 삭제` }).click();
    expect((await deleted).status()).toBe(204);
    await expect(listed).toHaveCount(0);
    await context.close();
  });

  test('the quick add stays the one-line fast path next to 말로 적기 (no read)', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse');
    await page.goto(`${state.webUrl}/tasks`);
    const title = `빠른 추가 E${Date.now().toString(36)}`;
    await page.getByLabel('작업 빠르게 추가').fill(title);
    await page.getByLabel('작업 빠르게 추가').press('Enter');
    const listed = page.locator('li.task-item').filter({ hasText: title });
    await expect(listed).toHaveCount(1);
    await expect(listed.getByTestId('task-due')).toHaveCount(0);
    expect((await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse')).length).toBe(before.length);
    const deleted = page.waitForResponse(
      (candidate) => candidate.request().method() === 'DELETE' && new URL(candidate.url()).pathname.includes('/api/v1/tasks/'),
      { timeout: 30_000 },
    );
    await listed.getByRole('button', { name: `${title} 삭제` }).click();
    expect((await deleted).status()).toBe(204);
    await context.close();
  });

  test('담기 줄 (HOLO-04): one line is read as a to-do, saved only on 담기, and handed to 계획', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse');
    const title = `발표 준비 E${Date.now().toString(36)}`;

    // From 개요, where the app opens: the bar is on every screen.
    const bar = page.locator('.app-topbar [data-capture]');
    const input = bar.locator('[data-capture-input]');
    await input.click();
    await input.fill(`내일까지 ${title}`);
    await input.press('Enter');
    await expect(bar.locator('[data-capture-wait]')).toBeVisible();
    const row = bar.locator('[data-capture-row="task"]');
    await expect(row).toHaveCount(1, { timeout: state.aiWaitLatencyMs + 20_000 });
    await expect(bar.locator('[data-capture-wait]')).toHaveCount(0);
    await expect(row.locator('[data-capture-when]')).toContainText('오후 11:59');
    // The read saved nothing: it is a proposal until the owner says 담기 (negative).
    expect((await fetchPlannerTasks(page, state)).some((task) => task.title === title)).toBe(false);
    expect(await blockingAxeViolations(page)).toEqual([]);

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/v1/tasks'),
    );
    await bar.locator('[data-capture-submit]').click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect(Object.keys(response.request().postDataJSON() as Record<string, unknown>).sort()).toEqual(['dueAt', 'title']);
    await expect(bar.locator('[data-capture-done]')).toContainText(title);
    const task = await waitForPlannerTask(page, state, title);
    expect((await agentRunStatuses(state, state.aiWaitOwnerId, 'task_parse')).slice(before.length)).toEqual(['succeeded']);

    // The hand-off: 계획에 넣기 opens the plan flow with what was just put down picked.
    await bar.locator('[data-capture-next="plan"]').click();
    await expect(page).toHaveURL(new RegExp(`/plan/schedule\\?taskIds=${task.id}`));

    // Leave the owner as it was.
    await page.goto(`${state.webUrl}/tasks`);
    const listed = page.locator('li.task-item').filter({ hasText: title });
    await expect(listed).toHaveCount(1);
    const deleted = page.waitForResponse(
      (candidate) => candidate.request().method() === 'DELETE' && new URL(candidate.url()).pathname.includes('/api/v1/tasks/'),
      { timeout: 30_000 },
    );
    await listed.getByRole('button', { name: `${title} 삭제` }).click();
    expect((await deleted).status()).toBe(204);
    await context.close();
  });
});
