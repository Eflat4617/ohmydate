/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLANNER_PHONE_QUERY, plannerPhoneEntry, plannerViewOf } from '../src/domain/plannerRoute';
import { t } from '../src/i18n';
import { routes } from '../src/router';

/**
 * HOLO-07, under a finger: what the shell and the planner do differently for
 * a phone. (The canvas's own touch rules are in holo-canvas.spec.ts, the
 * install and the device's edges in holo-phone-install.spec.ts.)
 */
const STYLES = resolve(__dirname, '../src/styles');
const sheet = (name: string): string => readFileSync(resolve(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('플래너 on a phone: arriving opens the day', () => {
  const arrive = (query: Record<string, unknown>, from: unknown, phone = true) =>
    plannerPhoneEntry({ name: 'planner', query }, { name: from }, phone);

  it('the bare address, reached from another place, becomes the day', () => {
    expect(arrive({}, 'overview')).toEqual({ name: 'planner', query: { view: 'day' } });
    // A first load has no "from".
    expect(arrive({}, undefined)).toEqual({ name: 'planner', query: { view: 'day' } });
    // What the address carried besides stays.
    expect(arrive({ add: '1' }, 'tasks')).toEqual({ name: 'planner', query: { add: '1', view: 'day' } });
  });

  it('a view or a week that was asked for is honoured (negative)', () => {
    for (const view of ['week', 'month', 'list', 'day']) expect(arrive({ view }, 'overview'), view).toBeNull();
    expect(arrive({ w: '2026-11-16' }, 'overview')).toBeNull();
  });

  it('inside the planner the address means what it always meant: 주 opens the week on a phone too (negative)', () => {
    expect(arrive({}, 'planner')).toBeNull();
    expect(arrive({}, 'month')).toBeNull();
    expect(plannerViewOf('planner', {})).toBe('week');
  });

  it('a wide window is never sent anywhere, and neither is another route (negative)', () => {
    expect(arrive({}, 'overview', false)).toBeNull();
    expect(plannerPhoneEntry({ name: 'month', query: {} }, { name: 'overview' }, true)).toBeNull();
    expect(plannerPhoneEntry({ name: 'tasks', query: {} }, { name: 'overview' }, true)).toBeNull();
  });

  describe('through the router', () => {
    const Stub = defineComponent({ template: '<div />' });
    function router(): Router {
      return createRouter({
        history: createMemoryHistory(),
        routes: routes.map((route) => ('redirect' in route ? route : { ...route, component: Stub })) as never,
      });
    }
    function width(phone: boolean): string[] {
      const asked: string[] = [];
      vi.stubGlobal('matchMedia', (query: string) => {
        asked.push(query);
        return { matches: query === PLANNER_PHONE_QUERY ? phone : false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined };
      });
      return asked;
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('a phone that opens 플래너 lands on the day; 주 from there is the week; coming back is the day again', async () => {
      const asked = width(true);
      const target = router();
      await target.push('/overview');
      await target.push('/planner');
      expect(target.currentRoute.value.fullPath).toBe('/planner?view=day');
      expect(asked).toContain(PLANNER_PHONE_QUERY);
      // The view switch's 주: the same route, another query.
      await target.push('/planner');
      expect(target.currentRoute.value.fullPath).toBe('/planner');
      expect(plannerViewOf(target.currentRoute.value.name, target.currentRoute.value.query)).toBe('week');
      await target.push('/tasks');
      await target.push('/planner');
      expect(target.currentRoute.value.fullPath).toBe('/planner?view=day');
    });

    it('a phone that asks for the week, the list or the month gets it (negative)', async () => {
      width(true);
      const target = router();
      await target.push('/overview');
      for (const path of ['/planner?view=week', '/planner?w=2026-11-16', '/planner?view=list', '/month', '/commitments']) {
        await target.push('/overview');
        await target.push(path);
        expect(target.currentRoute.value.query['view'], path).not.toBe('day');
      }
    });

    it('a wide window opens the week, as before (negative)', async () => {
      width(false);
      const target = router();
      await target.push('/overview');
      await target.push('/planner');
      expect(target.currentRoute.value.fullPath).toBe('/planner');
    });
  });
});

describe('touch targets: 44px under a coarse pointer, and only there', () => {
  const touch = sheet('touch.css');
  const coarse = /@media \(pointer: coarse\) \{([\s\S]*)\n\}/.exec(touch)?.[1] ?? '';

  it('is the last stylesheet, so its floor is not undone by a screen’s own rule', () => {
    const entry = readFileSync(resolve(STYLES, '../styles.css'), 'utf8');
    const imports = [...entry.matchAll(/@import '([^']+)';/g)].map((match) => match[1]);
    expect(imports.at(-1)).toBe('./styles/touch.css');
  });

  it('gives a field, the top bar’s controls and a row’s title the hit target', () => {
    expect(coarse).toMatch(/input:not\([^)]*\),\s*select \{\s*min-height: var\(--hit-target\);/);
    for (const selector of ['.topbar-brand', '.topbar-user-button', '.now-pill-start', '.layout-panel-link', '.ai-link', '.todo-list-title a', '.today-agenda-title', '.month-agenda-title', '.task-title-link', '.insights-switch']) {
      expect(coarse, selector).toContain(selector);
    }
    expect(coarse.match(/var\(--hit-target\)/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it('changes nothing under a mouse (negative): every rule is inside the coarse-pointer query', () => {
    const outside = touch.replace(/@media \(pointer: coarse\) \{[\s\S]*\n\}/, '').trim();
    expect(outside).toBe('');
  });

  it('sizes with the token, never a raw length (negative)', () => {
    // `0px` (the floor of a max()) is not a size.
    expect(coarse).not.toMatch(/\b(?:[1-9]\d*|\d+\.\d+)(?:px|rem)\b/);
  });
});

describe('what floats, on a phone', () => {
  const primitives = sheet('primitives.css');
  const capture = sheet('screens/22-capture.css');
  const planner = sheet('screens/16-planner.css');
  const plan = sheet('screens/18-plan.css');

  it('toasts stand at the top while any dialog is open: never over the buttons a tall dialog ends in', () => {
    const narrow = /@media \(max-width: 1023\.98px\) \{\s*:root:has\(\.dialog-backdrop\) \.toast-region \{([^}]*)\}/.exec(primitives)?.[1] ?? '';
    expect(narrow).toContain('var(--safe-top)');
    expect(narrow).toMatch(/inset:[^;]*auto/);
  });

  it('on a wide window only a sheet moves them, as before (negative)', () => {
    const wide = [...primitives.matchAll(/@media \(min-width: 1024px\) \{([\s\S]*?)\n\}/g)].map((match) => match[1] ?? '').join('\n');
    expect(wide).toContain(':root:has(.dialog-backdrop--sheet) .toast-region');
    expect(wide).not.toContain(':root:has(.dialog-backdrop) .toast-region');
  });

  it('the capture sheet’s button rides the sheet’s foot, solid, over the sheet’s own padding', () => {
    const actions = /\.capture--sheet \.capture-actions \{([^}]*)\}/.exec(capture)?.[1] ?? '';
    expect(actions).toContain('position: sticky');
    expect(actions).toContain('bottom: 0');
    expect(actions).toContain('background: var(--glass-solid)');
    expect(actions).toContain('var(--safe-bottom)');
    const cover = /\.capture--sheet \.capture-actions::after \{([^}]*)\}/.exec(capture)?.[1] ?? '';
    expect(cover).toContain('height: var(--capture-foot)');
  });

  it('the top bar’s capture panel is left as it was (negative): only the sheet’s actions stick', () => {
    expect(capture).not.toMatch(/\.capture--bar \.capture-actions/);
    expect(/(^|\n)\.capture-actions \{([^}]*)\}/.exec(capture)?.[2] ?? '').not.toContain('sticky');
  });

  it('a schedule’s block lets a finger scroll from it, and says the touch way to change it', () => {
    const coarse = /@media \(pointer: coarse\) \{\s*\.wg-item--editable \{([^}]*)\}/.exec(planner)?.[1] ?? '';
    expect(coarse).toContain('touch-action: auto');
    // Under a mouse the block is still the browser's to leave alone while it is dragged.
    expect(/(^|\n)\.wg-item--editable \{([^}]*)\}/.exec(planner)?.[2] ?? '').toContain('touch-action: none');
    expect(plan).toMatch(/\.plan-hint-coarse \{\s*display: none;/);
    expect(plan).toMatch(/@media \(pointer: coarse\) \{\s*\.plan-hint-fine \{\s*display: none;\s*\}\s*\.plan-hint-coarse \{\s*display: inline;/);
    expect(t('planSchedule.hintTouch')).toBe('블록을 누르면 5분씩 옮기거나 길이를 바꿀 수 있어요. 끌어서 고치기는 넓은 화면에서 돼요.');
    // The pointer's own line still says drag.
    expect(t('planSchedule.hint')).toContain('끌어서');
  });
});

describe('the phone’s nav and the keyboard', () => {
  const shell = sheet('shell.css');

  it('steps away while a text field has the caret in a window as short as a keyboard makes it', () => {
    const rule = /@media \(pointer: coarse\) and \(min-aspect-ratio: 3\/5\) \{([\s\S]*?)\n\}/.exec(shell)?.[1] ?? '';
    expect(rule).toMatch(/\.app-shell:has\(:is\(input:not\([^)]*\), textarea, \[contenteditable='true'\]\):focus\)\s*\.bottom-nav \{\s*display: none;/);
    // A tick box or a slider brings no keyboard: the nav stays for those.
    expect(rule).toContain("[type='checkbox']");
    expect(rule).toContain("[type='range']");
  });

  it('never hides the nav under a mouse or in a tall window (negative): the rule is inside that one query', () => {
    const outside = shell.replace(/@media \(pointer: coarse\) and \(min-aspect-ratio: 3\/5\) \{[\s\S]*?\n\}/, '');
    expect(outside).not.toMatch(/:focus\)\s*\.bottom-nav/);
    // A phone held upright with no keyboard is taller than 5:3 (390×844, 360×780).
    for (const [width, height] of [[390, 844], [360, 780], [412, 915]] as const) expect(width / height).toBeLessThan(3 / 5);
    // With the keyboard up it is not (about 300px of keyboard).
    for (const [width, height] of [[390, 844 - 320], [360, 780 - 300]] as const) expect(width / height).toBeGreaterThanOrEqual(3 / 5);
  });
});
