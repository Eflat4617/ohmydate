#!/usr/bin/env node
// UI-POLISH evidence: screenshots + a11y/overflow sweep against the synthetic
// MSW mock (VITE_MOCK=1). No real API, accounts or personal data are involved.
//
//   node scripts/ui-screenshots.mjs --label after-ko         # spawns vite on :5199 (Korean UI, UI-I18N)
//   node scripts/ui-screenshots.mjs --label before --url http://127.0.0.1:5199
//   node scripts/ui-screenshots.mjs --label after --only 14-today
//   node scripts/ui-screenshots.mjs --label m5-03 --flows replan,patterns   # M5-03 screens only
//   node scripts/ui-screenshots.mjs --label m6-02 --flows adaptive          # M6-02 layout modes
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
// Comma-separated subset of flows (main, daily, ai, replan, patterns, adaptive); default: all.
const flowFilter = arg('flows', '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
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
const DARK_CAPTURES = /^(14-today|16-focus|22-today-replan|23-replan-detail|29-patterns|34-layout-overview|35-layout-focus)/;
const FULL_CAPTURES = /^(09-wizard-step4|11-plan-comparison|12-availability|13-commitments|17-review|23-replan-detail|25-replan-list|28-replan-suppressed|29-patterns|34-layout-overview|38-layout-deadline-risk|39-layout-review)/;
// Synthetic ids from src/mocks/replan.ts (M5-03 scenario).
const REPLAN_PENDING_ID = '01900000-0000-7000-8000-0000000002a1';
const REPLAN_EXPIRED_ID = '01900000-0000-7000-8000-0000000002a4';
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
    locale: 'ko-KR',
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
  await page.getByRole('heading', { name: 'OhMyDate에 로그인' }).waitFor();
  await checkpoint(page, '01-login', run);

  await go(page, '/inbox');
  await page.locator('.task-item').first().waitFor();
  await checkpoint(page, '02-inbox', run);

  // Conflict: another "device" bumps the seeded task while we edit it.
  const firstTitle = (await page.locator('.task-item .task-title').first().textContent())?.trim() ?? '';
  await page.getByRole('button', { name: `${firstTitle} 제목 수정` }).click();
  await page.getByLabel('작업 제목').fill(`${firstTitle} (내 수정)`);
  await page.evaluate((title) => {
    const db = window.__OHMYDATE_MOCK_DB__;
    const task = [...db.tasks.values()].find((item) => item.title === title);
    if (task !== undefined) {
      task.version += 1;
      task.title = `${title} (휴대폰에서 수정)`;
      db.taskRevision += 1;
    }
  }, firstTitle);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await checkpoint(page, '03-conflict-dialog', run);
  await page.keyboard.press('Escape');

  await go(page, '/projects');
  await page.locator('.project-list li').first().waitFor();
  await checkpoint(page, '04-projects', run);
  await page.getByRole('link', { name: '졸업 논문' }).click();
  await page.getByRole('heading', { name: '졸업 논문' }).waitFor();
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
  await page.getByRole('heading', { name: '새 일정안' }).waitFor();
  await settle(page);
  const boxes = page.locator('.task-picker input[type="checkbox"]');
  const count = await boxes.count();
  for (let index = 0; index < Math.min(count, 3); index += 1) await boxes.nth(index).check();
  await checkpoint(page, '10-plan-new', run);
  await page.getByRole('button', { name: '후보 만들기' }).click();
  await page.getByRole('heading', { name: /^일정안 비교$/ }).waitFor();
  await page.locator('.candidate-card').first().waitFor();
  await checkpoint(page, '11-plan-comparison', run);

  await go(page, '/settings/availability');
  await page.getByRole('heading', { name: '가용 시간', level: 1 }).waitFor();
  await checkpoint(page, '12-availability', run);

  await go(page, '/commitments');
  await page.getByRole('heading', { name: '약속', level: 1 }).waitFor();
  await checkpoint(page, '13-commitments', run);

  await context.close();
}

