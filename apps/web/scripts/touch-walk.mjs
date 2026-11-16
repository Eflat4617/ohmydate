#!/usr/bin/env node
// HOLO-07: the loop, walked with a finger. A phone is emulated (touch, a
// mobile viewport, a coarse pointer) against the synthetic MSW mock
// (VITE_MOCK=1) — no real API, account or personal data — and every step is a
// touch: a tap, a long press, a drag, a swipe. Nothing here clicks.
//
//   node scripts/touch-walk.mjs                      # Chromium, 390×844 and 360×780, dark and light
//   node scripts/touch-walk.mjs --browser webkit     # the same walk on WebKit
//   node scripts/touch-walk.mjs --url http://127.0.0.1:5197   # a dev server that is already up
//   node scripts/touch-walk.mjs --only canvas        # walks whose name starts with this
//   node scripts/touch-walk.mjs --report-only        # never exit 1
//
// On Chromium the gestures are real: they go in through the browser's own
// input pipeline (CDP `Input.dispatchTouchEvent`), so the browser itself
// decides what is a scroll and what reaches the page. WebKit has no such door
// in Playwright: there a tap is real (`locator.tap()`), and a long press, a
// drag and a swipe are the pointer events a finger would produce, handed to
// the page — which proves the page's own handling on that engine, not the
// engine's scroll arbitration. What only a real phone can show is listed in
// docs/ui-polish/README.md.
//
// At every stop three things are measured:
//   - no horizontal page scroll;
//   - every tap target is 24px at least in both directions (the floor axe
//     checks); the ones under 44px are listed with their size;
//   - every field's text is 16px at least (no zoom on focus).
// Output: docs/ui-polish/<label>/touch-report-<browser>.json. Exit code 1 on
// a failed step, a horizontal scroll, a target under 24px or a field under 16px.
/* global document, window, getComputedStyle, PointerEvent, Event -- used only inside page.evaluate() browser callbacks */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const engineName = arg('browser', 'chromium');
const label = arg('label', 'holo-07');
const only = arg('only', '');
const port = Number(arg('port', '5196'));
const reportOnly = process.argv.includes('--report-only');
/** `--shots <dir>`: a picture of every stop of the first run (390 wide, dark), for looking at. */
const shotsDir = arg('shots', '');
let baseUrl = arg('url', '');
const outDir = join(webRoot, 'docs', 'ui-polish', label);

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 360, height: 780 },
];
const SCHEMES = ['dark', 'light'];
// The mock's signed-in owner (src/mocks/db.ts USER_ID): the theme is stored per owner.
const MOCK_OWNER_ID = '01900000-0000-7000-8000-000000000002';
// Mock "today" is 2026-11-14 (Asia/Seoul).
const FIXED_NOW = new Date('2026-11-14T09:40:00.000Z');
/** What a touch browser waits before a press is a long press; the canvas arms its hold sooner (280ms). */
const LONG_PRESS_MS = 450;
const FLOOR = 24;
const COMFORT = 44;

const findings = [];
const small = new Map();
let steps = 0;

async function startVite() {
  const child = spawn(join(webRoot, 'node_modules', '.bin', 'vite'), ['--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: webRoot,
    env: { ...process.env, VITE_MOCK: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('vite did not start')), 30_000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('Local:')) {
        clearTimeout(timer);
        done(undefined);
      }
    });
    child.on('exit', (code) => fail(new Error(`vite exited ${code}`)));
  });
  return child;
}

// ── A finger ────────────────────────────────────────────────────────────────
/** `run.touch` is the CDP session on Chromium, null on WebKit. */
async function finger(page, run, from, to, { hold = 0, steps: count = 8, pause = 16 } = {}) {
  const points = Array.from({ length: count }, (_, index) => ({
    x: from.x + ((to.x - from.x) * (index + 1)) / count,
    y: from.y + ((to.y - from.y) * (index + 1)) / count,
  }));
  if (run.touch !== null) {
    const send = (type, point) =>
      run.touch.send('Input.dispatchTouchEvent', { type, touchPoints: point === null ? [] : [{ x: point.x, y: point.y, id: 1 }] });
    await send('touchStart', from);
    if (hold > 0) await page.waitForTimeout(hold);
    for (const point of points) {
      await send('touchMove', point);
      await page.waitForTimeout(pause);
    }
    await send('touchEnd', null);
    return;
  }
  // WebKit: the pointer events of one finger, to whatever is under it.
  const fire = (type, point) =>
    page.evaluate(
      ({ type: name, x, y }) => {
        const target = document.elementFromPoint(x, y) ?? document.body;
        target.dispatchEvent(
          new PointerEvent(name, { bubbles: true, cancelable: true, composed: true, pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0, buttons: name === 'pointerup' ? 0 : 1, clientX: x, clientY: y }),
        );
      },
      { type, ...point },
    );
  await fire('pointerdown', from);
  if (hold > 0) await page.waitForTimeout(hold);
  for (const point of points) {
    await fire('pointermove', point);
    await page.waitForTimeout(pause);
  }
  await fire('pointerup', to);
}

