import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h, nextTick, ref } from 'vue';
import AppShell from '../src/components/AppShell.vue';
import WeekCalendar from '../src/components/WeekCalendar.vue';
import UiBanner from '../src/components/ui/UiBanner.vue';
import UiButton from '../src/components/ui/UiButton.vue';
import UiDialog from '../src/components/ui/UiDialog.vue';
import UiField from '../src/components/ui/UiField.vue';
import { clearFocusContexts, focusContextFor, rememberFocusBlocks } from '../src/composables/focusContext';
import { calmMode, setCalmMode } from '../src/composables/useCalmMode';

async function ticks(): Promise<void> {
  await nextTick();
  await nextTick();
}

/** A page with an editor and a toast region next to a dialog host. */
function dialogHarness(dialogProps: Record<string, unknown> = {}) {
  const open = ref(true);
  const closed = ref(0);
  const Harness = defineComponent({
    setup() {
      return () =>
        h('div', { id: 'page' }, [
          h('div', { id: 'editor' }, [h('input', { id: 'editor-input' })]),
          h('div', { id: 'already-inert', inert: '' }),
          h('div', { id: 'toasts', 'data-modal-exempt': '' }, [h('button', { id: 'toast-undo' }, 'Undo')]),
          h('section', { id: 'host' }, [
            open.value
              ? h(
                  UiDialog,
                  {
                    labelledby: 'test-title',
                    onClose: () => {
                      closed.value += 1;
                    },
                    ...dialogProps,
                  },
                  () => [
                    h('h2', { id: 'test-title' }, 'Test dialog'),
                    h('button', { id: 'first' }, 'First'),
                    h('button', { id: 'preferred', 'data-autofocus': '' }, 'Preferred'),
                    h('button', { id: 'last' }, 'Last'),
                  ],
                )
              : null,
          ]),
        ]);
    },
  });
  return { Harness, open, closed };
}

describe('UiDialog (FU-09 primitive)', () => {
  it('focuses [data-autofocus], makes the page inert and restores both on close', async () => {
    const opener = document.createElement('button');
    opener.textContent = 'Opener';
    document.body.appendChild(opener);
    opener.focus();

    const { Harness, open } = dialogHarness();
    const wrapper = mount(Harness, { attachTo: document.body });
    await ticks();

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBe('test-title');
    expect(document.activeElement?.id).toBe('preferred');
    expect(wrapper.get('#editor').attributes('inert')).toBeDefined();
    expect(opener.hasAttribute('inert')).toBe(true);

    open.value = false;
    await ticks();

    expect(wrapper.get('#editor').attributes('inert')).toBeUndefined();
    expect(opener.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(opener);

    wrapper.unmount();
    opener.remove();
  });

  it('never touches pre-existing inert regions or opted-out live regions (negative)', async () => {
    const { Harness, open } = dialogHarness();
    const wrapper = mount(Harness, { attachTo: document.body });
    await ticks();

    expect(wrapper.get('#toasts').attributes('inert')).toBeUndefined();
    open.value = false;
    await ticks();
    // It was inert before the dialog opened, so it must stay inert afterwards.
    expect(wrapper.get('#already-inert').attributes('inert')).toBeDefined();
    wrapper.unmount();
  });

  it('traps Tab at both ends and reclaims escaped focus', async () => {
    const { Harness } = dialogHarness();
    const wrapper = mount(Harness, { attachTo: document.body });
    await ticks();
    const dialog = wrapper.get('[role="dialog"]');

    (wrapper.get('#last').element as HTMLElement).focus();
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement?.id).toBe('first');

    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement?.id).toBe('last');

    (wrapper.get('#editor-input').element as HTMLElement).focus();
    expect(document.activeElement?.id).toBe('preferred');
    wrapper.unmount();
  });

  it('closes on Escape and keeps single-key shortcuts away from window listeners', async () => {
    const { Harness, closed } = dialogHarness();
    const wrapper = mount(Harness, { attachTo: document.body });
    await ticks();
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener('keydown', listener);

    const dialog = wrapper.get('[role="dialog"]').element;
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.dispatchEvent(escape);

    expect(seen).toEqual([]);
    expect(escape.defaultPrevented).toBe(true);
    expect(closed.value).toBe(1);
    window.removeEventListener('keydown', listener);
    wrapper.unmount();
  });

  it('ignores Escape and backdrop clicks while not dismissible (negative)', async () => {
    const { Harness, closed } = dialogHarness({ dismissible: false, closeOnBackdrop: true });
    const wrapper = mount(Harness, { attachTo: document.body });
    await ticks();

    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    wrapper.get('[role="dialog"]').element.dispatchEvent(escape);
    await wrapper.get('.dialog-backdrop').trigger('click');

    expect(escape.defaultPrevented).toBe(true);
    expect(closed.value).toBe(0);
    wrapper.unmount();
  });

  it('closes on backdrop click only when asked to', async () => {
    const withBackdrop = dialogHarness({ closeOnBackdrop: true });
    const one = mount(withBackdrop.Harness, { attachTo: document.body });
    await ticks();
    await one.get('.dialog-backdrop').trigger('click');
    expect(withBackdrop.closed.value).toBe(1);
    one.unmount();

    const without = dialogHarness();
    const two = mount(without.Harness, { attachTo: document.body });
    await ticks();
    await two.get('.dialog-backdrop').trigger('click');
    expect(without.closed.value).toBe(0);
    two.unmount();
  });

  it('falls back to the first enabled control when the autofocus target is disabled', async () => {
    const Disabled = defineComponent({
      setup() {
        return () =>
          h(UiDialog, { labelledby: 'x' }, () => [
            h('h2', { id: 'x' }, 'X'),
            h('button', { id: 'blocked', 'data-autofocus': '', disabled: true }, 'Blocked'),
            h('button', { id: 'available' }, 'Available'),
          ]);
      },
    });
    const wrapper = mount(Disabled, { attachTo: document.body });
    await ticks();
    expect(document.activeElement?.id).toBe('available');
    wrapper.unmount();
  });
});

