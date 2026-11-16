#!/usr/bin/env node
// UI evidence for OhMyDate: screenshots plus an accessibility and overflow
// sweep, against the synthetic MSW mock (VITE_MOCK=1). No real API, account
// or personal data is involved.
//
//   node scripts/ui-screenshots.mjs                       # every flow, into docs/ui-polish/holo-04
//   node scripts/ui-screenshots.mjs --flows loop,capture  # some of them
//   node scripts/ui-screenshots.mjs --flows canvas --label holo-05   # 할 일, the canvas (HOLO-05)
//   node scripts/ui-screenshots.mjs --only 10-capture     # screens whose name starts with this
//   node scripts/ui-screenshots.mjs --url http://127.0.0.1:5197   # a dev server that is already up
//   node scripts/ui-screenshots.mjs --report-only         # never exit 1
//
// HOLO-04 rewrote the flows around the loop (FLOW.md): 담기 → 계획 → 오늘 →
// 집중 → 돌아보기 → 다시 맞추기, the places of the sidebar, and the first run.
//
// Every screen is visited at 1440×900, 1024×768, 390×844 and 360×780, in the
// dark theme (the default) and the light theme. axe-core (WCAG 2.0–2.2 A/AA)
// and a horizontal-overflow check run on every visit. Screenshots are kept at
// 1440 and 390 in the dark theme, and in the light theme for the screens of
// LIGHT_CAPTURES. Output: docs/ui-polish/<label>/<screen>-<viewport>[-light].png
// and sweep-report.json. Exit code 1 on any critical/serious violation or
// horizontal overflow (unless --report-only).
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

const label = arg('label', 'holo-04');
const only = arg('only', '');
const flowFilter = arg('flows', '')
  .split(',')
  .map((name) => name.trim())
  .filter((name) => name.length > 0);
const port = Number(arg('port', '5199'));
const reportOnly = process.argv.includes('--report-only');
let baseUrl = arg('url', '');
const outDir = join(webRoot, 'docs', 'ui-polish', label);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, capture: true },
  { name: 'tablet', width: 1024, height: 768, capture: false },
  { name: 'mobile', width: 390, height: 844, capture: true },
  { name: 'narrow', width: 360, height: 780, capture: false },
];
// The theme is the owner's choice (dark by default), not the system's.
const SCHEMES = ['dark', 'light'];
const LIGHT_CAPTURES = /^(00-overview|02-first-run-hours|10-capture-drafts|11-capture-done|30-planner-week|33-planner-list|40-focus-next|63-settings-display|70-login|90-canvas$|91-canvas-detail|95-canvas-list)/;
// The mock's signed-in owner (src/mocks/db.ts USER_ID): the theme is stored per owner.
const MOCK_OWNER_ID = '01900000-0000-7000-8000-000000000002';
const NOTE_THESIS_ID = '01900000-0000-7000-8000-0000000003a1';
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
// Mock "today" is 2026-11-14 (Asia/Seoul); the clock is pinned so captures are stable.
const FIXED_NOW = new Date('2026-11-14T09:40:00.000Z');
const NEW_OWNER = { owner: 'new', month: 'none', sessions: 'none' };

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

/**
 * One visit: axe, the overflow check and (where kept) a capture.
 * `within` narrows axe to one part of the page. It is for a floating part that
 * has no scrim (the account menu): what it covers for a moment is not a target
 * while it is open, and axe would report a page button that shows as a sliver
 * beside the menu as too small. The page under it has its own visit.
 */
async function checkpoint(page, name, run, within) {
  if (only.length > 0 && !name.startsWith(only)) return;
  const { viewport, scheme } = run;
  await settle(page);

  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  const builder = new AxeBuilder({ page }).withTags(AXE_TAGS);
  const axe = await (within === undefined ? builder : builder.include(within)).analyze();
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
  const flags = [
    overflowX ? `overflow-x ${overflow.scrollWidth}px` : '',
    blocking.length ? `${blocking.length} axe (${blocking.map((item) => `${item.id}: ${item.targets[0] ?? ''}`).join('; ')})` : '',
  ]
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
}

