/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { adoptActiveOwner, captureOwnerBinding } from '../src/session/ownerEpoch';
import { OWNER_STORAGE_MANIFEST } from '../src/session/ownerStorage';
import {
  DEFAULT_THEME,
  bootTheme,
  parseTheme,
  readTheme,
  resetThemeForTests,
  resolveScheme,
  themePrefKey,
  useTheme,
  writeTheme,
} from '../src/theme/theme';

/**
 * HOLO-01 theme: dark by default, the user's choice (라이트 / 다크 / 시스템) on
 * `data-theme`, what is shown on `data-scheme`, remembered per owner through
 * the owner-scoped storage module.
 */
const OWNER_A = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const OWNER_B = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';

const root = document.documentElement;

/** A `prefers-color-scheme: light` the test can flip. */
function installSystemScheme(initialLight: boolean): { set(light: boolean): void; queries: string[] } {
  let light = initialLight;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const queries: string[] = [];
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    queries.push(query);
    return {
      get matches() {
        return light;
      },
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  restoreMatchMedia = () => {
    window.matchMedia = original;
  };
  return {
    set(next) {
      light = next;
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent);
    },
    queries,
  };
}

let restoreMatchMedia: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  resetThemeForTests();
  adoptActiveOwner(OWNER_A, 'bootstrap');
});

afterEach(() => {
  resetThemeForTests();
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  adoptActiveOwner(null, 'bootstrap');
  localStorage.clear();
});

describe('theme choice', () => {
  it('is dark by default, whatever the system prefers', () => {
    installSystemScheme(true);
    expect(DEFAULT_THEME).toBe('dark');
    bootTheme();
    expect(root.dataset['theme']).toBe('dark');
    expect(root.dataset['scheme']).toBe('dark');
    expect(readTheme(OWNER_A)).toBe('dark');
  });

  it('puts each choice on the root element', () => {
    installSystemScheme(false);
    bootTheme();
    const { setTheme, choice, scheme } = useTheme();
    setTheme('light');
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['light', 'light']);
    setTheme('dark');
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['dark', 'dark']);
    setTheme('system');
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['system', 'dark']);
    expect(choice.value).toBe('system');
    expect(scheme.value).toBe('dark');
  });

  it('keeps the page and the browser chrome in step (meta color-scheme)', () => {
    const meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'dark';
    document.head.appendChild(meta);
    bootTheme();
    useTheme().setTheme('light');
    expect(meta.content).toBe('light');
    useTheme().setTheme('dark');
    expect(meta.content).toBe('dark');
    meta.remove();
  });

  it('follows the system only under 시스템', async () => {
    const system = installSystemScheme(false);
    bootTheme();
    const { setTheme, scheme } = useTheme();
    setTheme('system');
    expect(root.dataset['scheme']).toBe('dark');
    system.set(true);
    await nextTick();
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['system', 'light']);
    expect(scheme.value).toBe('light');
    system.set(false);
    expect(root.dataset['scheme']).toBe('dark');
    expect(system.queries).toEqual(['(prefers-color-scheme: light)']);

    // A fixed choice ignores the system (negative).
    setTheme('dark');
    system.set(true);
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['dark', 'dark']);
    setTheme('light');
    system.set(false);
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['light', 'light']);
  });

  it('resolves a scheme from a choice', () => {
    expect(resolveScheme('dark', true)).toBe('dark');
    expect(resolveScheme('light', false)).toBe('light');
    expect(resolveScheme('system', true)).toBe('light');
    expect(resolveScheme('system', false)).toBe('dark');
  });

  it('treats anything unexpected as the default (negative)', () => {
    expect(parseTheme(null)).toBe('dark');
    expect(parseTheme('')).toBe('dark');
    expect(parseTheme('LIGHT')).toBe('dark');
    expect(parseTheme('{"theme":"light"}')).toBe('dark');
    expect(parseTheme('light')).toBe('light');
    expect(parseTheme('system')).toBe('system');
  });
});

