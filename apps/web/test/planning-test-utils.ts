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
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/settings/availability', name: 'availability', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/replan/:id', name: 'replan-proposal', component: Stub },
      { path: '/settings/calendar', name: 'calendar-settings', component: Stub },
      // HOLO-03A: 계획 세우기 is one flow.
      { path: '/plan', name: 'plan', component: Stub },
      { path: '/plan/schedule', name: 'plan-scope', component: Stub },
      { path: '/plan/schedule/:id', name: 'plan-schedule', component: Stub },
      { path: '/plan/:sessionId', name: 'plan-session', component: Stub },
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