async function newPage(browser, run, overrides, options = {}) {
  const context = await browser.newContext({
    viewport: { width: run.viewport.width, height: run.viewport.height },
    deviceScaleFactor: 1,
    colorScheme: run.scheme,
    // Everything is captured still; `motion` lets the 할 일 canvas sway for one capture.
    reducedMotion: options.motion === true ? 'no-preference' : 'reduce',
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
  // The run's theme, as the app itself stores it (the owner pointer and that
  // owner's theme slot), so the first frame is already in it.
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
  await page.locator('.app-shell:not(.app-shell--loading), .auth-page').first().waitFor();
}

const isWide = (run) => run.viewport.width >= 1024;

/** One page per flow; `screens` are visited in order on it. */
async function withPage(browser, run, overrides, visit, options) {
  const { context, page } = await newPage(browser, run, overrides, options);
  try {
    await visit(page);
  } finally {
    await context.close();
  }
}

/** Open the capture bar: the top bar's field on a wide window, the nav's 담기 sheet below that. */
async function openCapture(page, run) {
  if (isWide(run)) await page.locator('.app-topbar [data-capture-input]').click();
  else await page.locator('[data-nav-capture]').click();
  await page.locator('[data-capture-panel]').filter({ visible: true }).first().waitFor();
}

function captureInput(page) {
  return page.locator('[data-capture-input]').filter({ visible: true }).first();
}

// ── The places: every screen of the sidebar, as a returning owner sees it ────
async function flowPlaces(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();
    await checkpoint(page, '00-overview', run);

    // 할 일 is the canvas (HOLO-05); its states have a flow of their own (`canvas`).
    await go(page, '/tasks');
    await page.locator('[data-todo-canvas] [data-todo]').first().waitFor();
    await checkpoint(page, '20-tasks-canvas', run);
    await go(page, '/tasks?view=list');
    await page.locator('[data-inbox] .task-item').first().waitFor();
    await checkpoint(page, '21-tasks-list', run);

    await go(page, '/plan');
    await page.locator('.plan-rail').waitFor();
    await checkpoint(page, '25-plan-goal', run);
    await go(page, '/plan/schedule');
    await page.locator('[data-plan-scope], .plan-scope, .page').first().waitFor();
    await checkpoint(page, '26-plan-scope', run);

    await go(page, '/planner');
    await page.locator('[data-planner="week"]').waitFor();
    await checkpoint(page, '30-planner-week', run);
    await go(page, '/planner?view=day');
    await page.locator('[data-planner="day"]').waitFor();
    await checkpoint(page, '31-planner-day', run);
    await go(page, '/planner?view=month');
    await page.locator('[data-month-title]').waitFor();
    await checkpoint(page, '32-planner-month', run);
    await go(page, '/planner?view=list');
    await page.locator('[data-planner-list]').waitFor();
    await checkpoint(page, '33-planner-list', run);
    await page.locator('[data-commitment-edit]').first().click();
    await page.locator('[data-planner-edit]').waitFor();
    await checkpoint(page, '34-planner-edit', run);
    await page.keyboard.press('Escape');

    await go(page, '/focus');
    await page.locator('[data-tracker-idle], [data-tracker-start]').first().waitFor();
    await checkpoint(page, '45-focus-home', run);

    await go(page, '/insights');
    await page.locator('.insights-page, [data-insights]').first().waitFor();
    await checkpoint(page, '50-insights', run);

    await go(page, '/notes');
    await page.locator('[data-note-item]').first().waitFor();
    await checkpoint(page, '55-notes', run);
    await go(page, `/notes/${NOTE_THESIS_ID}`);
    await page.locator('[data-note-status]').waitFor();
    await checkpoint(page, '56-note-open', run);

    for (const [index, section] of ['availability', 'calendar', 'ai', 'display'].entries()) {
      await go(page, `/settings/${section}`);
      await page.locator(`[data-settings-section="${section}"] .settings-section`).waitFor();
      await checkpoint(page, `6${index}-settings-${section}`, run);
    }
  });
}

