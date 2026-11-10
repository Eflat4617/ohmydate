import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ConflictDialog from '../src/components/ConflictDialog.vue';

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
});
