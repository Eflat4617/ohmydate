#!/usr/bin/env node
// UI-POLISH evidence: screenshots + a11y/overflow sweep against the synthetic
// MSW mock (VITE_MOCK=1). No real API, accounts or personal data are involved.
//
//   node scripts/ui-screenshots.mjs --label after            # spawns vite on :5199
//   node scripts/ui-screenshots.mjs --label before --url http://127.0.0.1:5199
//   node scripts/ui-screenshots.mjs --label after --only 14-today
//
// Output: docs/ui-polish/<label>/<screen>-<viewport>[-dark][-full].png and
//         docs/ui-polish/<label>/sweep-report.json
// Every screen is visited at 390×844, 1440×900 and 360×780 (check-only), in
// light and dark. Screenshots are kept for all light screens and for
// Today/Focus in dark; axe-core (WCAG 2.0–2.2 A/AA tags) and a horizontal
// overflow check run on every visit. Exit code 1 if any critical/serious
// violation or horizontal overflow is found (unless --report-only).
/* global document, window -- used only inside page.evaluate() browser callbacks */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const label = arg('label', 'after');
const only = arg('only', '');
const port = Number(arg('port', '5199'));
const reportOnly = process.argv.includes('--report-only');
let baseUrl = arg('url', '');
const outDir = join(webRoot, 'docs', 'ui-polish', label);

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844, capture: true },
  { name: 'desktop', width: 1440, height: 900, capture: true },
  { name: 'narrow', width: 360, height: 780, capture: false },
];
const SCHEMES = ['light', 'dark'];
const DARK_CAPTURES = /^(14-today|16-focus)/;
const FULL_CAPTURES = /^(09-wizard-step4|11-plan-comparison|12-availability|13-commitments|17-review)/;
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Mock "today" is 2026-11-14 (Asia/Seoul); pin the clock so captures are stable.
const FIXED_NOW = new Date('2026-11-14T09:40:00.000Z');
const FULL_MAX_HEIGHT = 2600;

const findings = [];

async function startVite() {
  const child = spawn(
    join(webRoot, 'node_modules', '.bin', 'vite'),
    ['--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { cwd: webRoot, env: { ...process.env, VITE_MOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error('vite did not start')), 30_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Local:')) {
        clearTimeout(timer);
        resolvePromise(undefined);
      }
    });
    child.on('exit', (code) => reject(new Error(`vite exited ${code}`)));
  });
  return child;
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(250);
}

async function checkpoint(page, name, run) {
  if (only.length > 0 && !name.startsWith(only)) return;
  const { viewport, scheme } = run;
  await settle(page);

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  const axe = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const blocking = axe.violations
    .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  const overflowX = overflow.scrollWidth > overflow.clientWidth;
  findings.push({
    screen: name,
    viewport: `${viewport.width}x${viewport.height}`,
    scheme,
    overflowX,
    scrollWidth: overflow.scrollWidth,
    violations: blocking,
  });
  const flags = [overflowX ? `overflow-x ${overflow.scrollWidth}px` : '', blocking.length ? `${blocking.length} axe` : '']
    .filter(Boolean)
    .join(', ');

  const keep = viewport.capture && (scheme === 'light' || DARK_CAPTURES.test(name));
  if (!keep) {
    if (flags) console.log(`  ! ${name} ${viewport.name} ${scheme}: ${flags}`);
    return;
  }
  const suffix = scheme === 'dark' ? '-dark' : '';
  const file = join(outDir, `${name}-${viewport.name}${suffix}.png`);
  await page.screenshot({ path: file, animations: 'disabled', caret: 'hide' });
  console.log(`  ${file.replace(`${webRoot}/`, '')}${flags ? `  ! ${flags}` : ''}`);

  if (FULL_CAPTURES.test(name)) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    if (height > viewport.height + 40) {
      await page.setViewportSize({ width: viewport.width, height: Math.min(height, FULL_MAX_HEIGHT) });
      await settle(page);
      const full = join(outDir, `${name}-${viewport.name}${suffix}-full.png`);
      await page.screenshot({ path: full, animations: 'disabled', caret: 'hide' });
      console.log(`  ${full.replace(`${webRoot}/`, '')}`);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await settle(page);
    }
  }
}

