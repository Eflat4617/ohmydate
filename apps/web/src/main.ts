import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { VueQueryPlugin } from '@tanstack/vue-query';
import App from './App.vue';
import { router } from './router';
import './styles.css';

async function bootstrap(): Promise<void> {
  if (import.meta.env.VITE_MOCK === '1') {
    const { worker } = await import('./mocks/browser');
    await worker.start({ onUnhandledFrame: 'bypass' });
  }
  const app = createApp(App);
  app.use(createPinia());
  app.use(router);
  app.use(VueQueryPlugin);
  app.mount('#app');
}

void bootstrap();
