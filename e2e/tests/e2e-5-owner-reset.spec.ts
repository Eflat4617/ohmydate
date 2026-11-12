import { type BrowserContext, type Page } from '@playwright/test';
import { expect, test } from '../helpers/test';
import { login } from '../helpers/app';
import { apiFetch, expectOk, idempotencyKey } from '../helpers/planner';
import { readState } from '../helpers/state';

const state = readState();

interface MeDto {
  readonly id: string;
  readonly version: number;
  readonly llm?: {
    readonly consent?: { readonly granted: boolean };
    readonly budget?: { readonly dailyUsd: number; readonly monthlyUsd: number };
  };
}

async function currentUser(context: BrowserContext): Promise<MeDto> {
  const response = await context.request.get(`${state.apiUrl}/api/v1/me`);
  expect(response.ok(), `GET /me -> ${response.status()}`).toBeTruthy();
  return (await response.json()) as MeDto;
}

async function patchSettings(
  page: Page,
  patch: Record<string, unknown>,
  version: number,
): Promise<MeDto> {
  const response = await apiFetch(page, state, '/me/settings', {
    method: 'PATCH',
    headers: {
      'If-Match': `W/"${version}"`,
      'Idempotency-Key': idempotencyKey(),
    },
    body: patch,
  });
  return (await expectOk(response, 'PATCH /me/settings')) as MeDto;
}