async function newPage(browser, run, overrides) {
  const context = await browser.newContext({
    viewport: { width: run.viewport.width, height: run.viewport.height },
    deviceScaleFactor: 1,
    colorScheme: run.scheme,
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Seoul',
    locale: 'en-US',
  });
  const page = await context.newPage();
  await page.clock.setFixedTime(FIXED_NOW);
  if (overrides !== undefined) {
    await page.addInitScript((value) => {
      window.__OHMYDATE_MOCK__ = value;
    }, overrides);
  }
  return { context, page };
}

async function go(page, path) {
  await page.goto(`${baseUrl}${path}`);
  await page.waitForFunction(() => document.querySelector('#app')?.childElementCount > 0);
}

function isMobile(run) {
  return run.viewport.width < 1024;
}

async function flowMain(browser, run) {
  const { context, page } = await newPage(browser, run);

  await go(page, '/login');
  await page.getByRole('heading', { name: 'Sign in to OhMyDate' }).waitFor();
  await checkpoint(page, '01-login', run);

  await go(page, '/inbox');
  await page.locator('.task-item').first().waitFor();
  await checkpoint(page, '02-inbox', run);

  // Conflict: another "device" bumps the seeded task while we edit it.
  const firstTitle = (await page.locator('.task-item .task-title').first().textContent())?.trim() ?? '';
  await page.getByRole('button', { name: `Edit title of ${firstTitle}` }).click();
  await page.getByLabel('Task title').fill(`${firstTitle} (my edit)`);
  await page.evaluate((title) => {
    const db = window.__OHMYDATE_MOCK_DB__;
    const task = [...db.tasks.values()].find((item) => item.title === title);
    if (task !== undefined) {
      task.version += 1;
      task.title = `${title} (changed on phone)`;
      db.taskRevision += 1;
    }
  }, firstTitle);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await checkpoint(page, '03-conflict-dialog', run);
  await page.keyboard.press('Escape');

  await go(page, '/projects');
  await page.locator('.project-list li').first().waitFor();
  await checkpoint(page, '04-projects', run);
  await page.getByRole('link', { name: 'Thesis' }).click();
  await page.getByRole('heading', { name: 'Thesis' }).waitFor();
  await checkpoint(page, '05-project-detail', run);

  await go(page, '/plan/new');
  await page.getByRole('heading', { name: '1단계 · 기본정보' }).waitFor();
  await page.locator('#wizard-title').fill('주간 보고서 작성');
  await page.locator('#wizard-due').fill('2026-11-20T18:00');
  await page.locator('#wizard-description').fill('팀 주간 보고서 초안과 검토까지');
  await checkpoint(page, '06-wizard-step1', run);
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('heading', { name: /2단계 · 유형 확인|3단계 · 질문/ }).waitFor();
  if (await page.getByRole('heading', { name: '2단계 · 유형 확인' }).isVisible()) {
    await checkpoint(page, '07-wizard-step2', run);
    await page.getByRole('button', { name: '예', exact: true }).click();
  }
  await page.getByRole('heading', { name: /3단계 · 질문|4단계 · 단계 초안/ }).waitFor();
  if (await page.getByRole('heading', { name: '3단계 · 질문' }).isVisible()) {
    await checkpoint(page, '08-wizard-step3', run);
    for (let round = 0; round < 12; round += 1) {
      if (await page.getByRole('heading', { name: '4단계 · 단계 초안' }).isVisible()) break;
      const idk = page.getByRole('button', { name: '모름', exact: true }).first();
      if ((await idk.count()) === 0) break;
      await idk.click();
      await settle(page);
    }
  }
  await page.getByRole('heading', { name: '4단계 · 단계 초안' }).waitFor({ timeout: 15_000 }).catch(() => undefined);
  await checkpoint(page, '09-wizard-step4', run);

  await go(page, '/plans/new');
  await page.getByRole('heading', { name: 'New plan' }).waitFor();
  await settle(page);
  const boxes = page.locator('.task-picker input[type="checkbox"]');
  const count = await boxes.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) await boxes.nth(index).check();
  await checkpoint(page, '10-plan-new', run);
  await page.getByRole('button', { name: 'Generate candidates' }).click();
  await page.getByRole('heading', { name: /^Plan comparison$/ }).waitFor();
  await page.locator('.candidate-card').first().waitFor();
  await checkpoint(page, '11-plan-comparison', run);

  await go(page, '/settings/availability');
  await page.getByRole('heading', { name: 'Availability' }).waitFor();
  await checkpoint(page, '12-availability', run);

  await go(page, '/commitments');
  await page.getByRole('heading', { name: 'Commitments' }).waitFor();
  await checkpoint(page, '13-commitments', run);

  await context.close();
}