async function centre(locator) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('nothing to touch: the element is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const longPress = async (page, run, locator) => {
  const point = await centre(locator);
  await finger(page, run, point, point, { hold: LONG_PRESS_MS, steps: 1 });
};

// ── What is measured at every stop ──────────────────────────────────────────
async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready);
  await page.waitForTimeout(200);
}

async function measure(page) {
  return page.evaluate(
    ({ floor, comfort }) => {
      const root = document.documentElement;
      const seen = (element) => {
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none') return null;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        if (element.closest('[inert], .visually-hidden, .skip-link') !== null) return null;
        // On screen now: what is covered (behind a sheet, under the nav) is not a target.
        // Further down the page it will be one when it is scrolled to, so it is measured too.
        const onScreen = box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth;
        if (onScreen) {
          const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1);
          const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
          const top = document.elementFromPoint(x, y);
          if (top !== null && !(element.contains(top) || top.contains(element)) && top.closest('.bottom-nav, .dialog-backdrop, .toast-region') !== null) return null;
        }
        return box;
      };
      const name = (element) => {
        const data = [...element.attributes].find((attribute) => attribute.name.startsWith('data-') && attribute.name !== 'data-v-app');
        const cls = typeof element.className === 'string' ? element.className.split(/\s+/).filter(Boolean).slice(0, 3).join('.') : '';
        return `${element.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${data ? `[${data.name}]` : ''}`;
      };
      const targets = [];
      for (const element of document.querySelectorAll(
        'a[href], button, summary, select, textarea, input:not([type="hidden"]), [role="button"], [role="option"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="gridcell"][tabindex]',
      )) {
        if (element.disabled === true) continue;
        // A checkbox or radio is pressed through its label (around it, or `for` it): the label is the target.
        const labelled = element.matches('input[type="checkbox"], input[type="radio"]');
        const hit = labelled ? (element.closest('label') ?? (element.id ? document.querySelector(`label[for="${element.id}"]`) : null) ?? element) : element;
        // A link inside a sentence is text, as WCAG 2.5.8 has it.
        if (hit.matches('a') && getComputedStyle(hit).display === 'inline') continue;
        const box = seen(hit);
        if (box === null) continue;
        const least = Math.round(Math.min(box.width, box.height) * 10) / 10;
        if (least < comfort) targets.push({ name: name(hit), width: Math.round(box.width), height: Math.round(box.height), under: least < floor });
      }
      const fields = [];
      for (const element of document.querySelectorAll('input:not([type="checkbox"], [type="radio"], [type="range"], [type="color"], [type="hidden"]), select, textarea')) {
        if (seen(element) === null) continue;
        const size = Number.parseFloat(getComputedStyle(element).fontSize);
        if (size < 16) fields.push({ name: name(element), size });
      }
      return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, targets, fields };
    },
    { floor: FLOOR, comfort: COMFORT },
  );
}

async function stop(page, run, name) {
  await settle(page);
  if (shotsDir.length > 0 && run.viewport.width === 390 && run.scheme === 'dark') {
    await page.screenshot({ path: join(resolve(shotsDir), `${name}-${engineName}.png`), animations: 'disabled' }).catch(() => undefined);
  }
  const measured = await measure(page);
  const where = `${name} ${run.viewport.width}x${run.viewport.height} ${run.scheme}`;
  const overflowX = measured.scrollWidth > measured.clientWidth;
  const under = measured.targets.filter((target) => target.under);
  for (const target of measured.targets) {
    const key = `${name}  ${target.name}`;
    const entry = small.get(key) ?? { screen: name, target: target.name, width: target.width, height: target.height, under: target.under };
    entry.width = Math.min(entry.width, target.width);
    entry.height = Math.min(entry.height, target.height);
    entry.under ||= target.under;
    small.set(key, entry);
  }
  if (overflowX || under.length > 0 || measured.fields.length > 0) {
    findings.push({ stop: where, overflowX, scrollWidth: measured.scrollWidth, under, fields: measured.fields });
    console.log(
      `  ! ${where}: ${[overflowX ? `scrolls sideways (${measured.scrollWidth}px)` : '', ...under.map((target) => `${target.name} is ${target.width}×${target.height}`), ...measured.fields.map((field) => `${field.name} text is ${field.size}px`)].filter(Boolean).join('; ')}`,
    );
  }
}

