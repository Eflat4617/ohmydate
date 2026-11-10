import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { nextTick } from 'vue';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPlannerClient, newActionId, plannerClient, type Task } from '../src/api';
import TaskItem from '../src/components/TaskItem.vue';
import TaskList from '../src/components/TaskList.vue';
import InboxView from '../src/views/InboxView.vue';
import { INBOX_PROJECT_ID, SAMPLE_PROJECT_ID, mockDb } from '../src/mocks/db';
import { useOfflineStore } from '../src/stores/offline';

const API = 'http://localhost:3000/api/v1';

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

async function waitForText(wrapper: VueWrapper, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain(text);
  });
}

async function waitForMissingText(wrapper: VueWrapper, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.text()).not.toContain(text);
  });
}

async function createTask(title: string): Promise<Task> {
  return createPlannerClient().createTask({ title }, newActionId('create'));
}

describe('keep editing recovery', () => {
  it('returns to the editor with the exact draft and focus', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const task = await client.createTask({ title: 'Original title' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server title' }, newActionId('other'));

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [createPinia()] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local input to preserve');
    await wrapper.get('form').trigger('submit');
    await waitForText(wrapper, 'This task changed elsewhere');
    expect(wrapper.get('input').element).toHaveProperty('value', 'Local input to preserve');

    await button(wrapper, 'Keep editing').trigger('click');
    await waitForMissingText(wrapper, 'This task changed elsewhere');
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(wrapper.get('input').element);
    });

    const input = wrapper.get('input');
    expect(input.element).toHaveProperty('value', 'Local input to preserve');

    wrapper.unmount();
  });
});

