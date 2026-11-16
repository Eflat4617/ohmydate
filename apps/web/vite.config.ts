import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';

/**
 * HOLO-01: the entry module puts the stored theme on <html> before it mounts
 * the app (src/theme/theme.ts). `blocking="render"` keeps the browser from
 * painting a frame before that has run, so a light-theme user never sees a
 * dark one. The build rewrites the entry tag, so the attribute is put back.
 */
function renderBlockingEntry(): Plugin {
  return {
    name: 'ohmydate:render-blocking-entry',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) =>
        html.replace(/<script type="module"(?![^>]*\bblocking=)([^>]*\bsrc=)/, '<script type="module" blocking="render"$1'),
    },
  };
}

/**
 * Two bundles come out of this config (src/platform/mode.ts):
 *
 * - the server's web: `vite build` → `dist/`. What is deployed.
 * - the desktop's web: `vite build --mode desktop` → `desktop/dist/`. What the
 *   Rust core serves with `--web-dir` (blueprint 15 §1.3).
 *
 * They never share a directory: `local:start` serves `dist/`, and a desktop
 * bundle left there would be a deployed app without a login form.
 *
 * Everything else is Vite's default, on purpose (15 §7.3 item 6): `base: '/'`
 * and content-hashed files under `assets/` are what the core's cache rules
 * and its "a missing file is a 404" rule rest on.
 */
export default defineConfig(({ mode }) => ({
  plugins: [vue(), renderBlockingEntry()],
  // `public/` holds one file, the mock API's service worker. The desktop
  // bundle registers no service worker (15 §4.2), so it does not carry one.
  publicDir: mode === 'desktop' ? false : 'public',
  build: {
    outDir: mode === 'desktop' ? 'desktop/dist' : 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['OHMYDATE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
}));