/** One step of a walk: what must be true, said in words for the report. */
async function step(run, what, check) {
  steps += 1;
  try {
    await check();
  } catch (cause) {
    const reason = String(cause instanceof Error ? cause.message : cause).split('\n')[0];
    findings.push({ stop: `${what} ${run.viewport.width}x${run.viewport.height} ${run.scheme}`, failed: reason });
    console.log(`  ✗ ${what}: ${reason}`);
    throw cause;
  }
}

function expectThat(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Pages ───────────────────────────────────────────────────────────────────
async function withPage(browser, run, overrides, visit) {
  const context = await browser.newContext({
    viewport: run.viewport,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    colorScheme: run.scheme,
    reducedMotion: 'reduce',
    timezoneId: 'Asia/Seoul',
    locale: 'ko-KR',
  });
  context.setDefaultTimeout(8000);
  const page = await context.newPage();
  await page.clock.setFixedTime(FIXED_NOW);
  if (overrides !== undefined) {
    await page.addInitScript((value) => {
      window.__OHMYDATE_MOCK__ = value;
    }, overrides);
  }
  await page.addInitScript(
    ({ owner, theme }) => {
      window.localStorage.setItem('ohmydate.focus.owner', owner);
      window.localStorage.setItem(`ohmydate.theme:${owner}`, theme);
    },
    { owner: MOCK_OWNER_ID, theme: run.scheme },
  );
  run.touch = engineName === 'chromium' ? await context.newCDPSession(page) : null;
  try {
    await visit(page);
  } finally {
    await context.close();
  }
}

async function go(page, path) {
  await page.goto(`${baseUrl}${path}`);
  await page.waitForFunction(() => document.querySelector('#app')?.childElementCount > 0);
  await page.locator('.app-shell:not(.app-shell--loading), .auth-page').first().waitFor();
}

const shown = (page, selector) => page.locator(selector).filter({ visible: true }).first();
const scrollY = (page) => page.evaluate(() => window.scrollY);

// ── The walks ───────────────────────────────────────────────────────────────
/** Every place, as it stands when a finger arrives: the three measurements, nothing pressed. */
async function walkPlaces(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    const visit = async (name, path, ready) => {
      await go(page, path);
      await page.locator(ready).first().waitFor();
      await stop(page, run, name);
    };
    await visit('overview', '/overview', '[data-today-board] .today-card');
    await visit('tasks-canvas', '/tasks', '[data-todo-canvas] [data-todo]');
    await visit('tasks-list', '/tasks?view=list', '[data-inbox] .task-item');
    await visit('plan', '/plan', '.plan-rail');
    await visit('plan-scope', '/plan/schedule', '[data-plan-scope], .plan-scope, .page');
    await visit('planner', '/planner', '[data-planner]');
    await visit('planner-week', '/planner?view=week', '[data-planner="week"]');
    await visit('planner-day', '/planner?view=day', '[data-planner="day"]');
    await visit('planner-month', '/planner?view=month', '[data-month-title]');
    await visit('planner-list', '/planner?view=list', '[data-planner-list]');
    await visit('focus-home', '/focus', '[data-tracker-idle], [data-tracker-start]');
    await visit('insights', '/insights', '.insights-page, [data-insights]');
    await visit('notes', '/notes', '[data-note-item]');
    for (const section of ['availability', 'calendar', 'ai', 'display']) {
      await visit(`settings-${section}`, `/settings/${section}`, `[data-settings-section="${section}"] .settings-section`);
    }
  });
}

/** A to-do's capsule on the canvas, by its title. */
function capsule(page, title) {
  return page.locator('[data-todo]').filter({ has: page.getByText(title, { exact: true }) });
}

/** Where a capsule is drawn: the one transform that places it. */
const placeOf = (locator) =>
  locator.evaluate((element) => {
    const match = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(element.style.transform);
    return match === null ? { x: Number.NaN, y: Number.NaN } : { x: Number(match[1]), y: Number(match[2]) };
  });
/** The same place, give or take what the surface's own settling moves a body (a pixel or two). */
const samePlace = (left, right) => Math.hypot(left.x - right.x, left.y - right.y) <= 3;
const at = (place) => `${place.x},${place.y}`;
const picked = (page) => page.locator('[data-todo][aria-selected="true"]').count();

/** Bring a to-do to the middle of the screen, so a finger has room around it. */
async function bringToMiddle(page, locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(120);
}

/**
 * 할 일, the canvas: a swipe that starts on a to-do scrolls the page; a tap
 * opens the detail; a long press picks; a hold and a drag move; folders fold.
 */
