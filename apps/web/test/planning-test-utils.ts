import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, nextTick } from 'vue';

const Stub = defineComponent({ template: '<div />' });

export function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/today', name: 'today', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/settings/availability', name: 'availability', component: Stub },
      { path: '/plans/new', name: 'plan-new', component: Stub },
      { path: '/plans/:id', name: 'plan', component: Stub },
    ],
  });
}

export async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

export function buttonByText(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export function mountWithPlugins(
  component: Parameters<typeof mount>[0],
  options: {
    pinia?: ReturnType<typeof createPinia>;
    router?: ReturnType<typeof testRouter>;
    props?: Record<string, unknown>;
  } = {},
) {
  const pinia = options.pinia ?? createPinia();
  const router = options.router;
  const plugins: unknown[] = [pinia, VueQueryPlugin];
  if (router !== undefined) plugins.push(router);
  return mount(component, {
    ...(options.props === undefined ? {} : { props: options.props }),
    global: { plugins: plugins as never },
    attachTo: document.body,
  });
}