async function flowDaily(browser, run) {
  const { context, page } = await newPage(browser, run);
  await go(page, '/today');
  await page.locator('.today-card').first().waitFor();
  await checkpoint(page, '14-today', run);

  await context.setOffline(true);
  await page.getByText(/오프라인이에요/).first().waitFor();
  await checkpoint(page, '15-today-offline', run);
  await context.setOffline(false);
  await page.getByText(/오프라인이에요/).first().waitFor({ state: 'detached' }).catch(() => undefined);

  await page.getByRole('button', { name: '집중 시작' }).first().click();
  await page.locator('.focus-timer').waitFor();
  await page.clock.setFixedTime(new Date(FIXED_NOW.getTime() + (24 * 60 + 37) * 1000));
  await page.waitForTimeout(1200);
  await checkpoint(page, '16-focus', run);

  const calm = page.getByRole('button', { name: '몰입 모드' });
  if ((await calm.count()) > 0) {
    await calm.click();
    await checkpoint(page, '16-focus-calm', run);
    await calm.click();
  }

  await page.getByRole('button', { name: '완료' }).first().click();
  await page.getByRole('heading', { name: '이번 세션은 어땠나요?' }).waitFor();
  await page.getByRole('radio', { name: '일부만' }).check();
  await page.getByRole('checkbox', { name: '생각보다 컸어요' }).check();
  await checkpoint(page, '17-review', run);

  await go(page, '/today');
  await page.locator('.today-card').first().waitFor();
  if (isMobile(run)) {
    const more = page.getByRole('button', { name: '더 보기', exact: true }).filter({ visible: true });
    if ((await more.count()) > 0) {
      await more.first().click();
      await page.getByRole('dialog', { name: '더 보기' }).waitFor();
      await checkpoint(page, '21-more-sheet', run);
      await page.getByRole('dialog', { name: '더 보기' }).getByRole('button', { name: '알림' }).click();
    } else {
      // Pre-polish bottom nav overflows narrow screens, leaving the button off-screen.
      await page.getByRole('button', { name: '알림' }).filter({ visible: true }).first().dispatchEvent('click');
    }
  } else {
    await page.locator('.nav-rail').getByRole('button', { name: '알림' }).click();
  }
  await page.getByRole('dialog', { name: '알림' }).waitFor();
  await checkpoint(page, '18-notifications', run);
  await context.close();
}

