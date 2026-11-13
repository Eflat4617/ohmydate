import AxeBuilder from '@axe-core/playwright';
import { type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { agentRunStatuses } from '../helpers/db';
import { login } from '../helpers/app';
import { readState } from '../helpers/state';

/**
 * CAL-02 E2E — 약속 "말로 적기" against the real API with the fake provider.
 *
 * The AI-wait owner's fake AI (`LLM_FAKE_SCRIPTED_OWNERS`) answers after
 * `aiWaitLatencyMs` (~5 s) with the deterministic commitment_parse reader
 * (services/api/src/adapters/fake-commitment-parse.ts), so the wait state,
 * the cancel and the read -> add -> list path run end to end: the note goes
 * through POST /commitments:parse (agent_run commitment_parse), the draft is
 * added through POST /commitments and shows up in the list.
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

/** Widen the list to a few days around today, whatever weekday the run is on. */
async function showComingDays(page: Page): Promise<void> {
  const [from, to] = await page.evaluate(() => {
    const iso = (offset: number): string => {
      const date = new Date();
      date.setDate(date.getDate() + offset);
      const pad = (value: number): string => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    };
    return [iso(-2), iso(9)];
  });
  await page.locator('#commitment-from').fill(from);
  await page.locator('#commitment-from').dispatchEvent('change');
  await page.locator('#commitment-to').fill(to);
  await page.locator('#commitment-to').dispatchEvent('change');
}

test.describe('E2E-7 — 약속을 말로 적기 (CAL-02)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  test('types a note, waits for the read, adds the draft and sees it in the list', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'commitment_parse');

    const tag = `E2E${Date.now().toString(36)}`;
    const title = `치과 ${tag}`;
    await page.goto(`${state.webUrl}/commitments`);
    await expect(page.getByRole('heading', { name: '말로 적기' })).toBeVisible();
    await showComingDays(page);
    await page.getByLabel('약속 메모').fill(`내일 오후 3시에 ${title}, 보고서 쓰기`);
    await page.getByRole('button', { name: '읽기' }).click();

    const wait = page.getByTestId('nl-wait');
    await expect(wait).toContainText('AI가 메모를 읽고 있어요');
    const result = page.getByTestId('nl-result');
    await expect(result).toBeVisible({ timeout: state.aiWaitLatencyMs + 20_000 });
    await expect(wait).toHaveCount(0);
    await expect(page.locator('#nl-result-heading')).toBeFocused();

    const draft = page.getByTestId('nl-draft').filter({ hasText: title });
    await expect(draft).toHaveCount(1);
    await expect(draft).toContainText('오후 3:00');
    await expect(draft).toContainText('끝 시간을 1시간 뒤로 잡았어요.');
    await expect(page.locator('.nl-leftover')).toHaveText('읽지 못한 부분: 보고서 쓰기');
    // The read saved nothing yet (an empty list shows its empty state instead of rows).
    const listed = page.locator('li.commitment-item').filter({ hasText: title });
    await expect(listed).toHaveCount(0);
    expect(await blockingAxeViolations(page)).toEqual([]);

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/v1/commitments'),
    );
    await draft.getByRole('button', { name: `${title} 추가` }).click();
    expect((await created).status()).toBe(201);
    await expect(draft).toContainText('추가했어요');
    await expect(listed).toHaveCount(1);

    const runs = await agentRunStatuses(state, state.aiWaitOwnerId, 'commitment_parse');
    expect(runs.slice(before.length)).toEqual(['succeeded']);

    // Leave the owner as it was: remove the commitment the test added.
    await listed.getByRole('button', { name: `${title} 삭제` }).click();
    await expect(listed).toHaveCount(0);
    await context.close();
  });

  test('취소 during the read keeps the note, and the server run is cancelled', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, state, account);
    const before = await agentRunStatuses(state, state.aiWaitOwnerId, 'commitment_parse');

    await page.goto(`${state.webUrl}/commitments`);
    const note = '다음 주 화요일 오후 3시에 치과';
    await page.getByLabel('약속 메모').fill(note);
    await page.getByRole('button', { name: '읽기' }).click();
    const wait = page.getByTestId('nl-wait');
    await expect(wait).toBeVisible();
    await wait.getByRole('button', { name: '취소' }).click();
    await expect(wait).toHaveCount(0);
    await expect(page.getByTestId('nl-entry').getByRole('status')).toHaveText('읽기를 멈췄어요. 메모는 그대로 있어요.');
    await expect(page.getByLabel('약속 메모')).toHaveValue(note);
    await expect(page.getByTestId('nl-result')).toHaveCount(0);

    await expect
      .poll(async () => (await agentRunStatuses(state, state.aiWaitOwnerId, 'commitment_parse')).slice(before.length), {
        timeout: 15_000,
      })
      .toEqual(['cancelled']);
    await context.close();
  });
});
