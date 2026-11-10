import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ConflictDialog from '../src/components/ConflictDialog.vue';

function buttonByText(wrapper: ReturnType<typeof mount>, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

describe('ConflictDialog', () => {
  it('shows the server version, labels every control, and focuses Reload', async () => {
    const wrapper = mount(ConflictDialog, {
      props: {
        serverVersion: 7,
        serverTitle: 'Server title',
        localTitle: 'Local title',
      },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-labelledby')).toBe('conflict-title');
    expect(dialog.attributes('aria-describedby')).toBe('conflict-detail');
    expect(wrapper.text()).toContain('version 7');
    expect(wrapper.text()).toContain('Server title');
    expect(wrapper.text()).toContain('Local title');

    const buttons = wrapper.findAll('button');
    expect(buttons.map((button) => button.text())).toEqual([
      'Reload server version',
      'Overwrite with my edit',
      'Keep editing',
    ]);
    expect(document.activeElement).toBe(buttons[0]?.element);

    wrapper.unmount();
  });

  it('labels complete and delete recovery and disables overwrite while offline', () => {
    const complete = mount(ConflictDialog, {
      props: {
        serverVersion: 2,
        serverTitle: 'Server',
        operation: 'complete',
        disabled: true,
      },
    });
    expect(complete.text()).toContain('Complete anyway');
    expect(complete.text()).toContain('Mark as complete');
    expect(buttonByText(complete, 'Complete anyway').attributes('disabled')).toBeDefined();

    const remove = mount(ConflictDialog, {
      props: { serverVersion: 3, serverTitle: 'Server', operation: 'delete' },
    });
    expect(remove.text()).toContain('Delete anyway');
    expect(remove.text()).toContain('Delete this task');
  });

  it('emits reload, overwrite, and cancel without mutating anything itself', async () => {
    const wrapper = mount(ConflictDialog, {
      props: { serverVersion: 2, serverTitle: 'Server', localTitle: 'Local' },
    });

    await wrapper.get('button').trigger('click');
    const [, overwrite, cancel] = wrapper.findAll('button');
    await overwrite?.trigger('click');
    await cancel?.trigger('click');

    expect(wrapper.emitted('reload')).toHaveLength(1);
    expect(wrapper.emitted('overwrite')).toHaveLength(1);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    const wrapper = mount(ConflictDialog, {
      props: { serverVersion: 2, serverTitle: 'Server', localTitle: 'Local' },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const buttons = wrapper.findAll('button');
    const first = buttons[0]?.element as HTMLElement;
    const last = buttons[buttons.length - 1]?.element as HTMLElement;
    const dialog = wrapper.get('[role="dialog"]');

    last.focus();
    await dialog.trigger('keydown', { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    await dialog.trigger('keydown', { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);

    wrapper.unmount();
  });

  it('reclaims focus that escapes the dialog', async () => {
    const wrapper = mount(ConflictDialog, {
      props: { serverVersion: 2, serverTitle: 'Server', localTitle: 'Local' },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const outside = document.createElement('button');
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();

    expect(document.activeElement).toBe(wrapper.findAll('button')[0]?.element);

    outside.remove();
    wrapper.unmount();
  });

  it('treats Escape as Keep editing and stops it reaching global shortcuts', async () => {
    const wrapper = mount(ConflictDialog, {
      props: { serverVersion: 2, serverTitle: 'Server', localTitle: 'Local' },
      attachTo: document.body,
    });
    await nextTick();
    await nextTick();

    const dialog = wrapper.get('[role="dialog"]');
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.element.dispatchEvent(event);
    await nextTick();

    expect(event.defaultPrevented).toBe(true);
    expect(wrapper.emitted('cancel')).toHaveLength(1);
    wrapper.unmount();
  });
});
