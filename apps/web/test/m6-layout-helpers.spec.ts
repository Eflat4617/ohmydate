/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildLayoutSpec, decideMode, DEFAULT_PREFERENCES, type LayoutSignals } from '@ohmydate/ui-policy';
import type { Today } from '../src/api';
import { captureFocus, restoreFocus } from '../src/layout/focusKeeper';
import { createInteractionTracker, isEditable } from '../src/layout/interaction';
import {
  acknowledgeRisk,
  isReviewSkipped,
  isRiskAcknowledged,
  isSessionReviewed,
  markSessionReviewed,
  skipReviewToday,
} from '../src/layout/localSignals';
import { layoutPrefsKey, parseLayoutPrefs, readLayoutPrefs, writeLayoutPrefs } from '../src/layout/prefs';
import { focusRouteSessionId, routeKindOf, workspacePathFor } from '../src/layout/routes';
import { riskTaskCount } from '../src/layout/useTodaySnapshot';

// Vitest drops CSS imports (even `?raw`), so read the stylesheets as files.
function stylesheet(name: string): string {
  const candidates = [resolve(process.cwd(), 'src/styles', name), resolve(process.cwd(), 'apps/web/src/styles', name)];
  const found = candidates.find((path) => existsSync(path));
  return found === undefined ? '' : readFileSync(found, 'utf8');
}
const shellCss = stylesheet('shell.css');
const tokensCss = stylesheet('tokens.css');

const SESSION = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

function signals(overrides: Partial<LayoutSignals> = {}): LayoutSignals {
  return {
    route: 'today',
    routeSessionId: null,
    activeSessionId: null,
    riskTaskCount: 0,
    riskAcknowledged: false,
    inReviewWindow: false,
    unreviewedSessionCount: 0,
    day: '2026-11-14',
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('layout preferences (per owner, this device)', () => {
  it('defaults to auto switching on and no lock', () => {
    expect(readLayoutPrefs(OWNER)).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ autoSwitch: true, locked: null });
  });

  it('round-trips and keys by owner', () => {
    writeLayoutPrefs(OWNER, { autoSwitch: false, locked: 'focus' });
    expect(readLayoutPrefs(OWNER)).toEqual({ autoSwitch: false, locked: 'focus' });
    expect(readLayoutPrefs(null)).toEqual(DEFAULT_PREFERENCES);
    expect(layoutPrefsKey(OWNER)).toBe(`ohmydate.layout.prefs:${OWNER}`);
  });

  it('falls back to defaults for broken or unexpected values (negative)', () => {
    expect(parseLayoutPrefs('{not json')).toEqual(DEFAULT_PREFERENCES);
    expect(parseLayoutPrefs('null')).toEqual(DEFAULT_PREFERENCES);
    expect(parseLayoutPrefs('{"autoSwitch":"no","locked":"dashboard"}')).toEqual(DEFAULT_PREFERENCES);
    expect(parseLayoutPrefs('{"autoSwitch":false,"locked":"<script>"}')).toEqual({ autoSwitch: false, locked: null });
  });
});

describe('local layout signals', () => {
  it('remembers the risk acknowledgement for one day only', () => {
    acknowledgeRisk(OWNER, '2026-11-14');
    expect(isRiskAcknowledged(OWNER, '2026-11-14')).toBe(true);
    expect(isRiskAcknowledged(OWNER, '2026-11-15')).toBe(false);
    expect(isRiskAcknowledged(null, '2026-11-14')).toBe(false);
  });

  it('tracks reviewed sessions and the skipped review day', () => {
    expect(isSessionReviewed(OWNER, SESSION)).toBe(false);
    markSessionReviewed(OWNER, SESSION);
    markSessionReviewed(OWNER, SESSION);
    expect(isSessionReviewed(OWNER, SESSION)).toBe(true);
    expect(JSON.parse(localStorage.getItem(`ohmydate.layout.reviewed:${OWNER}`) ?? '[]')).toEqual([SESSION]);
    skipReviewToday(OWNER, '2026-11-14');
    expect(isReviewSkipped(OWNER, '2026-11-14')).toBe(true);
    expect(isReviewSkipped(OWNER, '2026-11-15')).toBe(false);
  });

  it('ignores a corrupted reviewed list (negative)', () => {
    localStorage.setItem(`ohmydate.layout.reviewed:${OWNER}`, '{"x":1}');
    expect(isSessionReviewed(OWNER, SESSION)).toBe(false);
  });
});

describe('routes as layout signals', () => {
  it('classifies routes', () => {
    expect(routeKindOf({ name: 'today', params: {} })).toBe('today');
    expect(routeKindOf({ name: 'focus', params: { sessionId: SESSION } })).toBe('focus');
    expect(routeKindOf({ name: 'plan-new', params: {} })).toBe('planning');
    expect(routeKindOf({ name: 'plan-session', params: { sessionId: SESSION } })).toBe('planning');
    expect(routeKindOf({ name: 'plans-new', params: {} })).toBe('planning');
    expect(routeKindOf({ name: 'plan', params: { id: SESSION } })).toBe('planning');
    expect(routeKindOf({ name: 'notes', params: {} })).toBe('notes');
    expect(routeKindOf({ name: 'inbox', params: {} })).toBe('other');
    expect(routeKindOf({ name: 'replan', params: {} })).toBe('other');
  });

  it('treats /focus/new and malformed ids as not a layout surface (negative)', () => {
    expect(routeKindOf({ name: 'focus', params: { sessionId: 'new' } })).toBe('other');
    expect(focusRouteSessionId({ name: 'focus', params: { sessionId: '../today' } })).toBeNull();
    expect(focusRouteSessionId({ name: 'today', params: { sessionId: SESSION } })).toBeNull();
  });

  it('keeps the workspace URL in step with the page, never leaving a planning page', () => {
    const focus = buildLayoutSpec(decideMode(signals({ activeSessionId: SESSION }), DEFAULT_PREFERENCES), signals({ activeSessionId: SESSION }));
    const overview = buildLayoutSpec(decideMode(signals(), DEFAULT_PREFERENCES), signals());
    expect(workspacePathFor(focus, 'today')).toBe(`/focus/${SESSION}`);
    expect(workspacePathFor(overview, 'focus')).toBe('/today');
    expect(workspacePathFor(overview, 'planning')).toBeNull();
    expect(workspacePathFor(overview, 'notes')).toBeNull();
    expect(workspacePathFor(overview, 'other')).toBeNull();
  });
});

