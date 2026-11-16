#!/usr/bin/env node
// HOLO-07: renders the home-screen icons from OhMyDate's own mark — the open
// ring and the day's dot on the lime-to-cyan tile (src/components/BrandMark.vue).
//
//   node scripts/render-app-icons.mjs            # writes public/icons/*
//   node scripts/render-app-icons.mjs --check    # exits 1 if the mark or its colours changed since
//
// Nothing is drawn here: the shapes are read out of BrandMark.vue, the ring's
// stroke out of styles/shell.css and the three colours out of styles/tokens.css
// (the dark scheme, the default), and a headless browser paints them at each
// size. Run it again and commit the result when the mark or those tokens change.
//
// What it writes:
//   icon.svg                 the mark as it is in the app (the browser tab)
//   icon-192.png, -512.png   the same, for a launcher that draws the icon as given
//   icon-maskable-512.png    the tile's colour to every edge, the ring and dot inside the
//                            safe zone, for a launcher that cuts its own shape
//   apple-touch-icon.png     180px, to every edge, no transparency (iOS rounds it itself)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const outDir = join(webRoot, 'public', 'icons');
const SOURCE_FILE = join(here, 'app-icons.source.sha256');

function need(match, what) {
  if (match === null) throw new Error(`render-app-icons: cannot find ${what}; the mark's source changed shape`);
  return match;
}

/** A custom property of the dark scheme (the first `:root` block of tokens.css). */
function token(tokens, name) {
  return need(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm').exec(tokens), `the token ${name}`)[1].trim();
}

export async function readMark() {
  const [vue, shell, tokens] = await Promise.all([
    readFile(join(webRoot, 'src/components/BrandMark.vue'), 'utf8'),
    readFile(join(webRoot, 'src/styles/shell.css'), 'utf8'),
    readFile(join(webRoot, 'src/styles/tokens.css'), 'utf8'),
  ]);
  const viewBox = need(/viewBox="0 0 (\d+) (\d+)"/.exec(vue), 'the viewBox');
  const gradient = need(/<linearGradient[^>]*x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(vue), 'the gradient');
  const tile = need(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/.exec(vue), 'the tile');
  const ring = need(/<path d="([^"]+)" class="brand-mark-ring"/.exec(vue), 'the ring');
  const dot = need(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" class="brand-mark-dot"/.exec(vue), 'the dot');
  const ringRule = need(/\.brand-mark-ring\s*\{([^}]*)\}/.exec(shell), 'the ring rule')[1];
  const strokeWidth = need(/stroke-width:\s*([\d.]+)/.exec(ringRule), "the ring's stroke width")[1];
  if (viewBox[1] !== viewBox[2]) throw new Error('render-app-icons: the mark is not square');
  return {
    box: Number(viewBox[1]),
    gradient: { x1: gradient[1], y1: gradient[2], x2: gradient[3], y2: gradient[4] },
    tile: { x: tile[1], y: tile[2], width: tile[3], height: tile[4], rx: tile[5] },
    ring: ring[1],
    strokeWidth,
    dot: { cx: dot[1], cy: dot[2], r: dot[3] },
    lime: token(tokens, '--lime'),
    cyan: token(tokens, '--cyan'),
    ink: token(tokens, '--color-on-accent'),
  };
}

/** `bleed`: the tile's gradient to every edge (a launcher, or iOS, cuts the shape). */
export function markSvg(mark, { bleed = false, size = null } = {}) {
  const { box, gradient, tile, dot } = mark;
  const ground = bleed
    ? `<rect width="${box}" height="${box}" fill="url(#tile)"/>`
    : `<rect x="${tile.x}" y="${tile.y}" width="${tile.width}" height="${tile.height}" rx="${tile.rx}" fill="url(#tile)"/>`;
  const sized = size === null ? '' : ` width="${size}" height="${size}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}"${sized}>`,
    `<defs><linearGradient id="tile" x1="${gradient.x1}" y1="${gradient.y1}" x2="${gradient.x2}" y2="${gradient.y2}" gradientUnits="userSpaceOnUse">`,
    `<stop offset="0" stop-color="${mark.lime}"/><stop offset="1" stop-color="${mark.cyan}"/>`,
    `</linearGradient></defs>`,
    ground,
    `<path d="${mark.ring}" fill="none" stroke="${mark.ink}" stroke-width="${mark.strokeWidth}" stroke-linecap="round"/>`,
    `<circle cx="${dot.cx}" cy="${dot.cy}" r="${dot.r}" fill="${mark.ink}"/>`,
    `</svg>`,
  ].join('');
}

/** What the committed icons were rendered from: the mark's shapes and colours. */
export function markDigest(mark) {
  return createHash('sha256').update(JSON.stringify(mark)).digest('hex');
}

export const ICON_FILES = [
  { file: 'icon-192.png', size: 192, bleed: false },
  { file: 'icon-512.png', size: 512, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, bleed: true },
];

async function render(mark) {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    await mkdir(outDir, { recursive: true });
    for (const { file, size, bleed } of ICON_FILES) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.setContent(
        `<!doctype html><html><body style="margin:0;background:transparent">${markSvg(mark, { bleed, size })}</body></html>`,
      );
      const png = await page.screenshot({ omitBackground: !bleed, clip: { x: 0, y: 0, width: size, height: size } });
      await writeFile(join(outDir, file), png);
      await page.close();
      console.log(`${file}  ${size}×${size}  ${png.byteLength} bytes`);
    }
  } finally {
    await browser.close();
  }
  await writeFile(join(outDir, 'icon.svg'), `${markSvg(mark)}\n`);
  await writeFile(SOURCE_FILE, `${markDigest(mark)}\n`);
  console.log('icon.svg');
}

async function main() {
  const mark = await readMark();
  if (process.argv.includes('--check')) {
    const committed = (await readFile(SOURCE_FILE, 'utf8').catch(() => '')).trim();
    if (committed !== markDigest(mark)) {
      console.error('render-app-icons: the mark or its colours changed; run `node scripts/render-app-icons.mjs` and commit public/icons/.');
      process.exit(1);
    }
    console.log('render-app-icons: public/icons/ is current.');
    return;
  }
  await render(mark);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
