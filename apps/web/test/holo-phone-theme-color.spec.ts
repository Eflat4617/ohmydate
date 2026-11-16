import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { bootTheme, resetThemeForTests, useTheme } from '../src/theme/theme';
import { THEME_COLOR, applyThemeColor } from '../src/theme/themeColor';

/**
 * HOLO-07: the browser's bar (and an installed app's status bar) follows the
 * theme the owner chose — at boot, on the switch, and when the system flips
 * under 시스템. A document without the tag (the desktop bundle) gets none.
 */
const OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';

function installSystemScheme(initialLight: boolean): { set(light: boolean): void } {
  let light = initialLight;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return light;
      },
      media: query,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  restoreMatchMedia = () => {
    window.matchMedia = original;
  };
  return {
    set(next) {
      light = next;
      for (const listener of [...listeners]) listener({ matches: next } as MediaQueryListEvent);
    },
  };
}

let restoreMatchMedia: (() => void) | null = null;

function addTag(): HTMLMetaElement {
  const tag = document.createElement('meta');
  tag.name = 'theme-color';
  // What index.html ships: the default theme's ground.
  tag.content = THEME_COLOR.dark;
  document.head.append(tag);
  return tag;
}

beforeEach(() => {
  localStorage.clear();
  resetThemeForTests();
  adoptActiveOwner(OWNER, 'bootstrap');
});

afterEach(() => {
  resetThemeForTests();
  restoreMatchMedia?.();
  restoreMatchMedia = null;
  adoptActiveOwner(null, 'bootstrap');
  localStorage.clear();
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((tag) => tag.remove());
});

describe('the browser bar follows the theme', () => {
  it('is the dark ground by default and changes with the switch', () => {
    installSystemScheme(false);
    const tag = addTag();
    bootTheme();
    expect(tag.content).toBe(THEME_COLOR.dark);
    const { setTheme } = useTheme();
    setTheme('light');
    expect(tag.content).toBe(THEME_COLOR.light);
    setTheme('dark');
    expect(tag.content).toBe(THEME_COLOR.dark);
  });

  it('comes up in the stored theme: a 라이트 owner’s bar is light from the first frame', () => {
    installSystemScheme(false);
    bootTheme();
    useTheme().setTheme('light');
    resetThemeForTests();
    const tag = addTag();
    bootTheme();
    expect(tag.content).toBe(THEME_COLOR.light);
  });

  it('under 시스템 it follows the system, and stops when the owner picks a theme (negative)', () => {
    const system = installSystemScheme(true);
    const tag = addTag();
    bootTheme();
    const { setTheme } = useTheme();
    setTheme('system');
    expect(tag.content).toBe(THEME_COLOR.light);
    system.set(false);
    expect(tag.content).toBe(THEME_COLOR.dark);
    setTheme('dark');
    system.set(true);
    expect(tag.content).toBe(THEME_COLOR.dark);
  });

  it('a document without the tag gets none (negative): the desktop bundle’s head stays as it is', () => {
    installSystemScheme(false);
    bootTheme();
    useTheme().setTheme('light');
    applyThemeColor('light');
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
  });
});
