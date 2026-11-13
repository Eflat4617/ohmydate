#!/usr/bin/env node
// UI-POLISH evidence: screenshots + a11y/overflow sweep against the synthetic
// MSW mock (VITE_MOCK=1). No real API, accounts or personal data are involved.
//
//   node scripts/ui-screenshots.mjs --label after-ko         # spawns vite on :5199 (Korean UI, UI-I18N)
//   node scripts/ui-screenshots.mjs --label before --url http://127.0.0.1:5199
//   node scripts/ui-screenshots.mjs --label after --only 14-today
//   node scripts/ui-screenshots.mjs --label m5-03 --flows replan,patterns   # M5-03 screens only
//   node scripts/ui-screenshots.mjs --label m6-02 --flows adaptive          # M6-02 layout modes
//   node scripts/ui-screenshots.mjs --label m6-03 --flows notes             # M6-03 notes screens
//   node scripts/ui-screenshots.mjs --label cal-01 --flows month,daily      # CAL-01 한달 + Today's 약속/마감
//   node scripts/ui-screenshots.mjs --label cal-04 --flows calendar --tablet # CAL-04 캘린더 연동, every status (+1024px)
//   node scripts/ui-screenshots.mjs --label holo-01 --flows overview --tablet # HOLO-01 개요, every state (+1024px)
//
// Output: docs/ui-polish/<label>/<screen>-<viewport>[-light][-full].png and
//         docs/ui-polish/<label>/sweep-report.json
// Every screen is visited at 390×844, 1440×900 and 360×780 (check-only), in
// the dark theme (the default since HOLO-01) and the light theme. Screenshots
// are kept for every dark screen and for the screens of LIGHT_CAPTURES in
// light; axe-core (WCAG 2.0–2.2 A/AA tags) and a horizontal overflow check
// run on every visit, in both themes. Exit code 1 if any critical/serious
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
// Comma-separated subset of flows (overview, main, daily, ai, replan, patterns, adaptive, notes, month, calendar); default: all.
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
// --tablet adds the width where the nav rail first appears (1024px).
if (process.argv.includes('--tablet')) VIEWPORTS.push({ name: 'tablet', width: 1024, height: 768, capture: true });
// HOLO-01: the theme is the user's choice (dark by default), not the system's.
const SCHEMES = ['dark', 'light'];
const LIGHT_CAPTURES = /^(00-overview|14-today|16-focus|22-today-replan|23-replan-detail|29-patterns|34-layout-overview|35-layout-focus|42-notes-list|43-notes-editor|50-wizard-evidence|52-month|56-calendar|57-calendar|58-calendar|59-calendar|60-calendar|61-calendar|64-commitments-google|66-month-labels)/;
const FULL_CAPTURES = /^(09-wizard-step4|11-plan-comparison|12-availability|13-commitments|14-today|17-review|23-replan-detail|25-replan-list|28-replan-suppressed|29-patterns|34-layout-overview|38-layout-deadline-risk|39-layout-review|43-notes-editor|50-wizard-evidence|52-month|53-month-day|56-calendar-not-configured|58-calendar-connected|60-calendar-needs-reauth|64-commitments-google)/;
// The mock's signed-in owner (src/mocks/db.ts USER_ID): the theme is stored per owner.
const MOCK_OWNER_ID = '01900000-0000-7000-8000-000000000002';
// Synthetic ids from src/mocks/notes-seed.ts (M6-03).
const NOTE_THESIS_ID = '01900000-0000-7000-8000-0000000003a1';
const NOTE_MEETING_ID = '01900000-0000-7000-8000-0000000003a2';
const SAMPLE_PROJECT_ID = '01900000-0000-7000-8000-000000000003';
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

  const keep = viewport.capture && (scheme === 'dark' || LIGHT_CAPTURES.test(name));
  if (!keep) {
    if (flags) console.log(`  ! ${name} ${viewport.name} ${scheme}: ${flags}`);
    return;
  }
  const suffix = scheme === 'light' ? '-light' : '';
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
  // HOLO-01: the run's theme, as the app itself stores it (the owner pointer
  // and that owner's theme slot), so the first frame is already in it.
  await page.addInitScript(
    ({ owner, theme }) => {
      window.localStorage.setItem('ohmydate.focus.owner', owner);
      window.localStorage.setItem(`ohmydate.theme:${owner}`, theme);
    },
    { owner: MOCK_OWNER_ID, theme: run.scheme },
  );
  return { context, page };
}

