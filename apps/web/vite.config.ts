import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const API_PREFIX = '/api/v1';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['OHMYDATE_API_PROXY_TARGET'] ?? 'http://127.0.0.1:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(new RegExp(`^${API_PREFIX}`), ''),
      },
    },
  },
});
