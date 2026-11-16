#!/usr/bin/env node
// HOLO-05: renders OhMyDate's own glass object (src/components/ui/glassScene.js,
// three.js) to the still image that stands in for it wherever it cannot be
// drawn live — without WebGL, while the scene loads, for a second object on a
// page, and when frames come too slowly:
//
//   node scripts/render-glass-orb.mjs                 # writes src/assets/glass-orb.webp
//   node scripts/render-glass-orb.mjs --out /tmp/x.png --time 12.5 --light 1 --size 640
//   node scripts/render-glass-orb.mjs --url http://127.0.0.1:5197   # a dev server that is already up
//
// The picture is drawn by the same module the app draws live, in a headless
// browser (the dev server serves it); nothing else goes into it. Commit the
// result when the scene changes.
/* global document -- used only inside page.evaluate() browser callbacks */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

const out = resolve(arg('out', join(webRoot, 'src/assets/glass-orb.webp')));
const size = Number(arg('size', '560'));
const time = arg('time', '');
const light = Number(arg('light', '0'));
const port = Number(arg('port', '5198'));
const type = extname(out) === '.png' ? 'image/png' : 'image/webp';
let baseUrl = arg('url', '');

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
    child.on('exit', (code) => fail(new Error(`vite exited with ${code}`)));
  });
  return child;
}

let vite = null;
if (baseUrl.length === 0) {
  vite = await startVite();
  baseUrl = `http://127.0.0.1:${port}`;
}
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  // Any page of the dev server will do: only its module graph is used.
  await page.goto(`${baseUrl}/login`);
  const dataUrl = await page.evaluate(
    async ({ size: side, time: at, light: scheme, type: mime }) => {
      const [{ createGlassScene }, rules] = await Promise.all([
        import('/src/components/ui/glassScene.js'),
        import('/src/components/ui/glassOrb.ts'),
      ]);
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      const scene = createGlassScene(canvas);
      if (scene === null) throw new Error('WebGL is not available in this browser');
      scene.draw(at === '' ? rules.GLASS_STILL_TIME : Number(at), scheme);
      // Read in the same task as the draw: the drawing buffer is still there.
      const url = canvas.toDataURL(mime, 0.92);
      scene.dispose();
      return url;
    },
    { size, time, light, type },
  );
  await writeFile(out, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  console.log(`${out} (${size}×${size}, ${type})`);
} finally {
  await browser.close();
  vite?.kill();
}
