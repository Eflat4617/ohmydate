// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripInstallHead } from '../config/installHead';
import { THEME_COLOR } from '../src/theme/themeColor';
import viteConfig from '../vite.config';
import { customProperties, parseOklch, toHex } from './support/color';

/**
 * HOLO-07: the server's web can be put on a phone's home screen — a manifest,
 * icons rendered from the product's own mark, the browser bar in the theme's
 * ground — and it does that without a service worker or a cache (the app's
 * offline rules are its own). The desktop bundle carries none of it.
 */
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const read = (path: string): string => readFileSync(join(webRoot, path), 'utf8');

const indexHtml = read('index.html');
const tokens = read('src/styles/tokens.css');
const darkTokens = customProperties(tokens, '.scheme-dark,\n:root {');
const lightTokens = customProperties(tokens, ":root[data-scheme='light'] {");

function groundHex(scheme: Map<string, string>): string {
  const parsed = parseOklch(scheme.get('--color-ground') ?? '');
  if (parsed === null) throw new Error('--color-ground is not an oklch() colour');
  return toHex(parsed);
}

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}
interface Manifest {
  name: string;
  short_name: string;
  lang: string;
  id: string;
  scope: string;
  start_url: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}
const manifest = JSON.parse(read('public/manifest.webmanifest')) as Manifest;