async function walkCanvas(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/tasks');
    const first = capsule(page, '영어 회화 과제');
    await first.waitFor();
    await stop(page, run, 'canvas');
    await bringToMiddle(page, first);

    await step(run, 'canvas: a swipe that starts on a to-do scrolls the page and moves nothing', async () => {
      const before = { y: await scrollY(page), place: await placeOf(first) };
      const from = await centre(first);
      // No rest before it moves: a scroll.
      await finger(page, run, from, { x: from.x, y: from.y - 220 }, { steps: 12 });
      await page.waitForTimeout(400);
      if (run.touch !== null) expectThat((await scrollY(page)) > before.y + 60, `the page did not scroll (${before.y} → ${await scrollY(page)})`);
      expectThat(samePlace(await placeOf(first), before.place), 'the to-do moved on the surface');
      expectThat((await page.locator('[data-todo-card]').count()) === 0, 'the detail opened');
      expectThat((await picked(page)) === 0, 'something was picked');
    });

    await bringToMiddle(page, first);
    await step(run, 'canvas: a tap opens the detail, and picks nothing', async () => {
      await first.tap();
      await page.locator('[data-todo-card]').waitFor();
      expectThat((await picked(page)) === 0, 'a tap picked the to-do');
      await stop(page, run, 'canvas-detail');
    });

    await step(run, 'canvas: the detail closes from its own 닫기', async () => {
      await page.locator('[data-todo-card] [data-todo-card-close]').tap();
      await page.locator('[data-todo-card]').waitFor({ state: 'detached' });
    });

    await bringToMiddle(page, first);
    await step(run, 'canvas: a long press picks the to-do, opens nothing and leaves it where it was', async () => {
      const before = await placeOf(first);
      await longPress(page, run, first);
      await page.locator('[data-canvas-selection]').waitFor();
      expectThat((await first.getAttribute('aria-selected')) === 'true', 'the long press did not pick it');
      expectThat((await page.locator('[data-todo-card]').count()) === 0, 'the detail opened');
      expectThat(samePlace(await placeOf(first), before), `the to-do moved (${at(before)} → ${at(await placeOf(first))})`);
      await stop(page, run, 'canvas-selection');
    });

    const second = capsule(page, '도서관 책 반납');
    await step(run, 'canvas: with something picked, a tap picks another; the head says how many go to the plan', async () => {
      await bringToMiddle(page, second);
      await second.tap();
      expectThat((await picked(page)) === 2, `expected two picked, found ${await picked(page)}`);
      expectThat((await page.locator('[data-todo-card]').count()) === 0, 'the detail opened while picking');
      const head = await page.locator('[data-tasks-to-plan]').innerText();
      expectThat(head.includes('2'), `the head's button does not carry the two: "${head}"`);
      await second.tap();
      expectThat((await picked(page)) === 1, 'a second tap did not unpick it');
    });

    await step(run, 'canvas: 선택 풀기 lets go', async () => {
      await page.locator('[data-canvas-selection-clear]').tap();
      await page.locator('[data-canvas-selection]').waitFor({ state: 'detached' });
      expectThat((await picked(page)) === 0, 'still picked');
    });

    await bringToMiddle(page, first);
    await step(run, 'canvas: hold, then drag: the to-do moves and the page stays', async () => {
      const before = { y: await scrollY(page), place: await placeOf(first) };
      const from = await centre(first);
      await finger(page, run, from, { x: from.x + 70, y: from.y + 110 }, { hold: 380, steps: 10 });
      await page.waitForTimeout(300);
      expectThat(!samePlace(await placeOf(first), before.place), 'the to-do did not move');
      expectThat(Math.abs((await scrollY(page)) - before.y) < 4, `the page scrolled under the held to-do (${before.y} → ${await scrollY(page)})`);
      expectThat((await picked(page)) === 0, 'the drag picked it');
      expectThat((await page.locator('[data-todo-card]').count()) === 0, 'the drag opened the detail');
    });

    await step(run, 'canvas: a folder folds and opens with a tap', async () => {
      const fold = page.locator('[data-folder-fold]').first();
      await fold.scrollIntoViewIfNeeded();
      await stop(page, run, 'canvas-folders');
      await fold.tap();
      const unfold = page.locator('[data-folder-unfold]').first();
      await unfold.waitFor();
      await stop(page, run, 'canvas-folder-folded');
      await unfold.tap();
      await unfold.waitFor({ state: 'detached' });
    });

    await step(run, 'canvas: a folder’s menu opens under a thumb and closes on a tap outside', async () => {
      const button = page.locator('[data-folder-menu-button]').first();
      await button.scrollIntoViewIfNeeded();
      await button.tap();
      await page.locator('[data-folder-menu]').waitFor();
      await stop(page, run, 'canvas-folder-menu');
      await page.locator('h1').first().tap();
      await page.locator('[data-folder-menu]').waitFor({ state: 'detached' });
    });

    await step(run, 'canvas: 목록 shows the same to-dos as rows', async () => {
      const link = page.locator('[data-tasks-view-link="list"]');
      await link.scrollIntoViewIfNeeded();
      await link.tap();
      await page.locator('[data-tasks-list] .task-item').first().waitFor();
      await stop(page, run, 'tasks-list');
    });
  });
}