describe('UiButton', () => {
  it('renders a native button with variant classes and a busy spinner', () => {
    const wrapper = mount(UiButton, {
      props: { variant: 'primary', busy: true },
      attrs: { disabled: true },
      slots: { default: () => 'Saving…' },
    });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('button');
    expect(button.classes()).toEqual(expect.arrayContaining(['btn', 'btn--primary']));
    expect(button.attributes('aria-busy')).toBe('true');
    expect(button.attributes('disabled')).toBeDefined();
    expect(button.find('.spinner').exists()).toBe(true);
    expect(button.text()).toBe('Saving…');
  });

  it('does not mark idle buttons busy or disable them (negative)', () => {
    const wrapper = mount(UiButton, { props: { type: 'submit' }, slots: { default: () => 'Save' } });
    const button = wrapper.get('button');
    expect(button.attributes('type')).toBe('submit');
    expect(button.attributes('aria-busy')).toBeUndefined();
    expect(button.attributes('disabled')).toBeUndefined();
    expect(button.find('.spinner').exists()).toBe(false);
  });
});

describe('UiField', () => {
  it('labels the control and wires help and error into aria-describedby', () => {
    const wrapper = mount(UiField, {
      props: { id: 'f1', label: 'Title', help: 'Shown on Today', error: 'Required' },
      slots: {
        default: (slot: { describedby?: string; invalid?: string }) =>
          h('input', { id: 'f1', 'aria-describedby': slot.describedby, 'aria-invalid': slot.invalid }),
      },
    });
    expect(wrapper.get('label').attributes('for')).toBe('f1');
    expect(wrapper.get('label').text()).toBe('Title');
    const input = wrapper.get('input');
    expect(input.attributes('aria-describedby')).toBe('f1-help f1-error');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('#f1-error').text()).toContain('Required');
  });

  it('adds no description or invalid state without help/error (negative)', () => {
    const wrapper = mount(UiField, {
      props: { id: 'f2', label: 'Plain' },
      slots: {
        default: (slot: { describedby?: string; invalid?: string }) =>
          h('input', { id: 'f2', 'aria-describedby': slot.describedby, 'aria-invalid': slot.invalid }),
      },
    });
    const input = wrapper.get('input');
    expect(input.attributes('aria-describedby')).toBeUndefined();
    expect(input.attributes('aria-invalid')).toBeUndefined();
    expect(wrapper.find('.field-error').exists()).toBe(false);
  });
});

describe('UiBanner', () => {
  it('uses the tone class and only the live role the caller asks for', () => {
    const alert = mount(UiBanner, { props: { tone: 'error', role: 'alert' }, slots: { default: () => 'Broken' } });
    expect(alert.classes()).toContain('banner--error');
    expect(alert.attributes('role')).toBe('alert');

    const quiet = mount(UiBanner, { props: { tone: 'offline' }, slots: { default: () => 'Offline' } });
    expect(quiet.classes()).toContain('banner--offline');
    expect(quiet.attributes('role')).toBeUndefined();
  });
});

