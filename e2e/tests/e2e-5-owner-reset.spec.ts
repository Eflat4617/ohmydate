import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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
});