/** What stands inside the window, top to bottom (a keyboard that is up has made the window short). */
async function insideWindow(page, locator) {
  const box = await locator.boundingBox();
  if (box === null) return false;
  const height = await page.evaluate(() => window.innerHeight);
  return box.y >= 0 && box.y + box.height <= height + 0.5;
}

/** A tap on the scrim just above a sheet (a toast may stand at the very top while a sheet is open). */
async function tapOutside(page, sheet) {
  const box = await sheet.boundingBox();
  if (box === null) throw new Error('no sheet to tap outside of');
  expectThat(box.y >= 24, `there is no scrim left above the sheet to tap (${Math.round(box.y)}px)`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y - 12);
}

/**
 * ① 담기 → 할 일 → open → 완료, every step a touch: the nav's 담기 raises the
 * sheet, a line is written and put down, the new to-do is on the canvas, a tap
 * opens it and 완료 finishes it.
 */
async function walkLoop(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();
    await stop(page, run, 'overview');

    await step(run, 'capture: the nav’s 담기 raises the sheet, and the page behind it stays put', async () => {
      await page.locator('[data-nav-capture]').tap();
      await shown(page, '[data-capture-panel]').waitFor();
      await stop(page, run, 'capture-sheet');
      const locked = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY);
      expectThat(locked === 'hidden', `the page behind the sheet can still scroll (overflow-y: ${locked})`);
      const before = await scrollY(page);
      const sheet = await centre(page.locator('.dialog--sheet'));
      // A drag down the sheet and past its end.
      await finger(page, run, sheet, { x: sheet.x, y: sheet.y - 260 }, { steps: 10 });
      await page.waitForTimeout(250);
      expectThat((await scrollY(page)) === before, `the page behind the sheet moved (${before} → ${await scrollY(page)})`);
    });

    await step(run, 'capture: with the keyboard up, the field and its button stand in what is left of the window', async () => {
      const input = shown(page, '[data-capture-input]');
      await input.tap();
      await page.keyboard.type('금요일까지 보고서 초안, 내일 장보기');
      // The keyboard takes its space from the page (index.html, interactive-widget): the window is this short.
      await page.setViewportSize({ width: run.viewport.width, height: run.viewport.height - 330 });
      await page.waitForTimeout(200);
      expectThat(await insideWindow(page, input), 'the field is outside the window');
      expectThat(await insideWindow(page, shown(page, '[data-capture-submit]')), 'the sheet’s button is under the keyboard');
      expectThat(!(await page.locator('.bottom-nav').isVisible()) || (await page.locator('.dialog-backdrop').count()) > 0, 'the nav is under the typing thumb');
      await stop(page, run, 'capture-sheet-keyboard');
      await page.keyboard.press('Enter');
      await shown(page, '[data-capture-row]').waitFor();
      await stop(page, run, 'capture-drafts-keyboard');
      expectThat(await insideWindow(page, shown(page, '[data-capture-submit]')), '담기 is under the keyboard');
      await page.setViewportSize(run.viewport);
      await page.waitForTimeout(200);
      await stop(page, run, 'capture-drafts');
    });

    let title = '';
    await step(run, 'capture: 담기 puts the drafts down', async () => {
      title = (await shown(page, '[data-capture-row] input').inputValue()).trim();
      expectThat(title.length > 0, 'the first draft has no title');
      await shown(page, '[data-capture-submit]').tap();
      await shown(page, '[data-capture-done]').waitFor();
      await stop(page, run, 'capture-done');
    });

    await step(run, 'capture: a tap outside the sheet closes it', async () => {
      await tapOutside(page, page.locator('.dialog--sheet'));
      await page.locator('.dialog--sheet').waitFor({ state: 'detached' });
      const unlocked = await page.evaluate(() => getComputedStyle(document.documentElement).overflowY);
      expectThat(unlocked !== 'hidden', 'the page stayed locked after the sheet closed');
    });

    await step(run, '할 일: the nav leads there, and what was put down floats on the canvas', async () => {
      await page.locator('.bottom-nav [data-nav-place="tasks"]').tap();
      await page.locator('[data-todo-canvas]').waitFor();
      await capsule(page, title).first().waitFor();
    });

    await step(run, '할 일: a tap opens it, and 완료 finishes it', async () => {
      const mine = capsule(page, title).first();
      await bringToMiddle(page, mine);
      await mine.tap();
      await page.locator('[data-todo-card]').waitFor();
      await stop(page, run, 'canvas-detail-new');
      const done = page.locator('[data-todo-card] [data-todo-card-complete]');
      await done.scrollIntoViewIfNeeded();
      await done.tap();
      await page.locator('[data-todo-card]').waitFor({ state: 'detached' });
      await capsule(page, title).first().waitFor({ state: 'detached' });
      await stop(page, run, 'canvas-after-complete');
    });
  });
}