/** Width and height out of a PNG's IHDR; throws for anything that is not a PNG. */
function pngSize(path: string): { width: number; height: number; alpha: boolean } {
  const bytes = readFileSync(join(webRoot, path));
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error(`${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), alpha: bytes[25] === 6 || bytes[25] === 4 };
}

function filesUnder(directory: string): string[] {
  return readdirSync(join(webRoot, directory)).flatMap((name) => {
    const path = join(directory, name);
    return statSync(join(webRoot, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('the web app manifest', () => {
  it('names the app, opens 개요 in its own window, upright', () => {
    expect(manifest.name).toBe('OhMyDate');
    expect(manifest.short_name).toBe('OhMyDate');
    expect(manifest.lang).toBe('ko');
    expect(manifest.start_url).toBe('/overview');
    expect(manifest.scope).toBe('/');
    expect(manifest.id).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.orientation).toBe('portrait');
  });

  it('takes its two colours from the tokens: the dark ground, the default theme', () => {
    expect(manifest.background_color).toBe(groundHex(darkTokens));
    expect(manifest.theme_color).toBe(groundHex(darkTokens));
    // Negative: not the light ground — the manifest is read before anyone has chosen a theme.
    expect(manifest.theme_color).not.toBe(groundHex(lightTokens));
  });

  it('lists a 192 and a 512 icon as given and a maskable one, each a real PNG of that size', () => {
    const byPurpose = (purpose: string) => manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes);
    expect(byPurpose('any').sort()).toEqual(['192x192', '512x512']);
    expect(byPurpose('maskable')).toEqual(['512x512']);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      expect(icon.src.startsWith('/icons/')).toBe(true);
      const { width, height, alpha } = pngSize(`public${icon.src}`);
      expect(`${width}x${height}`, icon.src).toBe(icon.sizes);
      // A launcher cuts a maskable icon to its own shape: it has no clear corners to show through.
      expect(alpha, `${icon.src} alpha`).toBe(icon.purpose !== 'maskable');
    }
  });

  it('is not a manifest that would fail to install (negative): no browser display, no relative start', () => {
    expect(['standalone', 'fullscreen', 'minimal-ui']).toContain(manifest.display);
    expect(manifest.start_url.startsWith(manifest.scope)).toBe(true);
    expect(manifest.icons.some((icon) => icon.purpose.includes(' '))).toBe(false);
  });
});

describe('the icons are the product’s own mark', () => {
  it('were rendered from the mark and the tokens as they are now', () => {
    // Throws (exit 1) when BrandMark.vue, its stroke or its three colours changed since the render.
    const out = execFileSync(process.execPath, ['scripts/render-app-icons.mjs', '--check'], { cwd: webRoot, encoding: 'utf8' });
    expect(out).toContain('is current');
  });

  it('the tab icon is the mark’s own shapes', () => {
    const svg = read('public/icons/icon.svg');
    const mark = read('src/components/BrandMark.vue');
    const ring = /<path d="([^"]+)" class="brand-mark-ring"/.exec(mark)?.[1];
    expect(ring).toBeDefined();
    expect(svg).toContain(`d="${ring ?? ''}"`);
    expect(svg).toContain(darkTokens.get('--lime') ?? 'missing');
    expect(svg).toContain(darkTokens.get('--cyan') ?? 'missing');
    // Nothing fetched, nothing embedded: shapes only.
    expect(svg).not.toMatch(/<image|href=|url\(\s*['"]?(?:https?:|data:)/);
  });

  it('the Apple touch icon is 180px with no clear corners (iOS rounds it itself)', () => {
    expect(pngSize('public/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180, alpha: false });
  });
});

describe('index.html, the server bundle’s document', () => {
  const head = /<!-- install:start[\s\S]*?<!-- install:end -->/.exec(indexHtml)?.[0] ?? '';

  it('links the manifest, the icons and the browser bar’s colour in one marked block', () => {
    expect(head).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(head).toContain('<link rel="icon" href="/icons/icon.svg" type="image/svg+xml" />');
    expect(head).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />');
    // The first paint is the default theme's: dark. theme.ts rewrites it with the owner's choice.
    expect(head).toContain(`<meta name="theme-color" content="${THEME_COLOR.dark}" />`);
    for (const match of head.matchAll(/href="(\/[^"]+)"/g)) {
      expect(existsSync(join(webRoot, 'public', match[1] ?? '')), match[1]).toBe(true);
    }
  });

  it('asks for the whole screen and lets the keyboard take its space from the page', () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(indexHtml)?.[1] ?? '';
    const parts = viewport.split(',').map((part) => part.trim());
    expect(parts).toContain('width=device-width');
    expect(parts).toContain('initial-scale=1.0');
    expect(parts).toContain('viewport-fit=cover');
    expect(parts).toContain('interactive-widget=resizes-content');
  });

  it('never takes zoom away from the reader (negative)', () => {
    expect(indexHtml).not.toMatch(/user-scalable\s*=\s*(?:no|0)/);
    expect(indexHtml).not.toMatch(/maximum-scale/);
  });
});

describe('the theme’s colours, written out for the browser bar', () => {
  it('are the two grounds of tokens.css', () => {
    expect(THEME_COLOR.dark).toBe(groundHex(darkTokens));
    expect(THEME_COLOR.light).toBe(groundHex(lightTokens));
    expect(THEME_COLOR.dark).not.toBe(THEME_COLOR.light);
  });
});

describe('no service worker, no cache', () => {
  const sources = filesUnder('src').filter((path) => /\.(?:ts|vue|js)$/.test(path));

  it('nothing in the app registers a service worker or opens a cache (negative)', () => {
    expect(sources.length).toBeGreaterThan(100);
    for (const path of sources) {
      const text = read(path);
      expect(/serviceWorker\s*\.\s*register\s*\(/.test(text), `${path} registers a service worker`).toBe(false);
      expect(/\bcaches\s*\.\s*(?:open|match|keys)\s*\(/.test(text), `${path} uses the cache storage`).toBe(false);
    }
  });

  it('public/ holds the mock API’s worker, the manifest and the icons, and no other script', () => {
    expect(filesUnder('public').map((path) => relative('public', path)).sort()).toEqual([
      'icons/apple-touch-icon.png',
      'icons/icon-192.png',
      'icons/icon-512.png',
      'icons/icon-maskable-512.png',
      'icons/icon.svg',
      'manifest.webmanifest',
      'mockServiceWorker.js',
    ]);
    expect(manifest).not.toHaveProperty('serviceworker');
  });
});

describe('the desktop bundle carries none of it', () => {
  type ConfigFn = (env: { mode: string; command: 'build' | 'serve' }) => {
    plugins?: unknown[];
    publicDir?: string | false;
  };
  const pluginNames = (mode: string, command: 'build' | 'serve' = 'build'): string[] =>
    ((viteConfig as unknown as ConfigFn)({ mode, command }).plugins ?? [])
      .flat(Infinity)
      .map((plugin) => (plugin as { name?: string } | null)?.name ?? '');
  const STRIP = 'ohmydate:desktop-without-install-head';

  it('its document loses the install block and keeps everything else', () => {
    const desktop = stripInstallHead(indexHtml);
    for (const gone of ['manifest', 'theme-color', 'apple-touch-icon', 'apple-mobile-web-app', 'rel="icon"', '/icons/', 'install:']) {
      expect(desktop, gone).not.toContain(gone);
    }
    for (const kept of ['<meta name="color-scheme" content="dark" />', '<title>OhMyDate</title>', 'viewport-fit=cover', 'src="/src/main.ts"', 'PretendardVariable.woff2']) {
      expect(desktop, kept).toContain(kept);
    }
    // Only that block went: put it back and the document is the server's again.
    expect(indexHtml.length - desktop.length).toBeGreaterThan(300);
    expect(desktop.split('\n').length).toBeLessThan(indexHtml.split('\n').length);
  });

  it('the desktop mode cuts it out, in the build and on the dev server, and has no public directory', () => {
    expect(pluginNames('desktop', 'build')).toContain(STRIP);
    // Not a build-only plugin: `vite --mode desktop` (core:dev) serves the same document.
    const plugin = ((viteConfig as unknown as ConfigFn)({ mode: 'desktop', command: 'build' }).plugins ?? [])
      .flat(Infinity)
      .find((entry) => (entry as { name?: string } | null)?.name === STRIP) as { apply?: unknown; transformIndexHtml?: { order?: string } };
    expect(plugin.apply).toBeUndefined();
    // Before Vite reads the document: it never sees the links, so it never warns about files that are not there.
    expect(plugin.transformIndexHtml?.order).toBe('pre');
    expect((viteConfig as unknown as ConfigFn)({ mode: 'desktop', command: 'build' }).publicDir).toBe(false);
  });

  it('the server bundle keeps it, whatever the mode is called (negative)', () => {
    for (const mode of ['production', 'development', 'test', 'staging', '']) {
      expect(pluginNames(mode), `mode "${mode}"`).not.toContain(STRIP);
      expect((viteConfig as unknown as ConfigFn)({ mode, command: 'build' }).publicDir, `mode "${mode}"`).toBe('public');
    }
  });

  it('a document without the block is an error, not a silent pass (negative)', () => {
    expect(() => stripInstallHead('<html><head><title>x</title></head></html>')).toThrow(/install block/);
    expect(() => stripInstallHead(indexHtml.replace('<!-- install:end -->', ''))).toThrow(/install block/);
  });
});

describe('clear of the device’s edges', () => {
  const styles = filesUnder('src/styles').filter((path) => path.endsWith('.css'));
  const css = (path: string): string => read(path).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sheet: string, selector: string): string => {
    const text = css(sheet);
    const start = text.indexOf(`${selector} {`);
    if (start === -1) throw new Error(`${sheet} has no rule ${selector}`);
    return text.slice(start, text.indexOf('}', start));
  };

  it('the four insets are tokens, each the device’s own with 0 where there is none', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(darkTokens.get(`--safe-${side}`)).toBe(`env(safe-area-inset-${side}, 0px)`);
    }
  });

  it('only tokens.css reads the device’s insets (negative)', () => {
    for (const path of styles) {
      if (path.endsWith('tokens.css')) continue;
      expect(css(path), path).not.toContain('safe-area-inset');
    }
    for (const path of filesUnder('src').filter((file) => file.endsWith('.vue'))) {
      expect(read(path), path).not.toContain('safe-area-inset');
    }
  });

  it('what floats at the foot stands on the gesture bar’s inset', () => {
    expect(rule('src/styles/shell.css', '.app-shell')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/shell.css', '.app-shell')).toContain('var(--safe-top)');
    expect(rule('src/styles/shell.css', '.bottom-nav')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/primitives.css', '.dialog--sheet')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/primitives.css', '.dialog-backdrop')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/primitives.css', '.dialog')).toContain('var(--safe-top)');
    expect(rule('src/styles/primitives.css', '.toast-region')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/screens/23-canvas.css', '.pond-foot')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/screens/08-availability.css', '.form-actions--sticky')).toContain('var(--safe-bottom)');
    expect(rule('src/styles/screens/04-focus.css', '.focus-page--calm')).toContain('var(--safe-bottom)');
  });

  it('under a finger a field’s text is 16px at least, and the page behind a sheet stays put', () => {
    const base = css('src/styles/base.css');
    const coarse = /@media \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(base)?.[1] ?? '';
    expect(coarse).toMatch(/input:not\([^)]*\),\s*select,\s*textarea \{\s*font-size: max\(1rem, 16px\) !important;/);
    expect(coarse).toMatch(/:root:has\(\.dialog-backdrop\) \{\s*overflow: hidden;\s*overscroll-behavior: none;/);
    expect(rule('src/styles/primitives.css', '.dialog-backdrop')).toContain('overscroll-behavior: contain');
  });

  it('under a mouse neither rule applies (negative): both sit inside the coarse-pointer query only', () => {
    const base = css('src/styles/base.css');
    const outside = base.replace(/@media \(pointer: coarse\) \{[\s\S]*?\n\}/g, '');
    expect(outside).not.toContain('16px) !important');
    expect(outside).not.toContain(':has(.dialog-backdrop)');
  });
});
