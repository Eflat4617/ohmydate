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

export default defineConfig({
  plugins: [vue(), renderBlockingEntry()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['OHMYDATE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
});