/** ③ → ④ → ⑤: 개요's next block, 집중 시작, 완료, the one-tap review, the next step. */
async function walkFocus(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    const start = page.locator('[data-primary="start"]');
    await start.waitFor();

    await step(run, '개요: the page scrolls with a swipe that starts on the timetable', async () => {
      const table = page.locator('.tt').first();
      await table.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const before = await scrollY(page);
      const from = await centre(table);
      await finger(page, run, from, { x: from.x, y: from.y - 240 }, { steps: 12 });
      await page.waitForTimeout(350);
      if (run.touch !== null) expectThat((await scrollY(page)) > before + 60, `the page did not scroll from the timetable (${before} → ${await scrollY(page)})`);
      await stop(page, run, 'overview-timetable');
    });

    await step(run, '개요: 집중 시작 on the next block opens the timer', async () => {
      await start.scrollIntoViewIfNeeded();
      await start.tap();
      await page.waitForURL(/\/focus\//);
      await page.locator('.focus-timer').waitFor();
      await stop(page, run, 'focus-running');
    });

    await step(run, '집중: 완료 ends the session and the review is one tap', async () => {
      await page.getByRole('button', { name: /^완료/ }).first().tap();
      await page.getByRole('heading', { name: '이번 세션은 어땠나요?' }).waitFor();
      await stop(page, run, 'focus-review');
      const submit = page.locator('.review-submit');
      await submit.scrollIntoViewIfNeeded();
      await submit.tap();
      await page.locator('[data-focus-next]').waitFor();
      await stop(page, run, 'focus-next');
    });

    await step(run, '집중: 오늘은 여기까지 leads back to 개요’s recap', async () => {
      const done = page.locator('[data-focus-next-done]');
      await done.scrollIntoViewIfNeeded();
      await done.tap();
      await page.locator('[data-day-recap]').waitFor();
      await stop(page, run, 'overview-recap');
    });
  });

  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/focus');
    await page.locator('[data-tracker-idle], [data-tracker-start]').first().waitFor();
    await step(run, '집중, the place: the task picker opens under a thumb and a tap picks', async () => {
      const field = page.locator('.task-finder input').first();
      await field.tap();
      await page.locator('.task-finder [role="option"]').first().waitFor();
      await stop(page, run, 'focus-home-picker');
      const option = page.locator('.task-finder [role="option"]').nth(1);
      const title = (await option.locator('.task-finder-option-title').innerText()).trim();
      await option.tap();
      await page.locator('.task-finder-list').waitFor({ state: 'hidden' });
      expectThat((await field.inputValue()) === title, `the field does not hold what was picked ("${await field.inputValue()}" for "${title}")`);
    });
  });
}

/** 플래너: a phone arrives on the day; the week scrolls inside its own frame; the 약속 dialog. */
async function walkPlanner(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();

    await step(run, '플래너: from 더 보기, a phone arrives on the day', async () => {
      await page.locator('[data-nav-more]').tap();
      await page.getByRole('dialog', { name: '더 보기' }).waitFor();
      await stop(page, run, 'more-sheet');
      await page.getByRole('dialog', { name: '더 보기' }).getByRole('link', { name: '플래너' }).tap();
      await page.locator('[data-planner="day"]').waitFor();
      expectThat(/[?&]view=day/.test(page.url()), `the address is not the day: ${page.url()}`);
      await stop(page, run, 'planner-day');
    });

    await step(run, '플래너: 주 is still the week, and a sideways swipe on it does not drag the page', async () => {
      await page.locator('[data-planner-view="week"]').tap();
      await page.locator('[data-planner="week"]').waitFor();
      await stop(page, run, 'planner-week');
      const grid = page.locator('[data-week-grid]');
      const from = await centre(grid);
      await finger(page, run, { x: from.x + 120, y: from.y }, { x: from.x - 120, y: from.y }, { steps: 10 });
      await page.waitForTimeout(250);
      const sideways = await page.evaluate(() => window.scrollX);
      expectThat(sideways === 0, `the page moved sideways (${sideways}px)`);
    });

    await step(run, '플래너: a tap on a block shows what it is, and a tap elsewhere puts it away', async () => {
      const item = page.locator('[data-week-grid] [data-item]').first();
      await item.scrollIntoViewIfNeeded();
      await item.tap();
      await page.locator('.planner-card').waitFor();
      await stop(page, run, 'planner-item-card');
      await page.locator('h1').first().tap();
      await page.locator('.planner-card').waitFor({ state: 'detached' });
    });

    await step(run, '플래너: 약속 추가 opens its dialog, which closes from its own button', async () => {
      const add = page.locator('[data-planner-add]');
      await add.scrollIntoViewIfNeeded();
      await add.tap();
      await page.locator('[data-planner-add-dialog]').waitFor();
      await stop(page, run, 'planner-add');
      await page.locator('[data-planner-add-dialog]').getByRole('button', { name: '닫기' }).first().tap();
      await page.locator('[data-planner-add-dialog]').waitFor({ state: 'detached' });
    });
  });
}