describe('offline mutation enforcement', () => {
  it('does not send an open editor when the offline state changes', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Online title' }, newActionId('create'));
    const pinia = createPinia();
    const offline = useOfflineStore(pinia);

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Mutation sent offline');

    offline.setOnline(false);
    await settle();

    const input = wrapper.get('input');
    expect(input.attributes('disabled')).toBeDefined();
    await wrapper.get('form').trigger('submit');
    await settle();

    const fresh = await client.getTask(task.id, { fresh: true });
    expect(fresh.title).toBe('Online title');
    expect(wrapper.get('input').element).toHaveProperty('value', 'Mutation sent offline');

    wrapper.unmount();
  });

  it('disables conflict-dialog mutation buttons and rejects overwrite offline', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server title' }, newActionId('other'));
    const pinia = createPinia();
    const offline = useOfflineStore(pinia);

    const wrapper = mount(TaskList, {
      props: { tasks: [task] },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    await settle();

    await button(wrapper, 'Edit').trigger('click');
    await settle();
    await wrapper.get('input').setValue('Local overwrite');
    await wrapper.get('form').trigger('submit');
    await waitForText(wrapper, 'This task changed elsewhere');

    offline.setOnline(false);
    await settle();

    const overwrite = button(wrapper, 'Overwrite with my edit');
    await vi.waitFor(() => {
      expect(overwrite.attributes('disabled')).toBeDefined();
    });
    await overwrite.trigger('click');
    await settle();

    const fresh = await client.getTask(task.id, { fresh: true });
    expect(fresh.title).toBe('Server title');

    wrapper.unmount();
  });

  it('cancels a deferred delete when the connection drops', async () => {
    vi.useFakeTimers();
    try {
      const client = createPlannerClient();
      const task = await createTask('Deferred delete');
      const pinia = createPinia();
      const offline = useOfflineStore(pinia);

      const wrapper = mount(TaskList, {
        props: { tasks: [task] },
        global: { plugins: [pinia] },
        attachTo: document.body,
      });
      await settle();

      await button(wrapper, 'Delete').trigger('click');
      await settle();
      expect(wrapper.findAll('li.task-item')).toHaveLength(0);

      offline.setOnline(false);
      await vi.waitFor(() => {
        expect(wrapper.findAll('li.task-item')).toHaveLength(1);
      });

      await vi.advanceTimersByTimeAsync(7000);
      await settle();

      const fresh = await client.getTask(task.id, { fresh: true });
      expect(fresh.deletedAt).toBeUndefined();

      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pending UI', () => {
  it('disables an editor while its action is pending', () => {
    const task: Task = {
      id: '01900000-0000-7000-8000-0000000000ff',
      ownerId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001',
      title: 'Pending task',
      status: 'todo',
      splittable: true,
      priority: 2,
      dependsOn: [],
      version: 1,
      createdAt: '2026-11-01T09:00:00.000Z',
      updatedAt: '2026-11-01T09:00:00.000Z',
      external: [],
    };

    const wrapper = mount(TaskItem, {
      props: { task, editing: true, draft: 'Pending draft', pending: true },
    });

    expect(wrapper.get('input').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Save').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Cancel').attributes('disabled')).toBeDefined();
  });

  it('keeps recoverable input and disables quick add while creating', async () => {
    const pinia = createPinia();
    let resolveCreate: ((task: Task) => void) | undefined;
    const pending = new Promise<Task>((resolve) => {
      resolveCreate = resolve;
    });
    const spy = vi.spyOn(plannerClient, 'createTask').mockReturnValue(pending);

    const wrapper = mount(InboxView, {
      global: { plugins: [pinia, VueQueryPlugin] },
      attachTo: document.body,
    });
    await settle();

    const input = wrapper.get('#quick-add-title');
    await input.setValue('Keep this text');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();

    expect(wrapper.get('#quick-add-title').attributes('disabled')).toBeDefined();
    expect(button(wrapper, 'Add task').attributes('disabled')).toBeDefined();

    spy.mockRestore();
    resolveCreate?.({
      id: '01900000-0000-7000-8000-0000000000aa',
      ownerId: '01900000-0000-7000-8000-000000000002',
      projectId: '01900000-0000-7000-8000-000000000001',
      title: 'Keep this text',
      status: 'todo',
      splittable: true,
      priority: 2,
      dependsOn: [],
      version: 1,
      createdAt: '2026-11-01T09:00:00.000Z',
      updatedAt: '2026-11-01T09:00:00.000Z',
      external: [],
    });
    await settle();

    wrapper.unmount();
  });

  it('keeps quick-add text when creation fails', async () => {
    const pinia = createPinia();
    vi.spyOn(plannerClient, 'createTask').mockRejectedValue(new Error('network down'));

    const wrapper = mount(InboxView, {
      global: { plugins: [pinia, VueQueryPlugin] },
      attachTo: document.body,
    });
    await settle();

    await wrapper.get('#quick-add-title').setValue('Recover me');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();

    expect(wrapper.get('#quick-add-title').element).toHaveProperty('value', 'Recover me');
    expect(wrapper.text()).toContain('network down');

    wrapper.unmount();
  });

  it('uses a fresh key when the submission text changes after a failure', async () => {
    const pinia = createPinia();
    const keys: string[] = [];
    vi.spyOn(plannerClient, 'createTask').mockImplementation((_input, key) => {
      keys.push(key);
      return Promise.reject(new Error('network down'));
    });

    const wrapper = mount(InboxView, {
      global: { plugins: [pinia, VueQueryPlugin] },
      attachTo: document.body,
    });
    await settle();

    await wrapper.get('#quick-add-title').setValue('First submission');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();

    await wrapper.get('#quick-add-title').setValue('Changed submission');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();

    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);

    wrapper.unmount();
  });
});

describe('raw API helpers', () => {
  it('serves the mock API from the test origin', async () => {
    const response = await fetch(`${API}/me`);
    expect(response.status).toBe(200);
  });
});

describe('inbox scoping', () => {
  it('lists only tasks from the Inbox project', async () => {
    const client = createPlannerClient();
    await client.createTask({ title: 'Inbox item' }, newActionId('create-inbox'));
    await client.createTask(
      { title: 'Project item', projectId: SAMPLE_PROJECT_ID },
      newActionId('create-project'),
    );

    const wrapper = mount(InboxView, {
      global: { plugins: [createPinia(), VueQueryPlugin] },
      attachTo: document.body,
    });
    await waitForText(wrapper, 'Inbox item');

    expect(wrapper.text()).toContain('Inbox item');
    expect(wrapper.text()).not.toContain('Project item');

    wrapper.unmount();
  });

  it('finds an Inbox that appears after the first page of projects', async () => {
    const inbox = mockDb.projects.get(INBOX_PROJECT_ID);
    const sample = mockDb.projects.get(SAMPLE_PROJECT_ID);
    if (inbox === undefined || sample === undefined) throw new Error('missing seed project');
    const cursors: (string | undefined)[] = [];
    const listProjects = vi
      .spyOn(plannerClient, 'listProjects')
      .mockImplementation(async (options = {}) => {
        cursors.push(options.cursor);
        if (options.cursor === undefined) {
          return { items: [sample], nextCursor: 'page-2' };
        }
        return { items: [inbox], nextCursor: null };
      });
    const listTasks = vi
      .spyOn(plannerClient, 'listTasks')
      .mockResolvedValue({ items: [], nextCursor: null });

    const wrapper = mount(InboxView, {
      global: { plugins: [createPinia(), VueQueryPlugin] },
      attachTo: document.body,
    });

    await vi.waitFor(() => {
      expect(listTasks).toHaveBeenCalledWith({ projectId: INBOX_PROJECT_ID });
    });
    expect(cursors).toEqual([undefined, 'page-2']);
    expect(wrapper.text()).not.toContain('Inbox project is missing');

    listProjects.mockRestore();
    listTasks.mockRestore();
    wrapper.unmount();
  });

  it('shows an explicit error when no Inbox exists instead of listing unscoped tasks', async () => {
    const client = createPlannerClient();
    await client.createTask({ title: 'Unscoped-looking task' }, newActionId('create-inbox'));
    mockDb.projects.delete(INBOX_PROJECT_ID);

    const wrapper = mount(InboxView, {
      global: { plugins: [createPinia(), VueQueryPlugin] },
      attachTo: document.body,
    });
    await waitForText(wrapper, 'Inbox project is missing');

    expect(wrapper.text()).not.toContain('Unscoped-looking task');
    expect(wrapper.get('#quick-add-title').attributes('disabled')).toBeUndefined();

    await wrapper.get('#quick-add-title').setValue('Recovered capture');
    await wrapper.get('form.quick-add').trigger('submit');
    await waitForText(wrapper, 'Recovered capture');
    expect(wrapper.text()).not.toContain('Inbox project is missing');

    wrapper.unmount();
  });
});