describe('focus context (presentational title lookup)', () => {
  afterEach(() => clearFocusContexts());

  const block = {
    id: 'block-1',
    taskId: 'task-1',
    title: 'Summarise research notes',
    startAt: '2026-11-14T10:00:00.000Z',
    endAt: '2026-11-14T11:30:00.000Z',
  };

  it('finds a block by id, then by task id, for the same owner', () => {
    rememberFocusBlocks('owner-a', [block], 'Asia/Seoul');
    expect(focusContextFor('owner-a', 'block-1', 'other')?.title).toBe(block.title);
    expect(focusContextFor('owner-a', null, 'task-1')?.timeZone).toBe('Asia/Seoul');
  });

  it('never returns another owner’s titles (negative)', () => {
    rememberFocusBlocks('owner-a', [block], 'Asia/Seoul');
    expect(focusContextFor('owner-b', 'block-1', 'task-1')).toBeNull();
    expect(focusContextFor('owner-a', 'missing', 'missing')).toBeNull();
  });
});

describe('calm mode', () => {
  afterEach(() => setCalmMode(false));

  it('lets the shell step back and comes back when turned off', async () => {
    const Stub = defineComponent({ template: '<div />' });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Stub },
        { path: '/inbox', name: 'inbox', component: Stub },
        { path: '/today', name: 'today', component: Stub },
      ],
    });
    await router.push('/today');
    await router.isReady();
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), router] },
      slots: { default: () => h('p', 'content') },
      attachTo: document.body,
    });
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
    });

    expect(wrapper.get('.app-shell').classes()).not.toContain('app-shell--calm');
    setCalmMode(true);
    await nextTick();
    expect(calmMode.value).toBe(true);
    expect(wrapper.get('.app-shell').classes()).toContain('app-shell--calm');
    setCalmMode(false);
    await nextTick();
    expect(wrapper.get('.app-shell').classes()).not.toContain('app-shell--calm');
    wrapper.unmount();
  });
});

describe('week calendar opening position', () => {
  it('opens at the first planned block, not at midnight', async () => {
    const wrapper = mount(WeekCalendar, {
      props: {
        timeZone: 'UTC',
        weekStart: '2026-11-09',
        blocks: [
          { taskId: 'task', startAt: '2026-11-10T19:00:00.000Z', endAt: '2026-11-10T20:00:00.000Z' },
          { taskId: 'task', startAt: '2026-11-11T09:30:00.000Z', endAt: '2026-11-11T10:00:00.000Z' },
        ],
      },
      attachTo: document.body,
    });
    await ticks();
    expect((wrapper.get('.week-calendar').element as HTMLElement).scrollTop).toBe(9 * 60 + 30 - 60);
    wrapper.unmount();
  });

  it('falls back to 07:00 when the week has no blocks or availability (negative)', async () => {
    const wrapper = mount(WeekCalendar, {
      props: { timeZone: 'UTC', weekStart: '2026-11-09', blocks: [] },
      attachTo: document.body,
    });
    await ticks();
    expect((wrapper.get('.week-calendar').element as HTMLElement).scrollTop).toBe(6 * 60);
    wrapper.unmount();
  });
});

describe('shell axe-lite', () => {
  it('names every control, keeps both primary navs labelled and labels the More sheet', async () => {
    const Stub = defineComponent({ template: '<div />' });
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: Stub },
        { path: '/inbox', name: 'inbox', component: Stub },
        { path: '/today', name: 'today', component: Stub },
        { path: '/:rest(.*)*', component: Stub },
      ],
    });
    await router.push('/today');
    await router.isReady();
    const wrapper = mount(AppShell, {
      global: { plugins: [createPinia(), router] },
      slots: { default: () => h('h1', 'Today') },
      attachTo: document.body,
    });
    await vi.waitFor(async () => {
      await flushPromises();
      expect(wrapper.find('.app-shell:not(.app-shell--loading)').exists()).toBe(true);
    });

    const navs = wrapper.findAll('nav');
    expect(navs.map((nav) => nav.attributes('aria-label'))).toEqual(['Primary', 'Primary']);
    expect(wrapper.find('main#main-content').exists()).toBe(true);

    const more = wrapper.findAll('button').find((item) => item.text() === 'More');
    if (more === undefined) throw new Error('missing More button');
    expect(more.attributes('aria-expanded')).toBe('false');
    await more.trigger('click');
    await nextTick();
    const sheet = wrapper.get('[role="dialog"][aria-labelledby="more-sheet-title"]');
    expect(sheet.attributes('aria-modal')).toBe('true');
    expect(more.attributes('aria-expanded')).toBe('true');

    for (const control of wrapper.findAll('button, a')) {
      const name = control.attributes('aria-label') ?? control.text().trim();
      expect(name.length).toBeGreaterThan(0);
    }
    for (const icon of wrapper.findAll('svg')) {
      expect(icon.attributes('aria-hidden')).toBe('true');
    }
    wrapper.unmount();
  });
});