// ── The shell: what floats (menus, sheets, dialogs) ─────────────────────────
async function flowShell(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();
    await page.locator('[data-user-menu]').click();
    await page.locator('#topbar-user-menu').waitFor();
    await checkpoint(page, '80-account-menu', run, '.app-topbar');
    await page.keyboard.press('Escape');

    await page.locator('.topbar-bell').click();
    await page.getByRole('dialog', { name: '알림' }).waitFor();
    await checkpoint(page, '81-notifications', run);
    await page.keyboard.press('Escape');

    await page.keyboard.press('?');
    await page.getByRole('dialog', { name: '키보드 단축키' }).waitFor();
    await checkpoint(page, '82-help', run);
    await page.keyboard.press('Escape');

    if (!isWide(run)) {
      await page.locator('[data-nav-more]').click();
      await page.getByRole('dialog', { name: '더 보기' }).waitFor();
      await checkpoint(page, '83-more-sheet', run);
      await page.keyboard.press('Escape');
    }
  });
  await withPage(browser, run, undefined, async (page) => {
    await page.addInitScript(() => window.localStorage.removeItem('ohmydate.focus.owner'));
    await go(page, '/login');
    await page.getByRole('heading', { name: 'OhMyDate에 로그인' }).waitFor();
    await checkpoint(page, '70-login', run);
  });
}

// ── ① 담기: the capture bar, from a line to the hand-off; and the search ─────
async function flowCapture(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/planner');
    await page.locator('[data-planner="week"]').waitFor();
    await openCapture(page, run);
    await captureInput(page).fill('금요일까지 보고서 초안, 내일 장보기');
    await checkpoint(page, '10-capture-line', run);
    await page.keyboard.press('Enter');
    await page.locator('[data-capture-row]').filter({ visible: true }).first().waitFor();
    await checkpoint(page, '10-capture-drafts', run);
    await page.locator('[data-capture-flip]').filter({ visible: true }).first().click();
    await checkpoint(page, '10-capture-flipped', run);
    await page.locator('[data-capture-flip]').filter({ visible: true }).first().click();
    await page.locator('[data-capture-submit]').filter({ visible: true }).first().click();
    await page.locator('[data-capture-done]').filter({ visible: true }).first().waitFor();
    await checkpoint(page, '11-capture-done', run);
    // The hand-off: 계획에 넣기, with what was just put down picked.
    await page.locator('[data-capture-next="plan"]').filter({ visible: true }).first().click();
    await page.waitForURL(/\/plan\/schedule\?taskIds=/);
    await checkpoint(page, '12-capture-to-plan', run);
  });
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();
    await openCapture(page, run);
    await page.locator('[data-capture-mode-button="search"]').filter({ visible: true }).first().click();
    await captureInput(page).fill('논문');
    await page.locator('[data-capture-result]').filter({ visible: true }).first().waitFor();
    await checkpoint(page, '13-capture-search', run);
  });
}

// ── ③ → ④ → ⑤: start the next block, finish it, review, the next step, the recap ─
async function flowLoop(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-primary="start"]').waitFor();
    await page.locator('[data-primary="start"]').click();
    await page.waitForURL(/\/focus\//);
    await page.locator('.focus-timer').waitFor();
    await checkpoint(page, '40-focus-running', run);
    await page.getByRole('button', { name: /^완료/ }).first().click();
    await page.getByRole('heading', { name: '이번 세션은 어땠나요?' }).waitFor();
    await checkpoint(page, '40-focus-review', run);
    await page.locator('.review-submit').click();
    await page.locator('[data-focus-next]').waitFor();
    await checkpoint(page, '40-focus-next', run);
    // 오늘은 여기까지 → the recap on 개요.
    await page.locator('[data-focus-next-done]').click();
    await page.locator('[data-day-recap]').waitFor();
    await checkpoint(page, '41-overview-recap', run);
  });
  // ⑥ 다시 맞추기: a proposal waits on 개요 and opens before → after.
  await withPage(browser, run, { replan: 'pending' }, async (page) => {
    await go(page, '/overview');
    await page.locator('.replan-card, [data-replan-card]').first().waitFor();
    await checkpoint(page, '42-overview-replan', run);
    await go(page, '/replan');
    await page.locator('.replan-page, [data-replan]').first().waitFor();
    await checkpoint(page, '43-replan', run);
  });
  // A running session: the now pill, and 개요 saying so.
  await withPage(browser, run, { sessions: 'running' }, async (page) => {
    await go(page, '/planner');
    await page.locator('[data-now-pill][data-now="active"]').waitFor();
    await checkpoint(page, '44-now-pill-running', run);
  });
}