/** What floats: 더 보기, the account menu, the notifications — each reached, and each put away by a tap outside. */
async function walkFloating(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/overview');
    await page.locator('[data-today-board] .today-card').first().waitFor();

    await step(run, '더 보기: opens from the nav, and a tap on the scrim closes it', async () => {
      await page.locator('[data-nav-more]').tap();
      const sheet = page.getByRole('dialog', { name: '더 보기' });
      await sheet.waitFor();
      await tapOutside(page, sheet);
      await sheet.waitFor({ state: 'detached' });
    });

    await step(run, 'the account menu: opens under a thumb, holds the theme, and a tap outside closes it', async () => {
      await page.locator('[data-user-menu]').tap();
      await page.locator('#topbar-user-menu').waitFor();
      await stop(page, run, 'account-menu');
      await page.locator('#topbar-user-menu [data-theme-choice="light"]').tap();
      const bar = await page.locator('meta[name="theme-color"]').getAttribute('content');
      expectThat(bar === '#f0f4ef', `the browser bar did not follow the theme (${bar})`);
      await page.locator('#topbar-user-menu [data-theme-choice="dark"]').tap();
      const dark = await page.locator('meta[name="theme-color"]').getAttribute('content');
      expectThat(dark === '#070a08', `the browser bar did not come back (${dark})`);
      // The page's own margin, beside the cards: nothing to press there but "outside".
      await page.touchscreen.tap(5, Math.round(run.viewport.height * 0.6));
      await page.locator('#topbar-user-menu').waitFor({ state: 'detached' });
    });

    await step(run, '알림: the panel opens from 더 보기 and closes from its own button', async () => {
      await page.locator('[data-nav-more]').tap();
      await page.getByRole('dialog', { name: '더 보기' }).getByRole('button', { name: '알림' }).tap();
      const panel = page.getByRole('dialog', { name: '알림' });
      await panel.waitFor();
      await stop(page, run, 'notifications');
      await panel.getByRole('button', { name: /닫기/ }).first().tap();
      await panel.waitFor({ state: 'detached' });
    });

    await step(run, 'offline: the page says so in its own words, and comes back', async () => {
      await page.context().setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.locator('.offline-banner').waitFor();
      await stop(page, run, 'offline');
      await page.context().setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await page.locator('.offline-banner').waitFor({ state: 'detached' });
    });
  });
}

/** ② 계획: the stages, the three schedules stacked, and a block changed by touch. */
async function walkPlan(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/plan/schedule');
    const create = page.locator('[data-plan-create]');
    await create.waitFor();
    await stop(page, run, 'plan-scope');

    await step(run, '계획: to-dos are picked by tapping their rows', async () => {
      const rows = page.locator('[data-scope-picker] .task-picker-row');
      for (const index of [1, 2, 3]) {
        const row = rows.nth(index);
        await row.scrollIntoViewIfNeeded();
        await row.tap();
      }
      expectThat((await page.locator('[data-scope-picker] .task-picker-row input:checked').count()) === 3, 'three taps did not pick three to-dos');
    });

    await step(run, '계획: 일정안 만들기 leads to three schedules, stacked one under another', async () => {
      await create.scrollIntoViewIfNeeded();
      await create.tap();
      await page.waitForURL(/\/plan\/schedule\/[0-9a-f-]+/);
      const cards = page.locator('[data-candidate]');
      await cards.first().waitFor();
      await stop(page, run, 'plan-options');
      const boxes = await cards.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
      expectThat(boxes.length === 3, `expected three schedules, found ${boxes.length}`);
      for (const [index, box] of boxes.entries()) {
        expectThat(Math.abs(box.left - boxes[0].left) < 2, `schedule ${index + 1} is not under the first`);
        if (index > 0) expectThat(box.top >= boxes[index - 1].bottom - 1, `schedule ${index + 1} overlaps the one above`);
      }
    });

    const block = page.locator('[data-week-grid] [data-kind="proposal"]').first();
    await step(run, '계획: a swipe that starts on a block scrolls the page and does not move the block', async () => {
      await block.waitFor();
      await bringToMiddle(page, block);
      // The week scrolls inside its own frame: the swipe moves that, or the page once the frame is at its end.
      const scrolled = () =>
        page.evaluate(() => {
          let total = window.scrollY;
          for (let node = document.querySelector('[data-week-grid] [data-item]'); node !== null; node = node.parentElement) total += node.scrollTop;
          return total;
        });
      const before = { y: await scrolled(), name: await block.getAttribute('aria-label') };
      const from = await centre(block);
      await finger(page, run, from, { x: from.x, y: from.y - 160 }, { steps: 12 });
      await page.waitForTimeout(350);
      if (run.touch !== null) expectThat((await scrolled()) > before.y + 40, `nothing scrolled from the block (${before.y} → ${await scrolled()})`);
      expectThat((await block.getAttribute('aria-label')) === before.name, `the swipe moved the block ("${before.name}" → "${await block.getAttribute('aria-label')}")`);
    });

    await step(run, '계획: a tap on a block opens its card, and 더 늦게 moves it', async () => {
      await bringToMiddle(page, block);
      const before = await block.getAttribute('aria-label');
      await block.tap();
      const later = page.locator('[data-card-later]');
      await later.waitFor();
      await stop(page, run, 'plan-block-card');
      await later.tap();
      await page.waitForTimeout(250);
      expectThat((await block.getAttribute('aria-label')) !== before, 'the block did not move');
    });
  });
}

