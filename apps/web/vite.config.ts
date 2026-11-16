import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
import vue from '@vitejs/plugin-vue';
import { allowedHostsFromEnv } from './config/allowedHosts';
import { CORE_READY_FILE_ENV, coreApiProxy } from './config/coreProxy';
import { desktopWithoutInstallHead } from './config/installHead';

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
 *   Rust core serves with `--web-dir` (blueprint 15 §1.3). In development
 *   (`vite --mode desktop`, started by `core:dev`) the dev server serves it
 *   and proxies `/api` to a running core.
 *
 * They never share a directory: `local:start` serves `dist/`, and a desktop
 * bundle left there would be a deployed app without a login form.
 *
 * Everything else is Vite's default, on purpose (15 §7.3 item 6): `base: '/'`
 * and content-hashed files under `assets/` are what the core's cache rules
 * and its "a missing file is a 404" rule rest on.
 */
export default defineConfig(({ mode, command }) => ({
  // The desktop bundle is not something to install: its document loses the
  // install block (config/installHead.ts, HOLO-07).
  plugins: [vue(), renderBlockingEntry(), ...(mode === 'desktop' ? [desktopWithoutInstallHead()] : [])],
  // `public/` holds the mock API's service worker and what a phone installs
  // (the manifest, the icons). The desktop bundle registers no service worker
  // (15 §4.2) and is not installed, so it carries none of it.
  publicDir: mode === 'desktop' ? false : 'public',
  build: {
    outDir: mode === 'desktop' ? 'desktop/dist' : 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': mode === 'desktop' && command === 'serve' ? desktopDevProxy() : serverDevProxy(),
    },
  },
  // The built server web (`vite preview`, started by `local:start`): loopback
  // names always, plus the exact names the operator listed — a tailnet name
  // behind `tailscale serve` (config/allowedHosts.ts). Never the desktop's.
  ...(mode === 'desktop' ? {} : previewHosts()),
}));

function previewHosts(): { preview?: { allowedHosts: string[] } } {
  const hosts = allowedHostsFromEnv();
  return hosts.length === 0 ? {} : { preview: { allowedHosts: hosts } };
}

/** The server's web in development: the planner API, which signs people in itself. */
function serverDevProxy(): ProxyOptions {
  return {
    target: process.env['OHMYDATE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
    changeOrigin: true,
  };
}

/**
 * The desktop's web in development (`corepack pnpm run core:dev`): a running
 * Rust core, reached with its launch token (config/coreProxy.ts). Without a
 * core there is nothing to develop against, so that is an error here and not
 * a page full of 401s.
 */
function desktopDevProxy(): ProxyOptions {
  const readyFile = process.env[CORE_READY_FILE_ENV];
  if (readyFile === undefined || readyFile.length === 0) {
    throw new Error(
      `the desktop dev server needs a running core: start both with \`corepack pnpm run core:dev\` (it sets ${CORE_READY_FILE_ENV}).`,
    );
  }
  return coreApiProxy(readyFile);
}
