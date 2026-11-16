import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { driver, login } from '../helpers/app';
import { apiFetch, expectOk, getAvailability, idempotencyKey, type AvailabilityDto } from '../helpers/planner';
import { readState } from '../helpers/state';

/**
 * E2E-10 — available hours and 약속, by hand, on the real stack (RC-20).
 *
 * The three places a person sets them, walked the way a person does:
 *
 * 1. the start guide (FLOW.md §3) — "언제 일할 수 있나요?" and "고정된 일정이
 *    있나요?", its first two steps;
 * 2. 설정 › 가용 시간 — what the guide saved is there, a change is saved,
 *    and a change made elsewhere meanwhile is told, not overwritten;
 * 3. 플래너 › 목록 — a 약속 is added by hand as a weekly one, shows up in the
 *    weeks its rule gives, is renamed in its own dialog and deleted.
 *
 * Nothing here needs the AI: 약속 "말로 적기" is E2E-7's. The tests run in
 * order on one owner and leave its hours as they found them.
 */

const state = readState();
const account = { email: state.email, password: state.password };
const tag = `E2E10 ${Date.now().toString(36)}`;

const DAY_MS = 86_400_000;
/** The five weekday evenings of the start guide's first preset. */
const WEEKDAY_EVENINGS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startLocal: '19:00',
  endLocal: '22:00',
  kind: 'work',
}));

interface CommitmentDto {
  readonly id: string;
  readonly title: string;
  readonly rrule?: string;
  readonly source: string;
  readonly version: number;
  readonly occurrences?: readonly { readonly startAt: string; readonly endAt: string }[];
}

async function blockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) }));
}

/** Replaces the hours through the API, as another device would. */
async function putHours(page: Page, hours: Omit<AvailabilityDto, 'version'>, version: number): Promise<AvailabilityDto> {
  const response = await apiFetch(page, state, '/availability', {
    method: 'PUT',
    headers: { 'If-Match': `W/"availability:${version}"`, 'Idempotency-Key': idempotencyKey() },
    body: { timeZone: hours.timeZone, rules: hours.rules, exceptions: hours.exceptions, prefs: hours.prefs },
  });
  return (await expectOk(response, 'PUT /availability')) as AvailabilityDto;
}

/** The 약속 the API lists for the `days` days from the start of the minute. */
async function commitmentsAhead(page: Page, days: number): Promise<readonly CommitmentDto[]> {
  const from = Math.floor(Date.now() / 60_000) * 60_000;
  const query = `from=${new Date(from).toISOString()}&to=${new Date(from + days * DAY_MS).toISOString()}&limit=100`;
  const body = (await expectOk(await apiFetch(page, state, `/commitments?${query}`), 'GET /commitments')) as {
    items: CommitmentDto[];
  };
  return body.items;
}

/** `YYYY-MM-DD`, `days` after today (UTC — the owner's zone and the browser's). */
function day(days: number): string {
  return new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
}

