import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { mockDb } from '../src/mocks/db';
import { useAuthStore } from '../src/stores/auth';
import { useSessionStore } from '../src/stores/session';

const Stub = defineComponent({ template: '<div />' });

/** Memory router with every route the M5-03 screens link to. */
export function m5Router(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/today', name: 'today', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/replan', name: 'replan', component: Stub },
      { path: '/replan/:id', name: 'replan-proposal', component: Stub },
      { path: '/insights', name: 'insights', component: Stub },
      { path: '/plan', name: 'plan', component: Stub },
      { path: '/plan/schedule/:id', name: 'plan-schedule', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
    ],
  });
}

export interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

/** Mount a view with Pinia, Vue Query and the router; the user's zone is Asia/Seoul (mock seed). */
export async function mountView(
  component: Parameters<typeof mount>[0],
  options: { path?: string; props?: Record<string, unknown> } = {},
): Promise<Mounted> {
  const pinia = createPinia();
  useSessionStore(pinia).reset();
  useAuthStore(pinia).user = mockDb.user;
  const router = m5Router();
  await router.push(options.path ?? '/');
  const wrapper = mount(component, {
    ...(options.props === undefined ? {} : { props: options.props }),
    global: { plugins: [pinia, VueQueryPlugin, router] },
    attachTo: document.body,
  });
  return { wrapper, router, pinia };
}

export function buttonWith(root: { findAll(selector: string): DOMWrapper<Element>[] }, label: string): DOMWrapper<Element> {
  const found = root.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

export async function waitForText(wrapper: VueWrapper, text: string): Promise<void> {
  await vi.waitFor(() => expect(wrapper.text()).toContain(text));
}

/** Text of the document (dialogs teleport nowhere, but the panel is outside the wrapper root when stacked). */
export function bodyText(): string {
  return document.body.textContent ?? '';
}