test.describe('E2E-5 — owner identity hard reset on cross-tab login and logout', () => {
  test('reloads tab 1 as owner B and returns to login after an external logout', async ({
    browser,
  }) => {
    const accountA = { email: state.email, password: state.password };
    const accountB = { email: state.todayEmail, password: state.todayPassword };

    const seedContext = await browser.newContext();
    const seedPage = await seedContext.newPage();
    await login(seedPage, state, accountA);
    const aInitial = await currentUser(seedContext);
    const aConsent = await patchSettings(
      seedPage,
      { llm: { consent: { granted: true } } },
      aInitial.version,
    );
    const aBudget = await patchSettings(
      seedPage,
      { llm: { budget: { dailyUsd: 9, monthlyUsd: 90 } } },
      aConsent.version,
    );
    const aSeeded = await currentUser(seedContext);

    await login(seedPage, state, accountB);
    const bInitial = await currentUser(seedContext);
    const bTimezone = await patchSettings(seedPage, { timeZone: 'UTC' }, bInitial.version);
    const bLocale = await patchSettings(seedPage, { locale: 'en' }, bTimezone.version);
    const bSeeded = await currentUser(seedContext);

    expect(aSeeded.llm?.consent?.granted).toBe(true);
    expect(aSeeded.llm?.budget).toEqual({ dailyUsd: 9, monthlyUsd: 90 });
    expect(bSeeded.llm).toBeUndefined();
    expect(bSeeded.version).toBe(aSeeded.version);
    expect(aBudget.version).toBe(aSeeded.version);
    expect(bLocale.version).toBe(bSeeded.version);
    await seedContext.close();

    const context = await browser.newContext();
    const pageA = await context.newPage();
    await login(pageA, state, accountA);
    const ownerA = await currentUser(context);
    expect(ownerA.id).toBe(aSeeded.id);

    const sessionId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await pageA.evaluate(
      ({ ownerId, id, task }) => {
        localStorage.setItem(
          `ohmydate.focus.sessions:${ownerId}`,
          JSON.stringify({
            [id]: {
              id,
              taskId: task,
              state: 'active',
              startedAt: new Date().toISOString(),
              focusedSec: 0,
              pausedSec: 0,
              clientId: 'e2e-owner-a',
              version: 1,
            },
          }),
        );
      },
      { ownerId: ownerA.id, id: sessionId, task: taskId },
    );
    await pageA.goto(`${state.webUrl}/settings/ai`);
    await expect(pageA.getByRole('heading', { name: 'AI 설정' })).toBeVisible();
    await pageA.evaluate(() => {
      (window as unknown as { __ohmydateOwnerSentinel?: string }).__ohmydateOwnerSentinel = 'A';
    });

    const pageB = await context.newPage();
    await login(pageB, state, accountB);
    const freshB = await currentUser(context);
    expect(freshB.id).toBe(bSeeded.id);
    expect(freshB.id).not.toBe(ownerA.id);
    expect(freshB.llm).toBeUndefined();

    const reloadMe = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/api/v1/me'),
    );
    await pageA.reload({ waitUntil: 'domcontentloaded' });
    const reloadedMe = (await (await reloadMe).json()) as MeDto;
    expect(reloadedMe.id).toBe(freshB.id);
    expect(reloadedMe.llm).toBeUndefined();
    expect(
      await pageA.evaluate(
        () =>
          (window as unknown as { __ohmydateOwnerSentinel?: string }).__ohmydateOwnerSentinel ??
          null,
      ),
    ).toBeNull();

    const activeOwner = await pageA.evaluate(() =>
      localStorage.getItem('ohmydate.focus.owner'),
    );
    expect(activeOwner).toBe(freshB.id);
    const ownerBSessions = await pageA.evaluate(
      (ownerId) => localStorage.getItem(`ohmydate.focus.sessions:${ownerId}`),
      freshB.id,
    );
    expect(ownerBSessions).toBeNull();
    const ownerASessions = await pageA.evaluate(
      (ownerId) => localStorage.getItem(`ohmydate.focus.sessions:${ownerId}`),
      ownerA.id,
    );
    expect(ownerASessions).not.toBeNull();

    await pageA.goto(`${state.webUrl}/settings/ai`);
    await expect(pageA.getByRole('heading', { name: 'AI 설정' })).toBeVisible();
    await expect(pageA.locator('body')).not.toContainText('9.00');
    await expect(pageA.locator('body')).not.toContainText('90.00');

    await pageB.bringToFront();
    await pageB.getByRole('button', { name: '로그아웃' }).click();
    await expect(pageB).toHaveURL(`${state.webUrl}/login`, { timeout: 20_000 });
    const afterLogout = await context.request.get(`${state.apiUrl}/api/v1/me`);
    expect(afterLogout.status()).toBe(401);

    await pageA.bringToFront();
    await expect(pageA).toHaveURL(`${state.webUrl}/login`, { timeout: 20_000 });
    await expect(pageA.getByRole('heading', { name: 'OhMyDate에 로그인' })).toBeVisible();

    await context.close();
  });

  test('resets tab 1 automatically when tab 2 signs in as the other owner, without page.reload', async ({
    browser,
  }) => {
    const accountA = { email: state.email, password: state.password };
    const accountB = { email: state.todayEmail, password: state.todayPassword };

    const context = await browser.newContext();
    const pageA = await context.newPage();
    await login(pageA, state, accountA);
    const ownerA = await currentUser(context);

    const aSettings = await patchSettings(
      pageA,
      { llm: { consent: { granted: true } } },
      ownerA.version,
    );
    await patchSettings(
      pageA,
      { llm: { budget: { dailyUsd: 9, monthlyUsd: 90 } } },
      aSettings.version,
    );
    const seededA = await currentUser(context);
    expect(seededA.llm?.consent?.granted).toBe(true);
    expect(seededA.llm?.budget).toEqual({ dailyUsd: 9, monthlyUsd: 90 });

    const aOnlyTitle = `FU-56 owner A only ${Date.now().toString(36)}`;
    await pageA.getByLabel('작업 빠르게 추가').fill(aOnlyTitle);
    await pageA.getByRole('button', { name: '작업 추가' }).click();
    await expect(pageA.getByText(aOnlyTitle, { exact: true })).toBeVisible();

    const sessionsKeyA = `ohmydate.focus.sessions:${ownerA.id}`;
    await pageA.evaluate(
      ({ key, ownerId }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            'fu-56-session': {
              id: 'fu-56-session',
              taskId: crypto.randomUUID(),
              state: 'active',
              startedAt: new Date().toISOString(),
              focusedSec: 0,
              pausedSec: 0,
              clientId: 'e2e-owner-a',
              version: 1,
              ownerId,
            },
          }),
        );
        (window as unknown as { __ohmydateOwnerSentinel?: string }).__ohmydateOwnerSentinel = 'A';
      },
      { key: sessionsKeyA, ownerId: ownerA.id },
    );
    const sidBefore = (await context.cookies()).find((cookie) => cookie.name === 'sid')?.value;
    expect(sidBefore).toBeTruthy();

    const pageB = await context.newPage();
    await pageB.goto(`${state.webUrl}/inbox`);
    await expect(pageB.getByRole('heading', { name: '인박스' })).toBeVisible();
    await expect(pageB.getByText(aOnlyTitle, { exact: true })).toBeVisible();

    const autoMe = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/api/v1/me') &&
        response.status() === 200,
    );
    await login(pageB, state, accountB);
    const automaticMe = (await (await autoMe).json()) as MeDto;
    const ownerB = await currentUser(context);
    expect(ownerB.id).toBe(automaticMe.id);
    expect(ownerB.id).not.toBe(ownerA.id);
    expect(ownerB.llm).toBeUndefined();

    await expect(pageA.getByRole('heading', { name: '인박스' })).toBeVisible({ timeout: 20_000 });
    expect(
      await pageA.evaluate(
        () =>
          (window as unknown as { __ohmydateOwnerSentinel?: string }).__ohmydateOwnerSentinel ??
          null,
      ),
    ).toBeNull();
    expect(await pageA.evaluate(() => localStorage.getItem('ohmydate.focus.owner'))).toBe(ownerB.id);
    expect(
      await pageA.evaluate((ownerId) => localStorage.getItem(`ohmydate.focus.sessions:${ownerId}`), ownerB.id),
    ).toBeNull();
    expect(await pageA.evaluate((key) => localStorage.getItem(key), sessionsKeyA)).not.toBeNull();
    await expect(pageA.getByText(aOnlyTitle, { exact: true })).toHaveCount(0);

    const tabOneMe = await pageA.request.get(`${state.apiUrl}/api/v1/me`);
    expect(tabOneMe.ok()).toBeTruthy();
    const tabOneUser = (await tabOneMe.json()) as MeDto;
    expect(tabOneUser.id).toBe(ownerB.id);
    expect(tabOneUser.llm).toBeUndefined();
    const tabOneTasks = await pageA.request.get(`${state.apiUrl}/api/v1/tasks`);
    expect(tabOneTasks.ok()).toBeTruthy();
    const tabOneTitles = ((await tabOneTasks.json()) as { items: { title: string }[] }).items.map(
      (task) => task.title,
    );
    expect(tabOneTitles).not.toContain(aOnlyTitle);

    const sidAfter = (await context.cookies()).find((cookie) => cookie.name === 'sid');
    expect(sidAfter?.value).toBeTruthy();
    expect(sidAfter?.value).not.toBe(sidBefore);

    const autoLogoutMe = pageA.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname.endsWith('/api/v1/me') &&
        response.status() === 401,
    );
    await pageB.bringToFront();
    await pageB.getByRole('button', { name: '로그아웃' }).click();
    await expect(pageB).toHaveURL(`${state.webUrl}/login`, { timeout: 20_000 });
    await autoLogoutMe;
    await expect(pageA).toHaveURL(`${state.webUrl}/login`, { timeout: 20_000 });
    await expect(pageA.getByRole('heading', { name: 'OhMyDate에 로그인' })).toBeVisible();
    expect(
      (await pageA.request.get(`${state.apiUrl}/api/v1/me`)).status(),
    ).toBe(401);
    expect(await pageA.evaluate(() => localStorage.getItem('ohmydate.focus.owner'))).toBeNull();

    await context.close();
  });
});