describe('theme is remembered per owner', () => {
  it('stores the choice under the owner who made it and brings it back', () => {
    bootTheme();
    useTheme().setTheme('light');
    expect(localStorage.getItem(themePrefKey(OWNER_A))).toBe('light');
    expect(themePrefKey(OWNER_A)).toBe(`ohmydate.theme:${OWNER_A}`);
    expect(readTheme(OWNER_A)).toBe('light');

    // A fresh page for the same owner starts in their theme.
    resetThemeForTests();
    expect(root.dataset['theme']).toBeUndefined();
    bootTheme();
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['light', 'light']);
  });

  it('never shows one owner the other one’s choice (negative)', () => {
    bootTheme();
    useTheme().setTheme('light');
    expect(readTheme(OWNER_B)).toBe('dark');
    expect(localStorage.getItem(themePrefKey(OWNER_B))).toBeNull();

    // Another user signs in on this page: their own (default) theme applies…
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect([root.dataset['theme'], root.dataset['scheme']]).toEqual(['dark', 'dark']);
    useTheme().setTheme('system');
    expect(localStorage.getItem(themePrefKey(OWNER_B))).toBe('system');
    // …and the first owner's choice is still theirs.
    expect(localStorage.getItem(themePrefKey(OWNER_A))).toBe('light');
    adoptActiveOwner(OWNER_A, 'bootstrap');
    expect(root.dataset['theme']).toBe('light');
  });

  it('a write under a stale owner binding stores nothing (negative)', () => {
    const stale = captureOwnerBinding();
    adoptActiveOwner(OWNER_B, 'bootstrap');
    expect(writeTheme(stale, 'light')).toBe(false);
    expect(localStorage.getItem(themePrefKey(OWNER_A))).toBeNull();
    expect(localStorage.getItem(themePrefKey(OWNER_B))).toBeNull();
    expect(writeTheme(captureOwnerBinding(), 'light')).toBe(true);
    expect(localStorage.getItem(themePrefKey(OWNER_B))).toBe('light');
  });

  it('goes through the owner-scoped storage module only: a declared slot, no storage API of its own', () => {
    const slot = OWNER_STORAGE_MANIFEST.ownerSlots.themePref;
    expect(slot).toMatchObject({ area: 'local', prefix: 'ohmydate.theme', staleWrites: 'drop', onOwnerChange: 'preserve' });
    const candidates = [resolve(process.cwd(), 'src/theme/theme.ts'), resolve(process.cwd(), 'apps/web/src/theme/theme.ts')];
    const file = candidates.find((path) => existsSync(path));
    expect(file).toBeDefined();
    const source = readFileSync(file ?? '', 'utf8');
    expect(source).toContain("ownerSlot('themePref')");
    expect(/\b(localStorage|sessionStorage|indexedDB)\b/.test(source)).toBe(false);
    // The pattern does catch a direct use (negative probe).
    expect(/\b(localStorage|sessionStorage|indexedDB)\b/.test('window.localStorage.setItem("theme", "light")')).toBe(true);
  });
});

describe('stylesheets', () => {
  function stylesheet(name: string): string {
    const candidates = [resolve(process.cwd(), 'src/styles', name), resolve(process.cwd(), 'apps/web/src/styles', name)];
    const found = candidates.find((path) => existsSync(path));
    return found === undefined ? '' : readFileSync(found, 'utf8');
  }

  it('define dark on :root and light on data-scheme, and never read prefers-color-scheme themselves', () => {
    const tokens = stylesheet('tokens.css');
    expect(tokens).toMatch(/:root \{\s*color-scheme: dark;/);
    expect(tokens).toMatch(/:root\[data-scheme='light'\] \{\s*color-scheme: light;/);
    for (const name of ['tokens.css', 'base.css', 'primitives.css', 'charts.css', 'shell.css']) {
      const css = stylesheet(name);
      expect(css.length, name).toBeGreaterThan(500);
      expect(/@media[^{]*prefers-color-scheme/.test(css), name).toBe(false);
    }
  });

  it('bundle Pretendard as the first face, with no network font', () => {
    const tokens = stylesheet('tokens.css');
    expect(tokens).toMatch(/@font-face \{[^}]*font-family: 'Pretendard Variable';[^}]*font-weight: 45 920;/);
    expect(tokens).toContain("url('../assets/fonts/PretendardVariable.woff2')");
    expect(tokens).toMatch(/--font-body:\s*'Pretendard Variable',/);
    expect(/https?:\/\//.test(tokens)).toBe(false);
  });
});