/** RFC 5545 code of a day's weekday, as the dialog's weekday boxes are named. */
function weekdayCode(date: string): string {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${date}T00:00:00Z`).getUTCDay()] ?? 'MO';
}

/** Fills the hand-entry form of the 약속 dialog and saves it; resolves with the answer's status. */
async function addByHand(page: Page, dialog: Locator, title: string, date: string, repeatOn?: string): Promise<number> {
  await dialog.locator('#planner-commitment-title').fill(title);
  await dialog.locator('#planner-commitment-start').fill(`${date}T15:00`);
  await dialog.locator('#planner-commitment-end').fill(`${date}T16:00`);
  if (repeatOn !== undefined) {
    await dialog.locator(`[data-planner-add-day="${repeatOn}"]`).check();
    // The dialog shows what the rule gives before anything is saved.
    await expect(dialog.locator('[data-planner-add-preview] li').first()).toBeVisible();
  }
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/api/v1/commitments'),
  );
  await dialog.locator('[data-planner-add-save]').click();
  return (await created).status();
}

function listRow(page: Page, title: string): Locator {
  return page.locator('[data-planner-list] [data-commitment]').filter({ hasText: title });
}

test.describe('E2E-10 — 가용 시간과 약속을 손으로 (RC-20)', () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  /** The owner's hours before this file touched them; put back by the last test. */
  let hoursBefore: AvailabilityDto | null = null;

  test('the start guide asks when the owner can work and for fixed 약속, and keeps both answers', async ({
    browser,
  }) => {
    // The guide meets an owner without hours. Make this one such an owner —
    // from a device that has already put the guide away.
    const setup = await browser.newContext({ timezoneId: 'UTC' });
    const setupPage = await setup.newPage();
    await login(setupPage, state, account);
    hoursBefore = await getAvailability(setupPage, state);
    if (hoursBefore.rules.length > 0) await putHours(setupPage, { ...hoursBefore, rules: [] }, hoursBefore.version);
    expect(
      await commitmentsAhead(setupPage, 28),
      'this owner already has 약속 ahead: the guide would pass over its second step',
    ).toEqual([]);
    await setup.close();

    // A device that has never seen this owner: the guide opens by itself.
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await driver.signIn(page, account);
    const shell = page.locator('.app-shell[data-first-run-state]');
    await expect(shell).toHaveAttribute('data-first-run-state', 'open');
    const guide = page.locator('[data-first-run]');
    await expect(guide).toBeVisible();

    // 1 — 언제 일할 수 있나요?
    await expect(guide).toHaveAttribute('data-first-run-step', 'hours');
    const next = guide.locator('[data-first-run-next]');
    // Nothing chosen yet: there is nothing to save.
    await expect(next).toBeDisabled();
    await guide.locator('[data-preset="weekdayEvening"]').check();
    await expect(next).toBeEnabled();
    expect(await blockingAxeViolations(page)).toEqual([]);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/v1/availability'),
    );
    await next.click();
    expect((await saved).status()).toBe(200);

    // 2 — 고정된 일정이 있나요?
    await expect(guide).toHaveAttribute('data-first-run-step', 'commitments');
    await expect(guide.locator('.first-run-step').first()).toHaveAttribute('data-first-run-state', 'done');
    expect(await blockingAxeViolations(page)).toEqual([]);
    await guide.locator('[data-plan-commitment-add]').click();
    const dialog = page.locator('[data-planner-add-dialog]');
    await expect(dialog).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);
    const title = `치과 ${tag}`;
    expect(await addByHand(page, dialog, title, day(1))).toBe(201);
    await expect(dialog).toHaveCount(0);
    await expect(guide.locator('[data-plan-commitments-added]')).toBeVisible();
    await guide.locator('[data-first-run-next]').click();
    // What comes after is the AI question where an AI is offered, else the ending.
    await expect(guide).toHaveAttribute('data-first-run-step', /^(ai|ready)$/);
    await guide.locator('[data-first-run-close]').click();
    await expect(shell).toHaveAttribute('data-first-run-state', 'idle');

    // Both answers are the owner's data now.
    const hours = await getAvailability(page, state);
    expect(hours.rules).toEqual(WEEKDAY_EVENINGS);
    const ahead = await commitmentsAhead(page, 28);
    expect(ahead.map((item) => [item.title, item.source, item.occurrences?.length])).toEqual([[title, 'manual', 1]]);
    await context.close();

    // The guide does not open again for an owner who has hours, on any device.
    const later = await browser.newContext({ timezoneId: 'UTC' });
    const laterPage = await later.newPage();
    await driver.signIn(laterPage, account);
    await expect(laterPage.locator('[data-overview]')).toBeVisible();
    const laterShell = laterPage.locator('.app-shell[data-first-run-state]');
    await expect(laterShell).not.toHaveAttribute('data-first-run-state', 'pending');
    await expect(laterShell).toHaveAttribute('data-first-run-state', 'idle');
    await expect(laterPage.locator('[data-first-run]')).toHaveCount(0);
    await later.close();
  });

  test('설정 › 가용 시간 shows the hours, saves a change, and tells a change made elsewhere', async ({ browser }) => {
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await login(page, state, account);
    await page.goto(`${state.webUrl}/settings/availability`);
    await expect(page.getByRole('heading', { name: '가용 시간', level: 2 })).toBeVisible();
    // What the start guide saved.
    await expect(page.getByRole('grid', { name: '주간 가용 시간 표' })).toBeVisible();
    await expect(page.getByRole('gridcell', { name: '월요일 19:00~19:30, 작업' })).toBeVisible();
    const form = page.locator('form[data-availability-version]');
    const status = page.locator('[data-availability-state]');
    await expect(status).toHaveText('저장됨');
    const version = Number(await form.getAttribute('data-availability-version'));
    expect((await getAvailability(page, state)).version).toBe(version);

    // A change: one more weekly window (Monday 09:00–17:00), typed directly.
    await page.locator('details[data-direct-entry] > summary').click();
    await page.getByRole('button', { name: '주간 규칙 추가' }).click();
    await expect(status).toHaveText('저장하지 않은 변경');
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/v1/availability'),
    );
    await page.getByRole('button', { name: '가용 시간 저장' }).click();
    expect((await saved).status()).toBe(200);
    await expect(status).toHaveText('저장됨');
    await expect(form).toHaveAttribute('data-availability-version', String(version + 1));
    const stored = await getAvailability(page, state);
    expect(stored.version).toBe(version + 1);
    expect(stored.rules).toHaveLength(6);
    expect(stored.rules).toContainEqual({ weekday: 1, startLocal: '09:00', endLocal: '17:00', kind: 'work' });
    // It is still there after the page is loaded again.
    await page.reload();
    await expect(page.getByRole('gridcell', { name: '월요일 09:00~09:30, 작업' })).toBeAttached();
    await expect(form).toHaveAttribute('data-availability-version', String(version + 1));

    // Meanwhile the hours change elsewhere (another device): the version moves on.
    await putHours(page, stored, stored.version);
    await page.locator('details[data-direct-entry] > summary').click();
    await page.getByRole('button', { name: '주간 규칙 추가' }).click();
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && new URL(response.url()).pathname.endsWith('/api/v1/availability'),
    );
    await page.getByRole('button', { name: '가용 시간 저장' }).click();
    const answer = await refused;
    expect(answer.status()).toBe(412);
    expect(((await answer.json()) as { code: string }).code).toBe('availability_changed');
    // The page says so and keeps both sides; nothing was overwritten.
    await expect(page.locator('#availability-conflict-title')).toBeVisible();
    expect(await blockingAxeViolations(page)).toEqual([]);
    expect((await getAvailability(page, state)).rules).toHaveLength(6);
    await context.close();
  });

  test('플래너 › 목록: a weekly 약속 is added by hand, listed in the weeks its rule gives, renamed and deleted', async ({
    browser,
  }) => {
    const context = await browser.newContext({ timezoneId: 'UTC' });
    const page = await context.newPage();
    await login(page, state, account);
    const versionBefore = (await getAvailability(page, state)).version;
    const first = day(2);
    const title = `세미나 ${tag}`;
    const renamed = `세미나 옮김 ${tag}`;

    // The week that holds the day after tomorrow (`w` takes any day of a week).
    await page.goto(`${state.webUrl}/planner?view=list&w=${first}`);
    await expect(page.locator('[data-planner="list"]')).toBeVisible();
    await expect(listRow(page, title)).toHaveCount(0);
    await page.locator('[data-planner-add]').click();
    const dialog = page.locator('[data-planner-add-dialog]');
    await expect(dialog).toBeVisible();
    expect(await addByHand(page, dialog, title, first, weekdayCode(first))).toBe(201);
    await expect(dialog).toHaveCount(0);
    await expect(listRow(page, title)).toHaveCount(1);

    // The rule is the server's to expand: the same 약속 is in the next week,
    // and in the one after, on the day its rule names.
    for (const weeks of [1, 2]) {
      await page.goto(`${state.webUrl}/planner?view=list&w=${day(2 + 7 * weeks)}`);
      await expect(page.locator('[data-planner="list"]')).toBeVisible();
      await expect(listRow(page, title)).toHaveCount(1);
    }
    const listed = (await commitmentsAhead(page, 28)).find((item) => item.title === title);
    expect(listed?.rrule).toBe(`FREQ=WEEKLY;BYDAY=${weekdayCode(first)}`);
    expect(listed?.occurrences?.map((occurrence) => occurrence.startAt)).toEqual(
      [0, 7, 14, 21].map((days) => `${day(2 + days)}T15:00:00Z`),
    );

    // Its own dialog: rename.
    await listRow(page, title).locator('[data-commitment-edit]').click();
    const edit = page.locator('[data-planner-edit]');
    await expect(edit).toBeVisible();
    await expect(edit.locator('#planner-commitment-title')).toHaveValue(title);
    await edit.locator('#planner-commitment-title').fill(renamed);
    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && new URL(response.url()).pathname.includes('/api/v1/commitments/'),
    );
    await edit.locator('[data-planner-add-save]').click();
    expect((await patched).status()).toBe(200);
    await expect(edit).toHaveCount(0);
    await expect(listRow(page, renamed)).toHaveCount(1);
    await expect(listRow(page, title)).toHaveCount(0);

    // And delete, with its in-place confirm.
    await listRow(page, renamed).locator('[data-commitment-edit]').click();
    await expect(edit).toBeVisible();
    await edit.locator('[data-planner-delete]').click();
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname.includes('/api/v1/commitments/'),
    );
    await edit.locator('[data-planner-delete-confirm]').click();
    expect((await removed).status()).toBe(204);
    await expect(listRow(page, renamed)).toHaveCount(0);
    expect((await commitmentsAhead(page, 28)).filter((item) => item.title.includes('세미나'))).toEqual([]);

    // Adding, changing and deleting a 약속 each moved the availability
    // version: a plan made before would have to be looked at again.
    expect((await getAvailability(page, state)).version).toBe(versionBefore + 3);

    // Leave the owner as it was found: the 약속 of the start guide goes, the
    // hours go back.
    for (const left of (await commitmentsAhead(page, 28)).filter((item) => item.title.endsWith(tag))) {
      const gone = await apiFetch(page, state, `/commitments/${left.id}`, {
        method: 'DELETE',
        headers: { 'If-Match': `W/"${left.version}"`, 'Idempotency-Key': idempotencyKey() },
      });
      expect(gone.status()).toBe(204);
    }
    if (hoursBefore !== null) {
      const current = await getAvailability(page, state);
      await putHours(page, hoursBefore, current.version);
    }
    await context.close();
  });
});