async function go(page, path) {
  await page.goto(`${baseUrl}${path}`);
  await page.waitForFunction(() => document.querySelector('#app')?.childElementCount > 0);
}

function isMobile(run) {
  return run.viewport.width < 1024;
}

// HOLO-01 개요: the dashboard with a week of sessions, with a session running,
// with nothing recorded yet, and without AI consent.
async function flowOverview(browser, run) {
  const ready = async (page) => {
    await page.locator('[data-overview]').waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-widget]').length === 5 &&
        document.querySelectorAll('[data-widget][data-state="loading"]').length === 0,
    );
  };

  const full = await newPage(browser, run);
  await go(full.page, '/overview');
  await ready(full.page);
  await full.page.getByRole('heading', { level: 1, name: /님, 좋은 (아침|오후|저녁)(이에요|예요)$/ }).waitFor();
  await full.page.locator('[data-widget="progress"] [data-chart="bars"]').waitFor();
  await dismissToasts(full.page);
  await checkpoint(full.page, '00-overview', run);
  await full.page.getByRole('button', { name: '이전 주' }).click();
  await ready(full.page);
  await checkpoint(full.page, '00-overview-last-week', run);
  await full.context.close();

  const running = await newPage(browser, run, { sessions: 'running' });
  await go(running.page, '/overview');
  await ready(running.page);
  await running.page.locator('.tracker-well[data-status="active"]').waitFor();
  await dismissToasts(running.page);
  await checkpoint(running.page, '00-overview-running', run);
  await running.context.close();

  const empty = await newPage(browser, run, { sessions: 'none', estimation: 'cold', month: 'none' });
  await go(empty.page, '/overview');
  await ready(empty.page);
  await empty.page.locator('[data-widget="log"] [data-empty]').waitFor();
  await dismissToasts(empty.page);
  await checkpoint(empty.page, '00-overview-empty', run);
  await empty.context.close();

  const consent = await newPage(browser, run, { llmProvider: 'deepseek' });
  await go(consent.page, '/overview');
  await consent.page.getByRole('dialog').waitFor();
  await consent.page.getByRole('button', { name: '직접 작성 모드로 쓰기' }).click();
  await consent.page.getByRole('dialog').waitFor({ state: 'detached' });
  await ready(consent.page);
  await consent.page.locator('[data-ai-consent]').waitFor();
  await dismissToasts(consent.page);
  await checkpoint(consent.page, '00-overview-no-consent', run);
  await consent.context.close();
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
    // HOLO-01: the notifications button is in the top bar.
    await page.locator('.app-topbar').getByRole('button', { name: '알림' }).click();
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
    // HOLO-01: the notifications button is in the top bar.
    await page.locator('.app-topbar').getByRole('button', { name: '알림' }).click();
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

async function openNote(page, id) {
  await go(page, `/notes/${id}`);
  await page.locator('[data-note-title]').waitFor();
  await page.locator('[data-note-ai-usage]').waitFor();
}