// ── 처음 한 번: the three steps, the ending, and 개요's 시작 마무리 card ─────
async function flowFirstRun(browser, run) {
  await withPage(browser, run, NEW_OWNER, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-first-run-step="hours"]').waitFor();
    await checkpoint(page, '02-first-run-hours', run);
    await page.locator('[data-first-run] [data-preset]').first().check();
    await page.locator('[data-first-run-next]').click();
    await page.locator('[data-first-run-step="commitments"]').waitFor();
    await checkpoint(page, '03-first-run-commitments', run);
    await page.locator('[data-first-run-next]').click();
    await page.locator('[data-first-run-step="ai"]').waitFor();
    await checkpoint(page, '04-first-run-ai', run);
    await page.locator('[data-first-run-skip]').click();
    await page.locator('[data-first-run-step="ready"]').waitFor();
    await checkpoint(page, '05-first-run-ready', run);
  });
  await withPage(browser, run, NEW_OWNER, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-first-run-step="hours"]').waitFor();
    await page.locator('[data-first-run-close]').click();
    await page.locator('[data-setup-card]').waitFor();
    await checkpoint(page, '06-overview-setup-card', run);
    // Empty states lead back a stage.
    await go(page, '/tasks');
    await page.locator('[data-canvas-empty]').waitFor();
    await checkpoint(page, '07-tasks-empty', run);
    await go(page, '/planner?view=list');
    await page.locator('[data-planner-list-empty]').waitFor();
    await checkpoint(page, '08-planner-list-empty', run);
  });
}

// ── 할 일, the canvas (HOLO-05): its states, and how many it holds ───────────
async function canvasReady(page) {
  await page.locator('[data-todo-canvas]').waitFor();
}

/** A to-do's capsule, by its title. */
function capsule(page, title) {
  return page.locator('[data-todo]').filter({ has: page.getByText(title, { exact: true }) });
}

