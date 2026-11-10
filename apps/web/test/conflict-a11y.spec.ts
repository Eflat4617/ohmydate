import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h, nextTick } from 'vue';
import AppShell from '../src/components/AppShell.vue';
import TaskList from '../src/components/TaskList.vue';
import { createPlannerClient, newActionId, plannerClient, type Task } from '../src/api';
import { useToastStore } from '../src/stores/toast';

const Stub = defineComponent({ template: '<div />' });

function testRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/today', name: 'today', component: Stub },
      { path: '/projects', name: 'projects', component: Stub },
    ],
  });
}

function button(wrapper: VueWrapper, label: string) {
  const found = wrapper.findAll('button').find((item) => item.text().includes(label));
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function settle(): Promise<void> {
  await flushPromises();
  await nextTick();
  await nextTick();
}

async function conflictedTask(): Promise<Task> {
  const client = createPlannerClient();
  const otherDevice = createPlannerClient();
  const task = await client.createTask({ title: 'Original title' }, newActionId('create'));
  await otherDevice.updateTask(task.id, { title: 'Server title' }, newActionId('other'));
  return task;
}

describe('conflict dialog accessibility', () => {
  it('suppresses global shortcuts, keeps the draft, and makes the editor inert', async () => {
    const task = await conflictedTask();
    const router = testRouter();
    await router.push('/inbox');
    await router.isReady();
    const pinia = createPinia();

    const wrapper = mount(AppShell, {
      global: { plugins: [pinia, router] },
      slots: { default: () => h(TaskList, { tasks: [task] }) },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('My unsaved draft');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    const input = wrapper.get('input');
    expect(input.attributes('disabled')).toBeDefined();

    const reload = button(wrapper, 'Reload server version');
    reload.element.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    await settle();

    expect(router.currentRoute.value.name).toBe('inbox');
    expect(wrapper.text()).toContain('This task changed elsewhere');
    expect(wrapper.get('input').element).toHaveProperty('value', 'My unsaved draft');

    wrapper.unmount();
  });

  it('overwrites with the draft typed after Keep editing (real path)', async () => {
    const task = await conflictedTask();
    const pinia = createPinia();

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local input to preserve');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    await button(wrapper, 'Keep editing').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('This task changed elsewhere');
    });

    await wrapper.get('input').setValue('Newer draft typed after keep editing');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    await button(wrapper, 'Overwrite with my edit').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('This task changed elsewhere');
    });

    const fresh = await plannerClient.getTask(task.id, { fresh: true });
    expect(fresh.title).toBe('Newer draft typed after keep editing');

    wrapper.unmount();
  });

  it('reuses the key when a re-save keeps the same If-Match', async () => {
    const task = await conflictedTask();
    const keys: string[] = [];
    const spy = vi
      .spyOn(plannerClient, 'updateTask')
      .mockImplementation((taskId, patch, key, version) => {
        keys.push(key);
        return createPlannerClient().updateTask(taskId, patch, key, version);
      });
    const pinia = createPinia();

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local input to preserve');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    await button(wrapper, 'Keep editing').trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('This task changed elsewhere');
    });

    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(keys).toHaveLength(2);
    });

    expect(keys[0]).toBe(keys[1]);
    spy.mockRestore();
    wrapper.unmount();
  });

  it('sends only one overwrite request for a double click', async () => {
    const task = await conflictedTask();
    const realUpdate = plannerClient.updateTask.bind(plannerClient);
    let patchCalls = 0;
    const spy = vi
      .spyOn(plannerClient, 'updateTask')
      .mockImplementation(async (taskId, patch, key, version) => {
        patchCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return realUpdate(taskId, patch, key, version);
      });
    const pinia = createPinia();

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local input to preserve');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    patchCalls = 0;
    const overwrite = button(wrapper, 'Overwrite with my edit');
    await overwrite.trigger('click');
    await overwrite.trigger('click');
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('This task changed elsewhere');
    });

    expect(patchCalls).toBe(1);
    spy.mockRestore();
    wrapper.unmount();
  });

  it('surfaces a reload failure as a toast', async () => {
    const task = await conflictedTask();
    const pinia = createPinia();
    const toast = useToastStore(pinia);

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local draft');
    await wrapper.get('form').trigger('submit');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('This task changed elsewhere');
    });

    vi.spyOn(plannerClient, 'getTask').mockRejectedValue(new Error('network down'));
    await button(wrapper, 'Reload server version').trigger('click');
    await vi.waitFor(() => {
      expect(toast.toasts.map((item) => item.message)).toContain(
        'Could not reload the server version. Please try again.',
      );
    });

    wrapper.unmount();
  });
});
