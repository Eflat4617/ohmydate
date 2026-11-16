import { test as base, expect, type BrowserContext } from '@playwright/test';
import { driver } from './driver';

/**
 * What every test of the suite starts and ends with.
 *
 * - `beforeEachTest` is the target's own preparation (helpers/driver.ts): on
 *   the default target it resets the login rate limit (FU-79); on `core`
 *   there is nothing to reset.
 * - `pageWatch` (the `core` target only): the core serves the web under its
 *   Content-Security-Policy (blueprint 15 §1.3), and most of the product
 *   answers 501 there. So every page a test opens is watched, and the test
 *   fails if the page reported a CSP violation, or threw an error nobody
 *   caught — a place that is not ready must say so, not throw (15 §7.3).
 */
export interface PageReport {
  readonly cspViolations: string[];
  readonly pageErrors: string[];
}

const CSP_BINDING = '__omdReportCspViolation';

/** Collects into `report` what every page of `context` reports from here on. */
export async function watchContext(context: BrowserContext, report: PageReport): Promise<void> {
  // The browser's own event: fired for every blocked load, whoever asked for it.
  await context.exposeBinding(CSP_BINDING, (_source, violation: string) => {
    report.cspViolations.push(violation);
  });
  await context.addInitScript((binding) => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const send = (window as unknown as Record<string, ((violation: string) => void) | undefined>)[binding];
      // What names the rule, the kind of thing blocked and where — paths only:
      // never a query string (the hand-off's holds the token) and never page text.
      const pathOf = (address: string): string => {
        try {
          return new URL(address, location.href).pathname;
        } catch {
          return '?';
        }
      };
      const where = event.sourceFile ? ` by ${pathOf(event.sourceFile)}:${event.lineNumber}` : '';
      send?.(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} on ${location.pathname}${where} (${event.disposition})`);
    });
  }, CSP_BINDING);
  context.on('page', (page) => {
    // …and what the engine writes to the console about it (the event can be missed by a very early load).
    page.on('console', (message) => {
      if (/Content[- ]Security[- ]Policy/i.test(message.text())) report.cspViolations.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      report.pageErrors.push(error.message);
    });
  });
}

export const test = base.extend<{ beforeEachTest: void; pageWatch: void }>({
  beforeEachTest: [
    async ({ request }, use) => {
      await driver.beforeEachTest(request);
      await use();
    },
    { auto: true },
  ],
  pageWatch: [
    async ({ browser }, use) => {
      if (driver.target !== 'core') {
        await use();
        return;
      }
      const report: PageReport = { cspViolations: [], pageErrors: [] };
      // The specs open their own contexts (`browser.newContext()`): each is watched from its first page on.
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const context = await newContext(options);
        await watchContext(context, report);
        return context;
      };
      try {
        await use();
      } finally {
        browser.newContext = newContext;
      }
      expect(report.cspViolations, 'the page reported Content-Security-Policy violations').toEqual([]);
      expect(report.pageErrors, 'the page threw errors nobody caught').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