/** 설정 › 가용 시간: a finger paints a cell; a swipe on the time column moves the page. */
async function walkHours(browser, run) {
  await withPage(browser, run, undefined, async (page) => {
    await go(page, '/settings/availability');
    await page.locator('[data-settings-section="availability"] .settings-section').waitFor();
    const cell = page.locator('.avail-cell').nth(30);
    await cell.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await stop(page, run, 'settings-hours');

    await step(run, '가용 시간: a swipe on the time column scrolls the page, and paints nothing', async () => {
      const column = page.locator('.avail-time').nth(4);
      const states = () => page.locator('.avail-cell').evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-state')).join(','));
      const painted = await states();
      const before = await scrollY(page);
      const from = await centre(column);
      await finger(page, run, from, { x: from.x, y: from.y - 200 }, { steps: 12 });
      await page.waitForTimeout(350);
      if (run.touch !== null) expectThat((await scrollY(page)) > before + 60, `the page did not scroll from the time column (${before} → ${await scrollY(page)})`);
      expectThat((await states()) === painted, 'the swipe painted cells');
    });

    await step(run, '가용 시간: a tap on a cell paints it', async () => {
      const target = page.locator('.avail-cell').nth(30);
      await target.scrollIntoViewIfNeeded();
      const before = await target.getAttribute('aria-label');
      await target.tap();
      await page.waitForTimeout(200);
      expectThat((await target.getAttribute('aria-label')) !== before, 'the tap did not change the cell');
    });
  });
}

const WALKS = { places: walkPlaces, loop: walkLoop, canvas: walkCanvas, focus: walkFocus, planner: walkPlanner, plan: walkPlan, hours: walkHours, floating: walkFloating };

async function main() {
  await mkdir(outDir, { recursive: true });
  let vite = null;
  if (baseUrl.length === 0) {
    vite = await startVite();
    baseUrl = `http://127.0.0.1:${port}`;
  }
  const browser = await (engineName === 'webkit' ? webkit : chromium).launch();
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const run = { viewport, scheme, touch: null };
        console.log(`${engineName} ${scheme} ${viewport.width}x${viewport.height}`);
        for (const [name, walk] of Object.entries(WALKS)) {
          if (only.length > 0 && !name.startsWith(only)) continue;
          try {
            await walk(browser, run);
          } catch (cause) {
            if (!findings.some((entry) => entry.failed !== undefined && entry.stop.endsWith(`${viewport.width}x${viewport.height} ${scheme}`))) {
              findings.push({ stop: `walk:${name} ${viewport.width}x${viewport.height} ${scheme}`, failed: String(cause).split('\n')[0] });
            }
            console.log(`  ! walk ${name} stopped: ${String(cause).split('\n')[0]}`);
          }
        }
      }
    }
  } finally {
    await browser.close();
    vite?.kill();
  }
  const below = [...small.values()].sort((left, right) => left.screen.localeCompare(right.screen) || left.target.localeCompare(right.target));
  await writeFile(
    join(outDir, `touch-report-${engineName}.json`),
    `${JSON.stringify({ browser: engineName, gestures: engineName === 'chromium' ? 'real (browser input pipeline)' : 'tap real; long press, drag and swipe as pointer events', steps, failing: findings.length, findings, under44: below }, null, 2)}\n`,
  );
  console.log(`${steps} steps, ${findings.length} failing, ${below.length} targets under ${COMFORT}px → docs/ui-polish/${label}/touch-report-${engineName}.json`);
  if (findings.length > 0 && !reportOnly) process.exitCode = 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