// M6-03 notes screens (07 §3.5): list, editor with the safe preview, link
// picker, AI usage, the 412 conflict and delete dialogs, the project notes
// tab, the task detail with "설명을 노트로 승격", the wizard's reference notes
// with draft evidence, and RelatedNotes in the focus layout.
async function flowNotes(browser, run) {
  {
    const { context, page } = await newPage(browser, run);
    await go(page, isMobile(run) ? '/notes' : `/notes/${NOTE_THESIS_ID}`);
    await layoutMode(page, 'notes');
    await page.locator('[data-note-item]').first().waitFor();
    await dismissToasts(page);
    await checkpoint(page, '42-notes-list', run);

    await openNote(page, NOTE_THESIS_ID);
    await dismissToasts(page);
    await checkpoint(page, '43-notes-editor', run);

    await page.locator('[data-note-link-add]').click();
    await page.getByRole('dialog', { name: '연결할 대상 고르기' }).waitFor();
    await page.locator('input[name="link-picker-kind"][value="task"]').check();
    await checkpoint(page, '44-notes-link-picker', run);
    await page.getByRole('button', { name: '취소' }).click();

    await page.locator('[data-note-ai-usage]').scrollIntoViewIfNeeded();
    await checkpoint(page, '45-notes-ai-usage', run);

    // Another device saved meanwhile: the next save answers 412.
    await page.locator('[data-note-mode="edit"]').check();
    await page.locator('[data-note-body]').fill('# 졸업 논문 참고 문헌\n\n오프라인에서 고친 내용');
    await page.evaluate((id) => {
      const note = window.__OHMYDATE_MOCK_DB__?.notes.documents.get(id);
      if (note !== undefined) {
        note.version += 2;
        note.title = '졸업 논문 참고 문헌 (다른 기기)';
      }
    }, NOTE_THESIS_ID);
    await page.locator('[data-note-save]').click();
    await page.getByRole('alertdialog', { name: '다른 곳에서 이 노트가 바뀌었어요' }).waitFor();
    await checkpoint(page, '46-notes-conflict', run);
    await page.getByRole('button', { name: '서버 내용 불러오기' }).click();

    await page.locator('[data-note-delete]').click();
    await page.getByRole('alertdialog', { name: '노트를 삭제할까요?' }).waitFor();
    await checkpoint(page, '47-notes-delete-confirm', run);
    await page.getByRole('button', { name: '취소' }).click();

    await go(page, `/projects/${SAMPLE_PROJECT_ID}?tab=notes`);
    await page.locator('[data-project-notes] [data-linked-note]').first().waitFor();
    await dismissToasts(page);
    await checkpoint(page, '48-project-notes-tab', run);

    // A full load re-creates the in-page mock database: seed the description,
    // then open the task from its row (in-app navigation keeps the data).
    await go(page, '/inbox');
    await page.locator('[data-task-detail-link]').first().waitFor();
    await page.evaluate(() => {
      const tasks = [...(window.__OHMYDATE_MOCK_DB__?.tasks.values() ?? [])];
      const task = tasks.find((item) => item.title === '주간 계획 돌아보기');
      if (task !== undefined) task.description = '<p>지난주 회고 메모: <b>집중 시간</b>이 부족했음.</p><p>다음 주에는 오전에 블록을 먼저 잡기.</p>';
    });
    await page.locator('[data-task-detail-link]', { hasText: '주간 계획 돌아보기' }).click();
    await page.locator('[data-task-description]').waitFor();
    await dismissToasts(page);
    await checkpoint(page, '49-task-detail', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/plan/new');
    await page.locator('#wizard-title').fill('졸업 논문 실험 계획');
    await page.getByRole('button', { name: '다음' }).click();
    await page.locator('[data-wizard-notes]').waitFor();
    await page.locator('[data-wizard-notes-add]').click();
    const picker = page.getByRole('dialog', { name: '참고할 노트 고르기' });
    await picker.waitFor();
    await picker.getByRole('button', { name: '“졸업 논문 참고 문헌” 이 계획에 연결' }).click();
    await picker.getByText('연결됨').waitFor();
    await picker.getByRole('button', { name: '닫기' }).click();
    for (let guard = 0; guard < 12; guard += 1) {
      if (await page.getByRole('heading', { name: '4단계 · 단계 초안' }).isVisible()) break;
      const card = page.locator('.question-card').first();
      if ((await card.count()) === 0) {
        await page.waitForTimeout(150);
        continue;
      }
      await card.getByRole('button', { name: '건너뛰기' }).click();
      await page.waitForTimeout(200);
    }
    await page.locator('[data-wizard-evidence] .evidence-note-title').first().waitFor();
    await page.locator('[data-wizard-evidence]').scrollIntoViewIfNeeded();
    await dismissToasts(page);
    await checkpoint(page, '50-wizard-evidence', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run, { notes: 'focus' });
    await go(page, '/today');
    await page.locator('.today-card').first().waitFor();
    await page.getByRole('button', { name: '집중 시작' }).first().click();
    await layoutMode(page, 'focus');
    await page.locator(`[data-related-note="${NOTE_MEETING_ID}"]`).waitFor();
    await dismissOtherToasts(page, '레이아웃이 바뀌었어요');
    await page.locator('[data-panel="related-notes"]').scrollIntoViewIfNeeded();
    await checkpoint(page, '51-focus-related-notes', run);
    await context.close();
  }
}

// CAL-01: the month page (한달) on the seeded November (src/mocks/db.ts
// seedMonth): this month with today picked, another day picked, the next
// month, and a month with nothing planned (October has none).
async function monthReady(page) {
  await page.locator('.month-grid:not([aria-busy])').waitFor();
}

async function flowMonth(browser, run) {
  const { context, page } = await newPage(browser, run);
  await go(page, '/month');
  await monthReady(page);
  await page.locator('[data-month-detail] .month-agenda-item').first().waitFor();
  await dismissToasts(page);
  await checkpoint(page, '52-month', run);

  await page.locator('[role="gridcell"][data-date="2026-11-20"]').click();
  await page.locator('[data-month-detail] h2', { hasText: '11월 20일' }).waitFor();
  await checkpoint(page, '53-month-day', run);

  await page.locator('[data-month-next]').click();
  await page.getByRole('heading', { name: '2026년 12월', level: 1 }).waitFor();
  await monthReady(page);
  await checkpoint(page, '54-month-next', run);

  await go(page, '/month?m=2026-10');
  await monthReady(page);
  await page.locator('[data-month-empty]').waitFor();
  await dismissToasts(page);
  await checkpoint(page, '55-month-empty', run);
  await context.close();
}

// CAL-04: 캘린더 연동 in every status of the mock state machine
// (src/mocks/google.ts, picked through __OHMYDATE_MOCK__.google), the
// messages after coming back from Google, the disconnect dialog, and the
// imported items on 약속 and 한달.
async function calendarReady(page, status) {
  await page.locator(`[data-google-status="${status}"]`).waitFor();
}

async function flowCalendar(browser, run) {
  for (const [name, google, status] of [
    ['56-calendar-not-configured', 'not_configured', 'not_configured'],
    ['57-calendar-disconnected', 'disconnected', 'disconnected'],
    ['60-calendar-needs-reauth', 'needs_reauth', 'needs_reauth'],
    ['61-calendar-partial', 'partial', 'connected'],
  ]) {
    const { context, page } = await newPage(browser, run, { google });
    await go(page, '/settings/calendar');
    await calendarReady(page, status);
    await dismissToasts(page);
    await checkpoint(page, name, run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/settings/calendar');
    await calendarReady(page, 'connected');
    await dismissToasts(page);
    await checkpoint(page, '58-calendar-connected', run);
    await page.locator('[data-google-disconnect]').click();
    await page.getByRole('alertdialog', { name: '구글 연결을 끊을까요?' }).waitFor();
    await checkpoint(page, '59-calendar-disconnect-dialog', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/settings/calendar?google=connected');
    await page.locator('[data-google-returned="connected"]').waitFor();
    await calendarReady(page, 'connected');
    await dismissToasts(page);
    await checkpoint(page, '62-calendar-returned', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run, { google: 'disconnected' });
    await go(page, '/settings/calendar?google=denied');
    await page.locator('[data-google-returned="denied"]').waitFor();
    await dismissToasts(page);
    await checkpoint(page, '63-calendar-denied', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/commitments');
    await page.locator('.commitment-item[data-source="google"]').first().waitFor();
    await dismissToasts(page);
    await checkpoint(page, '64-commitments-google', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run, { google: 'needs_reauth' });
    await go(page, '/commitments');
    await page.locator('[data-google-stale]').waitFor();
    await dismissToasts(page);
    await checkpoint(page, '65-commitments-google-stale', run);
    await context.close();
  }
  {
    const { context, page } = await newPage(browser, run);
    await go(page, '/month');
    await monthReady(page);
    await page.locator('[data-month-day-labels]').first().waitFor({ state: 'attached' });
    await page.locator('[role="gridcell"][data-date="2026-11-28"]').click();
    await page.locator('[data-month-detail-labels]').waitFor();
    await dismissToasts(page);
    await checkpoint(page, '66-month-labels', run);
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
          overview: flowOverview,
          main: flowMain,
          daily: flowDaily,
          ai: flowAi,
          replan: flowReplan,
          patterns: flowPatterns,
          adaptive: flowAdaptive,
          notes: flowNotes,
          month: flowMonth,
          calendar: flowCalendar,
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