async function flowCanvas(browser, run) {
  // The composed field: about thirty to-dos, three folders, still (reduced motion).
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/tasks');
    await canvasReady(page);
    await capsule(page, '영어 회화 과제').waitFor();
    await checkpoint(page, '90-canvas', run);

    // The one floating detail, by the keyboard.
    await capsule(page, '영어 회화 과제').focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-todo-card]').waitFor();
    await checkpoint(page, '91-canvas-detail', run);
    await page.keyboard.press('Escape');

    // Three picked: the head's button carries them to the plan.
    for (const title of ['도서관 책 반납', '세미나 발표 자료', '통계 과제 2번 풀이']) {
      await capsule(page, title).focus();
      await page.keyboard.press('Space');
    }
    await page.locator('[data-canvas-selection]').waitFor();
    await checkpoint(page, '92-canvas-selection', run);

    // 폴더로 옮기기, from the keyboard.
    await page.keyboard.press('v');
    await page.locator('[data-folder-picker]').waitFor();
    // A floating menu with no scrim: what it covers for a moment is not a target while it is open.
    await checkpoint(page, '93-canvas-picker', run, '[data-folder-picker]');
    await page.keyboard.press('Escape');
    await page.locator('[data-canvas-selection-clear]').click();

    // A folder's menu, open.
    await page.locator('[data-folder-menu-button]').first().click();
    await page.locator('[data-folder-menu]').waitFor();
    await checkpoint(page, '94-canvas-folder-menu', run, '[data-folder-menu]');
    await page.keyboard.press('Escape');

    // One folder folded to a single object beside two that are open.
    await page.locator('[data-folder-fold]').first().click();
    await page.locator('[data-folder-unfold]').waitFor();
    await checkpoint(page, '94-canvas-folder-folded', run);
    await page.locator('[data-folder-unfold]').click();

    // 폴더 만들기.
    await page.locator('[data-new-folder]').click();
    await page.locator('[data-new-folder-dialog]').waitFor();
    await checkpoint(page, '94-canvas-new-folder', run);
    await page.keyboard.press('Escape');

    // 목록으로 보기: the same to-dos as rows.
    await page.locator('[data-tasks-view-link="list"]').click();
    await page.locator('[data-tasks-list] .task-item').first().waitFor();
    await checkpoint(page, '95-canvas-list', run);
  });

  // The same field with motion allowed: it sways a few pixels (captured a moment in).
  await withPage(
    browser,
    run,
    undefined,
    async (page) => {
      await go(page, '/tasks');
      await canvasReady(page);
      await capsule(page, '영어 회화 과제').waitFor();
      await page.waitForTimeout(1500);
      await checkpoint(page, '90-canvas-motion', run);
    },
    { motion: true },
  );

  // Five, and two hundred.
  await withPage(browser, run, { todos: 'few' }, async (page) => {
    await go(page, '/tasks');
    await canvasReady(page);
    await page.locator('[data-todo]').first().waitFor();
    await checkpoint(page, '96-canvas-few', run);
  });
  await withPage(browser, run, { todos: 'many' }, async (page) => {
    await go(page, '/tasks');
    await canvasReady(page);
    await page.locator('[data-canvas-more-button]').waitFor();
    await checkpoint(page, '97-canvas-many', run);
    await page.locator('[data-canvas-more-button]').click();
    await page.locator('[data-canvas-less-button]').waitFor();
    await checkpoint(page, '97-canvas-many-all', run);
  });

  // Nothing put down yet: the capture bar is the invitation.
  await withPage(browser, run, NEW_OWNER, async (page) => {
    await go(page, '/tasks');
    await page.locator('[data-first-run-close]').click().catch(() => undefined);
    await page.locator('[data-canvas-empty]').waitFor();
    await checkpoint(page, '98-canvas-empty', run);
  });
}

const FLOWS = { places: flowPlaces, shell: flowShell, capture: flowCapture, loop: flowLoop, 'first-run': flowFirstRun, canvas: flowCanvas };

async function main() {
  await mkdir(outDir, { recursive: true });
  let vite = null;
  if (baseUrl.length === 0) {
    vite = await startVite();
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const browser = await chromium.launch();
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const run = { viewport, scheme };
        console.log(`${scheme} ${viewport.name} (${viewport.width}x${viewport.height})`);
        for (const [name, flow] of Object.entries(FLOWS)) {
          if (flowFilter.length > 0 && !flowFilter.includes(name)) continue;
          try {
            await flow(browser, run);
          } catch (cause) {
            findings.push({ screen: `flow:${name}`, viewport: `${viewport.width}x${viewport.height}`, scheme, error: String(cause).slice(0, 400) });
            console.log(`  ! flow ${name} stopped: ${String(cause).split('\n')[0]}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
    vite?.kill();
  }
  const bad = findings.filter((entry) => entry.error !== undefined || entry.overflowX === true || (entry.violations?.length ?? 0) > 0);
  await writeFile(
    join(outDir, 'sweep-report.json'),
    `${JSON.stringify({ generatedFor: label, checks: findings.length, failing: bad.length, findings: bad }, null, 2)}\n`,
  );
  console.log(`${findings.length} checks, ${bad.length} failing → docs/ui-polish/${label}/sweep-report.json`);
  if (bad.length > 0 && !reportOnly) process.exitCode = 1;
}

await main();
