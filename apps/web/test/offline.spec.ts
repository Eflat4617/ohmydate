import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, nextTick } from 'vue';
import AppShell from '../src/components/AppShell.vue';
import QuickAddForm from '../src/components/QuickAddForm.vue';

const Stub = defineComponent({ template: '<div />' });

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
      { path: '/today', name: 'today', component: Stub },
    ],
  });
}

function setOnline(value: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value });
}

describe('offline banner and disabled mutations', () => {
  afterEach(() => {
    setOnline(true);
  });

  it('shows a polite read-only banner while offline and hides it when online', async () => {
    setOnline(false);
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), testRouter()] },
      slots: { default: '<p>Body</p>' },
      attachTo: document.body,
    });
    await flushPromises();

    const banner = wrapper.get('.offline-banner');
    expect(banner.attributes('role')).toBe('status');
    expect(banner.attributes('aria-live')).toBe('polite');
    expect(banner.text()).toContain('다시 연결되면 편집할 수 있어요');

    setOnline(true);
    window.dispatchEvent(new Event('online'));
    await nextTick();
    await nextTick();

    expect(wrapper.find('.offline-banner').exists()).toBe(false);
    wrapper.unmount();
  });

  it('disables the quick-add input and button when mutations are disabled', async () => {
    const wrapper = mount(QuickAddForm, { props: { disabled: true } });

    expect(wrapper.get('input').attributes('disabled')).toBeDefined();
    expect(wrapper.get('button').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('opens keyboard help with the ? shortcut', async () => {
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), testRouter()] },
      slots: { default: '<p>Body</p>' },
    });
    await flushPromises();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?' }));
    await nextTick();

    expect(wrapper.text()).toContain('키보드 단축키');
    wrapper.unmount();
  });
});
