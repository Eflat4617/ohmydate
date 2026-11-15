/// <reference types="node" />
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import ToastHost from '../src/components/ToastHost.vue';
import UiDialog from '../src/components/ui/UiDialog.vue';
import { useToastStore } from '../src/stores/toast';
import { glassLightAllowed, installGlassLight } from '../src/theme/glassLight';
import {
  applyFilters,
  contrast,
  customProperties,
  over,
  parseLightnessFilters,
  parseOklch,
  type Colour,
  type Rgb,
} from './support/color';

/**
 * HOLO-04 material (FLOW.md §6): liquid glass for the floating layer. These
 * tests hold the three guarantees to the stylesheet itself — text on glass is
 * AA whatever is behind it, the material turns opaque where transparency is
 * missing or unwanted, and the pointer's light stays still under reduced
 * motion — and that nothing blurs except the one primitive.
 */
const STYLES = resolve(__dirname, '../src/styles');
const tokens = readFileSync(resolve(STYLES, 'tokens.css'), 'utf8');
const primitives = readFileSync(resolve(STYLES, 'primitives.css'), 'utf8');

const dark = customProperties(tokens, '.scheme-dark,\n:root {');
const light = new Map([...dark, ...customProperties(tokens, ":root[data-scheme='light'] {")]);

function token(scheme: Map<string, string>, name: string): string {
  let value = scheme.get(name);
  // `--color-accent-text: var(--lime-text)` and the like.
  for (let depth = 0; depth < 4 && value !== undefined; depth += 1) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (alias === null) break;
    value = scheme.get(alias[1] ?? '');
  }
  if (value === undefined) throw new Error(`token ${name} is missing`);
  return value;
}

function colour(scheme: Map<string, string>, name: string): Colour {
  const parsed = parseOklch(token(scheme, name));
  if (parsed === null) throw new Error(`token ${name} is not an oklch() colour: ${token(scheme, name)}`);
  return parsed;
}

/** `color-mix(in oklab, var(--lime) 8%, transparent)` → the hue at that alpha. */
function tint(scheme: Map<string, string>, name: string): Colour {
  const match = /^color-mix\(in oklab, var\((--[\w-]+)\) ([\d.]+)%, transparent\)$/.exec(token(scheme, name));
  if (match === null) throw new Error(`token ${name} is not a tint`);
  return { rgb: colour(scheme, match[1] ?? '').rgb, alpha: Number(match[2]) / 100 };
}

/** Everything set as text on glass. */
const TEXT_TOKENS = [
  '--color-text',
  '--color-text-2',
  '--color-text-3',
  '--color-accent-text',
  '--color-danger-text',
  '--color-link',
] as const;

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

/** The brightest and darkest things that can lie behind glass, plus the app's own fills. */
function backdrops(scheme: Map<string, string>): Rgb[] {
  return [WHITE, BLACK, ...['--lime', '--cyan', '--orange', '--red', '--color-ground', '--color-surface', '--color-text'].map((name) => colour(scheme, name).rgb)];
}

/**
 * What a text token is read against on glass: the fill over the filtered
 * backdrop, with (`lit`) or without the sheen and the pointer's light on top.
 */
function glassGround(scheme: Map<string, string>, fill: string, filtered: boolean, backdrop: Rgb, lit: boolean): Rgb {
  const filters = filtered ? parseLightnessFilters(token(scheme, '--glass-filter')) : [];
  const body = over(colour(scheme, fill), applyFilters(backdrop, filters));
  return lit ? over(colour(scheme, '--glass-light'), body) : body;
}

function worstContrastOf(
  scheme: Map<string, string>,
  names: readonly string[],
  fill: string,
  filtered: boolean,
  behind: readonly Rgb[],
): number {
  let worst = Infinity;
  for (const name of names) {
    for (const backdrop of behind) {
      for (const lit of [false, true]) {
        worst = Math.min(worst, contrast(colour(scheme, name).rgb, glassGround(scheme, fill, filtered, backdrop, lit)));
      }
    }
  }
  return worst;
}

function worstContrast(scheme: Map<string, string>, fill: string, filtered: boolean, behind: readonly Rgb[]): number {
  return worstContrastOf(scheme, TEXT_TOKENS, fill, filtered, behind);
}