async function flowAi(browser, run) {
  const { context, page } = await newPage(browser, run, { llmProvider: 'deepseek' });
  await go(page, '/settings/ai');
  await page.getByRole('dialog').waitFor();
  await checkpoint(page, '19-ai-consent', run);
  await page.getByRole('button', { name: '직접 작성 모드로 쓰기' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.getByRole('heading', { name: 'AI 설정' }).waitFor();
  await checkpoint(page, '20-ai-settings', run);
  await context.close();
}

// Toasts stay up while the clock is pinned; close them so captures show the screen.
async function dismissToasts(page) {
  for (let round = 0; round < 6; round += 1) {
    const close = page.locator('.toast button[aria-label^="메시지 닫기"]').first();
    if ((await close.count()) === 0) return;
    await close.click();
  }
}

async function openNotificationsPanel(page, run) {
  if (isMobile(run)) {
    await page.getByRole('button', { name: '더 보기', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('dialog', { name: '더 보기' }).waitFor();
    await page.getByRole('dialog', { name: '더 보기' }).getByRole('button', { name: '알림' }).click();
  } else {
    await page.locator('.nav-rail').getByRole('button', { name: '알림' }).click();
  }
  await page.getByRole('dialog', { name: '알림' }).waitFor();
}

// M5-03: Today entry point, proposal detail/reject/list/read-only, approve,
// user request → reject → suppressed request. In-app navigation only after
// the first load, because a full reload re-seeds the in-page mock database.
async function flowReplan(browser, run) {
  const { context, page } = await newPage(browser, run, { replan: 'history' });
  await go(page, '/today');
  await page.locator('.today-card').first().waitFor();
  await page.locator('[data-replan-banner]').waitFor();
  await page.locator('.toast').first().waitFor({ timeout: 4000 }).catch(() => undefined);
  await dismissToasts(page);
  await checkpoint(page, '22-today-replan', run);

  await openNotificationsPanel(page, run);
  await page.locator('[data-open-proposal]').first().waitFor();
  await checkpoint(page, '32-notifications-replan', run);
  await page.locator('[data-open-proposal]').first().click();
  await page.locator('.replan-change').first().waitFor();
  await dismissToasts(page);
  await checkpoint(page, '23-replan-detail', run);

  await page.locator('[data-replan-reject]').click();
  await page.getByRole('dialog', { name: '이 제안을 거절할까요?' }).waitFor();
  await checkpoint(page, '24-replan-reject-confirm', run);
  await page.getByRole('dialog').getByRole('button', { name: '취소' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  await page.locator('.breadcrumb a').click();
  await page.locator('.replan-item').first().waitFor();
  await checkpoint(page, '25-replan-list', run);

  await page.locator(`[data-proposal-id="${REPLAN_EXPIRED_ID}"] a`).click();
  await page.locator('[data-readonly]').waitFor();
  await checkpoint(page, '26-replan-expired', run);

  await page.locator('.breadcrumb a').click();
  await page.locator(`[data-proposal-id="${REPLAN_PENDING_ID}"] a`).click();
  // 412: availability changed after the proposal was computed.
  await page.locator('[data-replan-approve]').waitFor();
  await page.evaluate(() => {
    window.__OHMYDATE_MOCK_DB__.availabilityVersion += 1;
  });
  await page.locator('[data-replan-approve]').click();
  await page.getByRole('alertdialog').waitFor();
  await checkpoint(page, '33-replan-conflict', run);
  await page.getByRole('alertdialog').getByRole('button', { name: '새로 고침' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.__OHMYDATE_MOCK_DB__.availabilityVersion -= 1;
  });
  await page.locator('[data-replan-approve]').click();
  await page.locator('[data-readonly]').waitFor();
  await dismissToasts(page);
  await checkpoint(page, '27-replan-approved', run);

  await page.locator('[data-replan-request]').click();
  await page.locator('[data-replan-approve]').waitFor();
  await page.locator('[data-replan-reject]').click();
  await page.getByRole('dialog').getByRole('button', { name: '거절하기' }).click();
  await page.locator('[data-readonly]').waitFor();
  await page.locator('[data-replan-request]').click();
  await page.locator('.replan-suppressed').waitFor();
  await dismissToasts(page);
  await checkpoint(page, '28-replan-suppressed', run);
  await context.close();
}

async function flowPatterns(browser, run) {
  const learned = await newPage(browser, run);
  await go(learned.page, '/patterns');
  await learned.page.locator('.patterns-group').first().waitFor();
  await learned.page.locator('.toast').first().waitFor({ timeout: 4000 }).catch(() => undefined);
  await dismissToasts(learned.page);
  await checkpoint(learned.page, '29-patterns', run);
  await learned.page.locator('[data-reset-all]').click();
  await learned.page.getByRole('alertdialog').waitFor();
  await checkpoint(learned.page, '30-patterns-reset-confirm', run);
  await learned.context.close();

  const cold = await newPage(browser, run, { estimation: 'cold' });
  await go(cold.page, '/patterns');
  await cold.page.locator('[data-cold-start]').waitFor();
  await cold.page.locator('.toast').first().waitFor({ timeout: 4000 }).catch(() => undefined);
  await dismissToasts(cold.page);
  await checkpoint(cold.page, '31-patterns-cold', run);
  await cold.context.close();
}

// M6-02: one capture per adaptive layout mode (07 §2.2) plus the undo toast,
// the undone layout and the settings screen. In-app navigation after the
// first load keeps the in-page mock database (and the local session store).
function layoutMode(page, mode) {
  return page.locator(`.adaptive-frame[data-layout-mode="${mode}"]`).waitFor();
}

async function dismissOtherToasts(page, keep) {
  for (let round = 0; round < 6; round += 1) {
    const close = page
      .locator('.toast')
      .filter({ hasNotText: keep })
      .locator('button[aria-label^="메시지 닫기"]')
      .first();
    if ((await close.count()) === 0) return;
    await close.click();
  }
}

async function navToToday(page, run) {
  const nav = page.locator(isMobile(run) ? '.bottom-nav' : '.nav-rail');
  await nav.getByRole('link', { name: '오늘' }).click();
  await page.waitForURL(/\/today$/);
}

async function flowAdaptive(browser, run) {
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/today');
    await page.locator('.today-card').first().waitFor();
    await layoutMode(page, 'overview');
    await dismissToasts(page);
    await checkpoint(page, '34-layout-overview', run);

    await page.getByRole('button', { name: '집중 시작' }).first().click();
    await layoutMode(page, 'focus');
    await page.locator('.focus-timer').waitFor();
    await page.getByRole('button', { name: '되돌리기' }).waitFor();
    await dismissOtherToasts(page, '레이아웃이 바뀌었어요');
    await checkpoint(page, '35-layout-focus', run);

    await page.getByRole('button', { name: '되돌리기' }).click();
    await page.waitForURL(/\/today$/);
    await layoutMode(page, 'overview');
    await dismissToasts(page);
    await checkpoint(page, '36-layout-undone', run);

    // Finish the running session without a review, then go past 20:00.
    await page.getByRole('button', { name: '세션 이어가기' }).click();
    await layoutMode(page, 'focus');
    await page.getByRole('button', { name: '완료' }).first().click();
    await page.getByRole('heading', { name: '이번 세션은 어땠나요?' }).waitFor();
    await page.clock.setFixedTime(new Date('2026-11-14T11:30:00.000Z'));
    await navToToday(page, run);
    await layoutMode(page, 'review');
    await dismissToasts(page);
    await checkpoint(page, '39-layout-review', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run, { today: 'risk' });
    await go(page, '/today');
    await layoutMode(page, 'deadline_risk');
    await page.locator('[data-panel="deadline-risk"]').waitFor();
    await dismissToasts(page);
    await checkpoint(page, '38-layout-deadline-risk', run);
    await context.close();
  }
  {
    // No risk here: a deadline risk outranks the notes layout (07 §2.2 rule 4 > 6).
    const { context, page } = await newPage(browser, run);
    await go(page, '/plan/new');
    await layoutMode(page, 'planning');
    await page.getByRole('heading', { name: '1단계 · 기본정보' }).waitFor();
    await dismissToasts(page);
    await checkpoint(page, '37-layout-planning', run);

    await go(page, '/notes');
    await layoutMode(page, 'notes');
    await dismissToasts(page);
    await checkpoint(page, '40-layout-notes', run);

    await go(page, '/settings/layout');
    await page.getByRole('heading', { name: '레이아웃', level: 1 }).waitFor();
    await dismissToasts(page);
    await checkpoint(page, '41-layout-settings', run);
    await context.close();
  }
}

// The dev server can reload a page while it optimises deps; retry a flow once
// (findings from the failed attempt are discarded).
async function withRetry(flow, browser, run) {
  const mark = findings.length;
  try {
    await flow(browser, run);
  } catch (error) {
    const detail = String(error?.message ?? error)
      .split('\n')
      .filter((line) => /Timeout|waiting for|intercepts/.test(line))
      .slice(0, 3)
      .join(' / ');
    console.log(`  retrying ${flow.name} (${run.viewport.name} ${run.scheme}): ${detail}`);
    findings.length = mark;
    await flow(browser, run);
  }
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
        const flows = {
          main: flowMain,
          daily: flowDaily,
          ai: flowAi,
          replan: flowReplan,
          patterns: flowPatterns,
          adaptive: flowAdaptive,
        };
        for (const [name, flow] of Object.entries(flows)) {
          if (flowFilter.length > 0 && !flowFilter.includes(name)) continue;
          await withRetry(flow, browser, run);
        }
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
