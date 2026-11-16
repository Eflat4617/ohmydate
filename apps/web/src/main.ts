import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';
import { DEFAULT_LOCALE, setLocale } from './i18n';
import { installPageSeal } from './session/ownerEpoch';
import { createOwnerQueryClient } from './session/ownerQuery';
import { mockApiWanted } from './platform/mode';
import { installGlassLight } from './theme/glassLight';
import { bootTheme } from './theme/theme';
import { bootTransparency } from './theme/transparency';
import './styles.css';

async function bootstrap(): Promise<void> {
  // The desktop bundle registers no service worker, the mock's included (15 §4.2).
  if (mockApiWanted()) {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledFrame: 'bypass' });
  }
  setLocale(DEFAULT_LOCALE);
  // ADR-023 guardrail: this page serves one owner. When the owner changes it
  // seals itself (storage, cache, toasts, navigation) until the hard reload.
  installPageSeal();
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(VueQueryPlugin, { queryClient: createOwnerQueryClient() });
  app.mount('#app');
  // The pointer's light on glass: an enhancement, off without a mouse or under reduced motion.
  installGlassLight();
}

// HOLO-01: the stored theme goes on <html> before anything is mounted or
// awaited (index.html holds the first paint until this module has run).
bootTheme();
bootTransparency();

void bootstrap();