async function flowDaily(browser, run) {
  const { context, page } = await newPage(browser, run);
  await go(page, '/today');
  await page.locator('.today-card').first().waitFor();
  await checkpoint(page, '14-today', run);

  await context.setOffline(true);
  await page.getByText(/You are offline/).first().waitFor();
  await checkpoint(page, '15-today-offline', run);
  await context.setOffline(false);
  await page.getByText(/You are offline/).first().waitFor({ state: 'detached' }).catch(() => undefined);

  await page.getByRole('button', { name: 'Start focus' }).first().click();
  await page.locator('.focus-timer').waitFor();
  await page.clock.setFixedTime(new Date(FIXED_NOW.getTime() + (24 * 60 + 37) * 1000));
  await page.waitForTimeout(1200);
  await checkpoint(page, '16-focus', run);

  const calm = page.getByRole('button', { name: 'Calm mode' });
  if ((await calm.count()) > 0) {
    await calm.click();
    await checkpoint(page, '16-focus-calm', run);
    await calm.click();
  }

  await page.getByRole('button', { name: 'Complete' }).first().click();
  await page.getByRole('heading', { name: 'How did the session go?' }).waitFor();
  await page.getByRole('radio', { name: 'Partial' }).check();
  await page.getByRole('checkbox', { name: 'Task was larger' }).check();
  await checkpoint(page, '17-review', run);

  await go(page, '/today');
  await page.locator('.today-card').first().waitFor();
  if (isMobile(run)) {
    const more = page.getByRole('button', { name: 'More', exact: true }).filter({ visible: true });
    if ((await more.count()) > 0) {
      await more.first().click();
      await page.getByRole('dialog', { name: 'More' }).waitFor();
      await checkpoint(page, '21-more-sheet', run);
      await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Notifications' }).click();
    } else {
      // Pre-polish bottom nav overflows narrow screens, leaving the button off-screen.
      await page.getByRole('button', { name: 'Notifications' }).filter({ visible: true }).first().dispatchEvent('click');
    }
  } else {
    await page.locator('.nav-rail').getByRole('button', { name: 'Notifications' }).click();
  }
  await page.getByRole('dialog', { name: 'Notifications' }).waitFor();
  await checkpoint(page, '18-notifications', run);
  await context.close();
}

async function flowAi(browser, run) {
  const { context, page } = await newPage(browser, run, { llmProvider: 'deepseek' });
  await go(page, '/settings/ai');
  await page.getByRole('dialog').waitFor();
  await checkpoint(page, '19-ai-consent', run);
  await page.getByRole('button', { name: 'Use manual mode' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: 'AI settings' }).waitFor();
  await checkpoint(page, '20-ai-settings', run);
  await context.close();
}

async function main() {
  await mkdir(outDir, { recursive: true });
  let vite = null;
  if (baseUrl.length === 0) {
    vite = await startVite();
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const browser = await chromium.launch();
  try {
    for (const viewport of VIEWPORTS) {
      for (const scheme of SCHEMES) {
        const run = { viewport, scheme };
        console.log(`${label} · ${viewport.name} ${viewport.width}x${viewport.height} · ${scheme}`);
        await flowMain(browser, run);
        await flowDaily(browser, run);
        await flowAi(browser, run);
      }
    }
  } finally {
    await browser.close();
    vite?.kill('SIGTERM');
  }

  const failing = findings.filter((item) => item.overflowX || item.violations.length > 0);
  const summary = {
    label,
    generatedFrom: 'VITE_MOCK=1 synthetic data (src/mocks)',
    axeTags: AXE_TAGS,
    visits: findings.length,
    failing: failing.length,
    findings,
  };
  if (only.length === 0) {
    await writeFile(join(outDir, 'sweep-report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  console.log(`\n${findings.length} visits · ${failing.length} with overflow or critical/serious axe violations`);
  for (const item of failing) {
    console.log(
      `  ${item.screen} ${item.viewport} ${item.scheme}: ${item.overflowX ? `overflow ${item.scrollWidth}px ` : ''}${item.violations
        .map((violation) => `${violation.id}(${violation.impact}) ${violation.targets.slice(0, 3).join(' | ')}`)
        .join('; ')}`,
    );
  }
  if (failing.length > 0 && !reportOnly) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
