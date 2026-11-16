import { test as base, expect, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { login } from '../helpers/app';
import { driver } from '../helpers/driver';
import { readState } from '../helpers/state';
import { watchContext, type PageReport } from '../helpers/test';
import { clockOffsetFromEnv, coreArgs } from './core-setup';
import { isRunDirectory } from './core-teardown';
import { coreSpecs, targetFromEnv } from './target';

/**
 * The `core` target's own checks (blueprint 15 §1.3, §7.3). They run on that
 * target only (`playwright.config.ts`): what they look at does not exist on
 * the default one.
 *
 * - getting in: the boot hand-off, and what the page is without it;
 * - the page watch every other spec relies on (helpers/test.ts) is shown to
 *   notice a real violation of the core's Content-Security-Policy and a real
 *   uncaught error — so "no violation was reported" means something;
 * - a place the core does not serve yet is asked once.
 *
 * This file uses Playwright's plain `test`: the watch is installed by hand
 * here, because these tests cause what the automatic one forbids.
 */
const test = base;
const state = readState();

/** The launch token, to check where it is NOT. Never printed, never part of a message. */
function launchToken(): string {
  if (state.core === undefined) throw new Error('not the core target');
  return (JSON.parse(readFileSync(state.core.readyFile, 'utf8')) as { token: string }).token;
}

/** `haystack` does not hold the token; the failure message does not either. */
function expectNoToken(haystack: string, where: string): void {
  expect(haystack.includes(launchToken()), `the launch token must not be in ${where}`).toBe(false);
}

/** Watches every page `context` opens from here on (so: before its first page). */
async function watched(context: BrowserContext): Promise<PageReport> {
  const report: PageReport = { cspViolations: [], pageErrors: [] };
  await watchContext(context, report);
  return report;
}

test.describe('the core target — how a run is set up', () => {
  test('the target is `ts` unless E2E_TARGET says `core`; anything else is an error (negative)', () => {
    expect(targetFromEnv({})).toBe('ts');
    expect(targetFromEnv({ E2E_TARGET: '' })).toBe('ts');
    expect(targetFromEnv({ E2E_TARGET: 'ts' })).toBe('ts');
    expect(targetFromEnv({ E2E_TARGET: 'core' })).toBe('core');
    for (const wrong of ['Core', 'rust', 'desktop', '1', 'true']) {
      expect(() => targetFromEnv({ E2E_TARGET: wrong }), wrong).toThrow(/E2E_TARGET must be/);
    }
    // The specs proven here are named, one file each, and are specs of the suite.
    const specs = coreSpecs();
    expect(specs.length).toBeGreaterThan(0);
    expect(new Set(specs).size).toBe(specs.length);
    expect(specs.every((spec) => /^[\w-]+\.spec\.ts$/.test(spec))).toBe(true);
  });

  test('the core is started on a fresh directory with the bundle, UTC and `en`; the clock moves only when asked', () => {
    const args = coreArgs({ dataDir: '/run/data', readyFile: '/run/ready.json', webDir: '/web/desktop/dist', clockOffsetMs: 0 });
    expect(args).toEqual([
      '--data-dir', '/run/data',
      '--ready-file', '/run/ready.json',
      '--web-dir', '/web/desktop/dist',
      '--time-zone', 'UTC',
      '--locale', 'en',
    ]);
    // Never an origin beside its own, never a token: the core makes its own.
    expect(args.join(' ')).not.toMatch(/allow-origin|token/);
    expect(coreArgs({ dataDir: '/d', readyFile: '/r', webDir: '/w', clockOffsetMs: -86_400_000.7 }).slice(-2)).toEqual(['--clock-offset-ms', '-86400000']);

    const now = Date.parse('2026-11-16T00:00:00.000Z');
    expect(clockOffsetFromEnv({}, now)).toBe(0);
    expect(clockOffsetFromEnv({ E2E_FAKE_NOW: '  ' }, now)).toBe(0);
    expect(clockOffsetFromEnv({ E2E_FAKE_NOW: '2026-11-17T00:00:00.000Z' }, now)).toBe(86_400_000);
    // The same instant written in another zone is no offset at all; a day earlier is a day back.
    expect(clockOffsetFromEnv({ E2E_FAKE_NOW: '2026-11-16T09:00:00+09:00' }, now)).toBe(0);
    expect(clockOffsetFromEnv({ E2E_FAKE_NOW: '2026-11-15T09:00:00+09:00' }, now)).toBe(-86_400_000);
    // A time without a zone, or no time at all, is refused (negative).
    expect(() => clockOffsetFromEnv({ E2E_FAKE_NOW: '2026-11-17T00:00:00' }, now)).toThrow(/E2E_FAKE_NOW/);
    expect(() => clockOffsetFromEnv({ E2E_FAKE_NOW: 'tomorrow' }, now)).toThrow(/E2E_FAKE_NOW/);
  });

  test('teardown removes only a directory this target made (negative: nothing else, whatever the state file says)', () => {
    const made = state.core?.runDir ?? '';
    expect(isRunDirectory(made)).toBe(true);
    for (const other of ['/', '/tmp', '/home', process.cwd(), `${made}/..`, `${made}/data`, '/tmp/ohmydate-e2e-core-x/../..', '/var/ohmydate-e2e-core-x', '']) {
      expect(isRunDirectory(other), other).toBe(false);
    }
  });
});

test.describe('the core target — getting in, and the page watch', () => {
  test.beforeAll(() => {
    expect(driver.target, 'this spec is the core target’s').toBe('core');
  });

  test('opened by its address, without the hand-off: "open it from the app", no form, and the API refuses the page', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const me = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/v1/me');
    await driver.openSignedOutPage(page);
    expect((await me).status()).toBe(401);

    const locked = page.locator('[data-desktop-locked]');
    await expect(locked).toContainText('앱에서 다시 열어 주세요');
    await expect(locked.locator('input, form, button, a')).toHaveCount(0);
    await expect(page.locator('.nav-rail, .app-topbar')).toHaveCount(0);
    // The address of the login form is just another address of the app: still that page, never a form.
    await page.goto(`${state.webUrl}/login`);
    await expect(locked).toBeVisible();
    await expect(page.getByLabel('비밀번호')).toHaveCount(0);
    await expect(page).toHaveURL(/\/overview$/);
    expect(await context.cookies()).toEqual([]);
    await context.close();
  });

  test('the hand-off: an HttpOnly cookie that is not Secure, and the token is nowhere a script or a person can read it', async ({ browser }) => {
    const context = await browser.newContext();
    const report = await watched(context);
    const page = await context.newPage();
    await login(page, state);

    // The cookie, exactly as the core sets it (15 §1.3): WebKit would drop a Secure one on http://127.0.0.1.
    const cookies = await context.cookies();
    expect(cookies.map((cookie) => cookie.name)).toEqual(['omd_launch']);
    expect(cookies[0]).toMatchObject({ httpOnly: true, secure: false, sameSite: 'Strict', path: '/', expires: -1 });

    // Nowhere else.
    expectNoToken(page.url(), 'the address');
    const seenByScripts = await page.evaluate(() =>
      JSON.stringify({
        cookie: document.cookie,
        referrer: document.referrer,
        local: Object.entries({ ...localStorage }),
        session: Object.entries({ ...sessionStorage }),
        entries: performance.getEntries().map((entry) => entry.name),
        history: history.length,
        html: document.documentElement.outerHTML,
      }),
    );
    expectNoToken(seenByScripts, 'anything a script can read');
    expect(JSON.parse(seenByScripts)).toMatchObject({ cookie: '', referrer: '' });

    // The owner is whoever /me says, and device state is kept under that id (the single owner is still an owner).
    const me = (await (await driver.request(page, '/me')).json()) as { id: string; llmProvider?: string };
    expect(me.llmProvider).toBeUndefined();
    expect(await page.evaluate(() => localStorage.getItem('ohmydate.focus.owner'))).toBe(me.id);
    // Whatever is kept per owner is kept under that id: no fixed "desktop" name, no other id.
    const scoped = (await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)])).filter((key) =>
      /:[0-9a-f-]{36}$|:anonymous$|:desktop$/.test(key),
    );
    expect(scoped.filter((key) => !key.endsWith(`:${me.id}`))).toEqual([]);

    // No sign-out, no address, no push; no service worker.
    await page.locator('[data-user-menu]').click();
    await expect(page.locator('#topbar-user-menu')).toBeVisible();
    await expect(page.locator('[data-user-sign-out]')).toHaveCount(0);
    await expect(page.locator('#topbar-user-menu')).not.toContainText('@');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(async () => ('serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0))).toBe(0);

    expect(report).toEqual({ cspViolations: [], pageErrors: [] });
    await context.close();
  });

  test('the page watch notices a blocked inline script, eval, a foreign address and an uncaught error (negative)', async ({ browser }) => {
    const context = await browser.newContext();
    const report = await watched(context);
    const page = await context.newPage();
    await login(page, state);
    expect(report).toEqual({ cspViolations: [], pageErrors: [] });

    const outcome = await page.evaluate(async () => {
      const marks = window as unknown as { inlineRan?: boolean };
      const inline = document.createElement('script');
      inline.textContent = 'window.inlineRan = true;';
      document.head.append(inline);

      // From a timer, so it is the page's own turn: code the test tool evaluates
      // directly is exempt from the policy's eval rule, a page's script is not.
      const evalRan = await new Promise<boolean>((resolve) => {
        setTimeout(() => {
          try {
            resolve((new Function('return true') as () => boolean)());
          } catch {
            resolve(false);
          }
        }, 0);
      });

      let foreignFetch = 'sent';
      try {
        await fetch('http://example.invalid/collect', { mode: 'no-cors' });
      } catch {
        foreignFetch = 'blocked';
      }

      const style = document.createElement('style');
      style.textContent = 'html { outline: 3px solid rgb(1, 2, 3) !important; }';
      document.head.append(style);
      const styled = getComputedStyle(document.documentElement).outlineColor === 'rgb(1, 2, 3)';

      await new Promise((resolve) => setTimeout(resolve, 300));
      return { inlineRan: marks.inlineRan === true, evalRan, foreignFetch, styled };
    });
    // The policy holds: none of it took effect…
    expect(outcome).toEqual({ inlineRan: false, evalRan: false, foreignFetch: 'blocked', styled: false });
    // …and the watch heard about each kind.
    await expect.poll(() => report.cspViolations.filter((entry) => !entry.startsWith('console:')).length).toBeGreaterThanOrEqual(4);
    const heard = report.cspViolations.join('\n');
    expect(heard).toMatch(/script-src(-elem)? blocked inline/);
    expect(heard).toMatch(/script-src blocked eval|unsafe-eval|script-src blocked (inline|eval)/);
    expect(heard).toMatch(/connect-src blocked http:\/\/example\.invalid/);
    expect(heard).toMatch(/style-src(-elem)? blocked inline/);

    // An error nobody catches is heard too.
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e probe: uncaught');
      }, 0);
    });
    await expect.poll(() => report.pageErrors).toContain('e2e probe: uncaught');
    await context.close();
  });

  test('a place the core does not serve yet is asked once, says so calmly, and nothing keeps asking', async ({ browser }) => {
    const context = await browser.newContext();
    const report = await watched(context);
    const page = await context.newPage();
    const notServed = new Map<string, number>();
    page.on('response', (response) => {
      if (response.status() !== 501) return;
      const url = new URL(response.url());
      const key = `${response.request().method()} ${url.pathname}${url.search}`;
      notServed.set(key, (notServed.get(key) ?? 0) + 1);
    });
    await login(page, state);

    // 개요's frame is there and its cards have settled: none loads, none alarms.
    await expect(page.locator('[data-greeting]')).toHaveText(/^좋은 (아침|오후|저녁)이에요$/);
    await expect(page.locator('[data-next]')).toContainText('아직 준비 중');
    await expect(page.locator('[data-overview] [data-widget]')).toHaveCount(5);
    await expect(page.locator('[data-overview] [data-widget][data-state="loading"]')).toHaveCount(0);
    await expect(page.locator('[data-overview] [data-widget][data-state="not-ready"]')).toHaveCount(5);
    await expect(page.locator('[data-overview] [role="alert"]')).toHaveCount(0);
    await expect(page.locator('[data-overview] [data-retry]')).toHaveCount(0);
    // The owner's hours can be read (RC-20), so a new owner was met by the
    // start guide; `login()` put it away, and it does not come back by itself.
    await expect(page.locator('.app-shell')).toHaveAttribute('data-first-run-state', 'idle');
    await expect(page.locator('[data-first-run]')).toHaveCount(0);

    // Settled. From here on nothing asks again: longer than the notification
    // poll's first interval (5 s) and than any retry back-off, not one more 501.
    await page.waitForTimeout(1_000);
    expect(notServed.size, 'some places are not served yet').toBeGreaterThan(0);
    const settled = new Map(notServed);
    await page.waitForTimeout(6_500);
    expect([...notServed.entries()].filter(([key, count]) => count !== settled.get(key)), 'asked again after the page had settled').toEqual([]);
    // While it loaded, a place was asked once per part of the page that reads it
    // (the shell, 개요 and the start guide each read the calendar's status) — never retried.
    expect([...notServed.entries()].filter(([, count]) => count > 3), 'asked more than once per reader').toEqual([]);

    // The bell says the same, calmly.
    await page.locator('.app-topbar').getByRole('button', { name: '알림' }).click();
    const panel = page.getByRole('dialog', { name: '알림' });
    await expect(panel).toContainText('알림은 아직 준비 중이에요.');
    await expect(panel.locator('[role="alert"], .push-opt-in')).toHaveCount(0);

    expect(report).toEqual({ cspViolations: [], pageErrors: [] });
    await context.close();
  });
});