describe('deadline risk from Today', () => {
  function today(reasons: string[]): Today {
    return { date: '2026-11-14', timeZone: 'Asia/Seoul', slackMin: 0, risk: { level: 'high', reasons }, version: 1, blocks: [] };
  }

  it('counts negative slack and overdue tasks', () => {
    expect(riskTaskCount(today(['negative_slack:-30', 'task_overdue:a', 'task_overdue:b']))).toBe(3);
  });

  it('does not count the daily focus cap or unknown reasons (negative)', () => {
    expect(riskTaskCount(today(['daily_focus_cap_exceeded:310', 'something_else']))).toBe(0);
    expect(riskTaskCount(null)).toBe(0);
  });
});

describe('interaction tracking', () => {
  it('only text-like fields count as typing', () => {
    const text = document.createElement('input');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const disabled = document.createElement('textarea');
    disabled.disabled = true;
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    expect(isEditable(text)).toBe(true);
    expect(isEditable(document.createElement('textarea'))).toBe(true);
    expect(isEditable(checkbox)).toBe(false);
    expect(isEditable(disabled)).toBe(false);
    expect(isEditable(document.createElement('button'))).toBe(false);
    expect(isEditable(null)).toBe(false);
  });

  it('reports typing, a press inside a panel and a dialog inside a panel', () => {
    document.body.innerHTML = `
      <div id="root">
        <div data-layout-item="TodayPlan"><input id="field" /><button id="press">x</button></div>
        <div data-layout-item="NextUp"><div role="dialog">d</div></div>
      </div>`;
    const root = document.getElementById('root');
    const changes: number[] = [];
    const tracker = createInteractionTracker(() => changes.push(1));
    tracker.start();
    document.getElementById('field')?.focus();
    expect(tracker.snapshot(root)).toEqual({ typing: true, dragging: false, activeComponents: ['TodayPlan', 'NextUp'] });

    document.getElementById('field')?.blur();
    const press = document.getElementById('press');
    press?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0 }));
    press?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 20, clientY: 0, buttons: 1 }));
    expect(tracker.snapshot(root)).toMatchObject({ typing: false, dragging: true });
    press?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    expect(tracker.snapshot(null)).toEqual({ typing: false, dragging: false, activeComponents: [] });
    expect(changes.length).toBeGreaterThan(0);
    tracker.stop();
  });
});

describe('focus preservation', () => {
  function fixture(): HTMLElement {
    document.body.innerHTML = `
      <div id="frame">
        <div data-layout-region="primary" tabindex="-1">
          <div data-layout-item="TodayPlan"><button id="a">a</button><button id="b">b</button></div>
        </div>
        <div data-layout-region="secondary"><div data-layout-item="NextUp"><a id="link" href="/today">x</a></div></div>
      </div>`;
    return document.getElementById('frame') as HTMLElement;
  }

  it('leaves focus alone when the focused element survives', () => {
    const root = fixture();
    document.getElementById('link')?.focus();
    const snapshot = captureFocus(root);
    expect(restoreFocus(snapshot, root)?.id).toBe('link');
    expect(document.activeElement?.id).toBe('link');
  });

  it('moves to the same place in the same component when the element was replaced', () => {
    const root = fixture();
    document.getElementById('b')?.focus();
    const snapshot = captureFocus(root);
    const item = root.querySelector('[data-layout-item="TodayPlan"]') as HTMLElement;
    item.innerHTML = '<button id="a2">a</button><button id="b2">b</button>';
    expect(restoreFocus(snapshot, root)?.id).toBe('b2');
  });

  it('falls back to the primary region when the component is gone', () => {
    const root = fixture();
    document.getElementById('link')?.focus();
    const snapshot = captureFocus(root);
    root.querySelector('[data-layout-region="secondary"]')?.remove();
    const target = restoreFocus(snapshot, root);
    expect(target?.dataset['layoutRegion']).toBe('primary');
    expect(document.activeElement).toBe(target);
  });

  it('does not take focus when nothing had it (negative)', () => {
    const root = fixture();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(restoreFocus(captureFocus(root), root)).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('prefers-reduced-motion', () => {
  it('finds the stylesheets', () => {
    expect(shellCss.length).toBeGreaterThan(1000);
    expect(tokensCss.length).toBeGreaterThan(1000);
  });

  it('turns the layout animation off and zeroes every duration', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.adaptive-item \{\s*animation: none;/;
    expect(reduced.test(shellCss)).toBe(true);
    expect(/@media \(prefers-reduced-motion: reduce\)[\s\S]*--duration-base: 0ms/.test(tokensCss)).toBe(true);
  });

  it('animates only opacity, so Focus calm mode can stay position: fixed', () => {
    const keyframes = /@keyframes adaptive-item-in \{([\s\S]*?)\n\}/.exec(shellCss)?.[1] ?? '';
    expect(keyframes).toContain('opacity');
    expect(keyframes).not.toContain('transform');
  });
});
