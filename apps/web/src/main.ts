import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';
import { DEFAULT_LOCALE, setLocale } from './i18n';
import { installPageSeal } from './session/ownerEpoch';
import { createOwnerQueryClient } from './session/ownerQuery';
import './styles.css';

async function bootstrap(): Promise<void> {
  if (import.meta.env.VITE_MOCK === '1') {
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
}

void bootstrap();