describe('glass: text contrast', () => {
  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('%s scheme: every text token is AA on glass whatever is behind it', (_name, scheme) => {
    expect(worstContrast(scheme, '--glass-fill', true, backdrops(scheme))).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('%s scheme: the opaque material is AA with nothing else helping', (_name, scheme) => {
    const solid = colour(scheme, '--glass-solid');
    expect(solid.alpha).toBe(1);
    for (const name of TEXT_TOKENS) {
      expect(contrast(colour(scheme, name).rgb, solid.rgb), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each([
    ['dark', dark],
    ['light', light],
  ] as const)('%s scheme: still glass is AA over the ambient light at its brightest', (_name, scheme) => {
    const ground = colour(scheme, '--color-ground').rgb;
    const behind = ['--ambient-a', '--ambient-b'].map((name) => over(tint(scheme, name), ground));
    expect(worstContrast(scheme, '--glass-fill-still', false, [ground, ...behind])).toBeGreaterThanOrEqual(4.5);
    // …and the page's own quiet text on the ground under that light.
    for (const lit of behind) {
      expect(contrast(colour(scheme, '--color-text-3').rgb, lit)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('matches the table in DESIGN.md (Elevation & Depth › Glass)', () => {
    const row = (scheme: Map<string, string>): string =>
      TEXT_TOKENS.map((name) => worstContrastOf(scheme, [name], '--glass-fill', true, backdrops(scheme)).toFixed(1)).join(' ');
    expect(row(dark)).toBe('12.1 8.1 4.9 10.2 6.4 9.6');
    expect(row(light)).toBe('12.5 7.9 4.9 5.7 4.9 6.1');
  });

  it('the fill alone would not be enough: the fallbacks are what make the guarantee hold (negative)', () => {
    // Without its filter the dark fill fails over a white backdrop, which is
    // why the material must turn opaque wherever the filter is not applied.
    expect(worstContrast(dark, '--glass-fill', false, [WHITE])).toBeLessThan(4.5);
  });
});

/** The body of the first rule whose prelude is exactly `prelude` (comments removed). */
function blockAfter(css: string, prelude: string): string {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = clean.indexOf(prelude);
  if (start === -1) throw new Error(`no rule: ${prelude}`);
  const open = clean.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < clean.length; index += 1) {
    if (clean[index] === '{') depth += 1;
    else if (clean[index] === '}') {
      depth -= 1;
      if (depth === 0) return clean.slice(open + 1, index);
    }
  }
  throw new Error(`unclosed rule: ${prelude}`);
}

describe('glass: fallbacks', () => {
  const OPAQUE = /--glass-body:\s*var\(--glass-solid\);\s*--glass-backdrop:\s*none;/;

  it('is opaque where backdrop-filter is missing', () => {
    const rule = blockAfter(primitives, '@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px)))');
    expect(rule).toMatch(OPAQUE);
  });

  it('is opaque under prefers-reduced-transparency, still glass included', () => {
    const rule = blockAfter(primitives, '@media (prefers-reduced-transparency: reduce)');
    expect(rule).toContain('.glass--still');
    expect(rule).toMatch(OPAQUE);
  });

  it('is opaque when the shell asks for it on the root', () => {
    expect(blockAfter(primitives, ":root[data-transparency='reduce'] .glass")).toMatch(OPAQUE);
  });

  it('is opaque inside other glass: one refraction at a time', () => {
    expect(blockAfter(primitives, '.glass:not(.glass--host) .glass:not(.glass--still)')).toMatch(OPAQUE);
  });

  it('paints the fill and the filter from the same two properties, so they change together', () => {
    const glass = blockAfter(primitives, '.glass {');
    expect(glass).toContain('var(--glass-body)');
    expect(glass).toMatch(/-webkit-backdrop-filter:\s*var\(--glass-backdrop\)/);
    expect(glass).toMatch(/[^-]backdrop-filter:\s*var\(--glass-backdrop\)/);
    const still = blockAfter(primitives, '.glass--still {');
    expect(still).toMatch(/--glass-backdrop:\s*none/);
  });

  it('nothing but the primitive blurs (negative)', () => {
    const files = [
      ...readdirSync(STYLES).filter((name) => name.endsWith('.css')).map((name) => resolve(STYLES, name)),
      ...readdirSync(resolve(STYLES, 'screens')).map((name) => resolve(STYLES, 'screens', name)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // Declarations only (an `@supports` test names the property too).
      for (const match of css.matchAll(/(?:^|[;{])\s*(?:-webkit-)?backdrop-filter:\s*([^;]+);/gm)) {
        const value = (match[1] ?? '').trim();
        if (value !== 'var(--glass-backdrop)' && value !== 'none') offenders.push(`${file}: ${value}`);
      }
      if (!file.endsWith('tokens.css') && /[^-]filter:\s*blur\(/.test(css)) offenders.push(`${file}: filter blur`);
    }
    expect(offenders).toEqual([]);
  });

  it('the ambient light does not move', () => {
    const ambient = blockAfter(primitives, '.ambient {');
    expect(ambient).not.toMatch(/animation|transition/);
    expect(ambient).toContain('pointer-events: none');
  });
});

describe('glass: where it is', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('the top bar is a layer above the page at every width, so its menus are never under page content', () => {
    // Found in the HOLO-04 sweep: at 390px the account menu was painted under a
    // sticky header of the page, because the bar only became a layer at 1024px.
    const shell = readFileSync(resolve(STYLES, 'shell.css'), 'utf8');
    const firstMedia = shell.indexOf('@media');
    const base = /\n\.app-topbar \{([^}]*)\}/.exec(shell.slice(0, shell.indexOf('@media', shell.indexOf('\n.app-topbar {'))));
    expect(firstMedia).toBeGreaterThan(-1);
    expect(base?.[1]).toMatch(/position: relative;/);
    expect(base?.[1]).toMatch(/z-index: var\(--z-topbar\);/);
    // …and that layer is above the page's sticky parts, below the navigation and what floats (negative).
    const z = (name: string): number => Number(token(dark, name));
    expect(z('--z-topbar')).toBeGreaterThan(z('--z-sticky'));
    expect(z('--z-topbar')).toBeLessThan(z('--z-nav'));
    expect(z('--z-topbar')).toBeLessThan(z('--z-dialog'));
  });

  it('a dialog and a sheet are glass', () => {
    const dialog = mount(UiDialog, { props: { labelledby: 'x' }, slots: { default: () => h('h2', { id: 'x' }, 'x') }, attachTo: document.body });
    expect(dialog.get('[role="dialog"]').classes()).toEqual(expect.arrayContaining(['dialog', 'glass']));
    dialog.unmount();
    const sheet = mount(UiDialog, { props: { labelledby: 'y', variant: 'sheet' }, slots: { default: () => h('h2', { id: 'y' }, 'y') }, attachTo: document.body });
    expect(sheet.get('[role="dialog"]').classes()).toEqual(expect.arrayContaining(['dialog--sheet', 'glass']));
    sheet.unmount();
  });

  it('a toast is glass', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    const host = mount(ToastHost, { global: { plugins: [pinia] } });
    useToastStore().show('saved', { duration: 0 });
    await host.vm.$nextTick();
    expect(host.get('.toast').classes()).toContain('glass');
    host.unmount();
  });
});

describe('glass: the pointer\'s light', () => {
  function media(matches: Record<string, boolean>): typeof window.matchMedia {
    return ((query: string) => ({ matches: matches[query] ?? false, media: query })) as unknown as typeof window.matchMedia;
  }
  const FINE = '(hover: hover) and (pointer: fine)';
  const REDUCED = '(prefers-reduced-motion: reduce)';

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('is allowed only with a fine hovering pointer and motion', () => {
    expect(glassLightAllowed({ matchMedia: media({ [FINE]: true }) })).toBe(true);
    expect(glassLightAllowed({ matchMedia: media({ [FINE]: true, [REDUCED]: true }) })).toBe(false);
    expect(glassLightAllowed({ matchMedia: media({}) })).toBe(false);
  });

  it('is not installed under reduced motion: nothing on glass moves (negative)', () => {
    vi.stubGlobal('matchMedia', media({ [FINE]: true, [REDUCED]: true }));
    expect(installGlassLight()).toBeNull();
  });

  it('lights the glass under the mouse and clears it when stopped', () => {
    vi.stubGlobal('matchMedia', media({ [FINE]: true }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const surface = document.createElement('div');
    surface.className = 'glass';
    const inner = document.createElement('button');
    surface.appendChild(inner);
    const plain = document.createElement('p');
    document.body.append(surface, plain);
    surface.getBoundingClientRect = () => ({ left: 10, top: 20, right: 210, bottom: 120, width: 200, height: 100, x: 10, y: 20, toJSON: () => ({}) });

    const handle = installGlassLight();
    expect(handle).not.toBeNull();
    const move = (target: Element, type = 'mouse'): void => {
      const event = new MouseEvent('pointermove', { bubbles: true, clientX: 60, clientY: 50 });
      Object.defineProperty(event, 'pointerType', { value: type });
      target.dispatchEvent(event);
    };
    move(inner);
    expect(surface.style.getPropertyValue('--glass-x')).toBe('50px');
    expect(surface.style.getPropertyValue('--glass-y')).toBe('30px');
    // Off the glass the light goes out.
    move(plain);
    expect(surface.style.getPropertyValue('--glass-x')).toBe('');
    // A finger is not a light.
    move(inner, 'touch');
    expect(surface.style.getPropertyValue('--glass-x')).toBe('');
    move(inner);
    handle?.stop();
    expect(surface.style.getPropertyValue('--glass-x')).toBe('');
    move(inner);
    expect(surface.style.getPropertyValue('--glass-x')).toBe('');
  });
});
