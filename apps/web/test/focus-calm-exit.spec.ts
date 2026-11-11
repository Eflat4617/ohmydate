import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import { newActionId, plannerClient, type WorkSession } from '../src/api';
import { calmMode, setCalmMode } from '../src/composables/useCalmMode';
import { sessionJournal } from '../src/session/journal';
import { useSessionStore } from '../src/stores/session';
import { TODAY_BLOCK_ONE_ID, TODAY_TASK_ONE_ID } from '../src/mocks/db';
import FocusView from '../src/views/FocusView.vue';

// UI-POLISHR-1: completing a session while Calm mode is on used to leave the
// shell navigation, the Calm toggle and "Back to Today" all hidden, so touch
// users had no in-app exit. The shell hides its navigation exactly while
// `calmMode` is true (see "calm mode" in ui-primitives.spec.ts), and the page
// hides "Back to Today" exactly while it carries `focus-page--calm`.

const Stub = defineComponent({ template: '<div />' });

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/today', name: 'today', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
    ],
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function hasButton(wrapper: VueWrapper, label: string): boolean {
  return wrapper.findAll('button').some((item) => item.text().includes(label));
}

async function startedSession(): Promise<WorkSession> {
  return plannerClient.createSession(
    {
      taskId: TODAY_TASK_ONE_ID,
      blockId: TODAY_BLOCK_ONE_ID,
      clientStartedAt: new Date().toISOString(),
      clientId: 'calm-exit-test',
    },
    newActionId('session'),
  );
}

async function mountInCalmMode(
  pinia: Pinia,
  router: Router,
): Promise<{ wrapper: VueWrapper; session: WorkSession }> {
  const session = await startedSession();
  useSessionStore(pinia).remember(session);
  await router.push(`/focus/${session.id}`);
  const wrapper = mount(FocusView, { global: { plugins: [pinia, router] }, attachTo: document.body });
  // Let the mount-time restore render (it disables the controls) before waiting for it to finish.
  await nextTick();
  await vi.waitFor(() => expect(button(wrapper, 'Pause').attributes('disabled')).toBeUndefined());

  await button(wrapper, 'Calm mode').trigger('click');
  await nextTick();
  expect(calmMode.value).toBe(true);
  expect(wrapper.get('.focus-page').classes()).toContain('focus-page--calm');
  expect(button(wrapper, 'Calm mode').attributes('aria-pressed')).toBe('true');
  return { wrapper, session };
}

function expectVisibleExit(wrapper: VueWrapper): void {
  expect(calmMode.value).toBe(false);
  expect(wrapper.get('.focus-page').classes()).not.toContain('focus-page--calm');
  expect(wrapper.find('.focus-back').exists()).toBe(true);
  expect(wrapper.get('.focus-back').text()).toContain('Back to Today');
}

describe('Calm mode exit on completion (UI-POLISHR-1)', () => {
  beforeEach(async () => {
    localStorage.clear();
    await sessionJournal.clear();
    setCalmMode(false);
  });
  afterEach(() => setCalmMode(false));

  it('leaves Calm mode on Complete and keeps the exit through review submission', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const router = testRouter();
    const { wrapper } = await mountInCalmMode(pinia, router);

    await button(wrapper, 'Complete').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('How did the session go?'));
    expectVisibleExit(wrapper);
    // The toggle is gone for completed sessions, which is why Calm mode must already be off.
    expect(hasButton(wrapper, 'Calm mode')).toBe(false);

    const radios = wrapper.findAll('input[type="radio"]');
    await radios[1]?.setValue(true);
    await button(wrapper, 'Submit review').trigger('click');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Estimation feedback'));
    expectVisibleExit(wrapper);

    await button(wrapper, 'Back to Today').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/today'));
    wrapper.unmount();
  });

  it('leaves Calm mode when the session is completed with the Enter shortcut', async () => {
    const pinia = createPinia();
    useSessionStore(pinia).reset();
    const { wrapper } = await mountInCalmMode(pinia, testRouter());

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(wrapper.text()).toContain('How did the session go?'));
    expectVisibleExit(wrapper);
    wrapper.unmount();
  });

  it('stays in Calm mode while the session is only paused and resumed (negative)', async () => {
    const pinia = createPinia();
    const store = useSessionStore(pinia);
    store.reset();
    const { wrapper, session } = await mountInCalmMode(pinia, testRouter());
    const id = session.id;

    await button(wrapper, 'Pause').trigger('click');
    await vi.waitFor(() => expect(store.get(id)?.state).toBe('paused'));
    expect(calmMode.value).toBe(true);
    expect(wrapper.get('.focus-page').classes()).toContain('focus-page--calm');

    await button(wrapper, 'Resume').trigger('click');
    await vi.waitFor(() => expect(store.get(id)?.state).toBe('active'));
    expect(calmMode.value).toBe(true);
    wrapper.unmount();
  });
});
