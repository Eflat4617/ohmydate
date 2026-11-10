import { ActionStore, ApiError, createPlannerClient, newActionId } from '../src/api';
import { useTaskActions } from '../src/composables/useTaskActions';

const sameTitle = (left: { title: string }, right: { title: string }): boolean =>
  left.title === right.title;

describe('idempotent action model', () => {
  it('reuses the same key for the same immutable payload and rotates on change', () => {
    const store = new ActionStore();
    const first = store.begin('task:create:inbox', { title: 'Write abstract' }, sameTitle);
    const retry = store.begin('task:create:inbox', { title: 'Write abstract' }, sameTitle);
    expect(retry.key).toBe(first.key);

    const changed = store.begin('task:create:inbox', { title: 'Write summary' }, sameTitle);
    expect(changed.key).not.toBe(first.key);
    expect(store.peek('task:create:inbox')?.key).toBe(changed.key);

    store.settle('task:create:inbox', changed);
    expect(store.has('task:create:inbox')).toBe(false);
    const later = store.begin('task:create:inbox', { title: 'Write summary' }, sameTitle);
    expect(later.key).not.toBe(changed.key);
  });
});

describe('idempotency keys', () => {
  it('generates unique action ids', () => {
    expect(newActionId('task:create')).not.toBe(newActionId('task:create'));
  });

  it('replays the stored response for the same key and body', async () => {
    const plannerClient = createPlannerClient();
    const key = newActionId('task:create');
    const first = await plannerClient.createTask({ title: 'Write abstract' }, key);
    const retry = await plannerClient.createTask({ title: 'Write abstract' }, key);

    expect(retry.id).toBe(first.id);
    const page = await plannerClient.listTasks();
    expect(page.items.filter((task) => task.title === 'Write abstract')).toHaveLength(1);
  });

  it('rejects the same key with a different body', async () => {
    const plannerClient = createPlannerClient();
    const key = newActionId('task:create');
    await plannerClient.createTask({ title: 'First body' }, key);

    await expect(plannerClient.createTask({ title: 'Different body' }, key)).rejects.toMatchObject({
      status: 422,
      code: 'idempotency_mismatch',
    });
  });
});

describe('retry after a real response loss', () => {
  it('reuses the action key and replays instead of creating a duplicate', async () => {
    let calls = 0;
    const realFetch = globalThis.fetch.bind(globalThis);
    const client = createPlannerClient({
      fetch: async (input, init) => {
        const response = await realFetch(input as RequestInfo, init);
        calls += 1;
        if (calls === 1) {
          await response.clone().text();
          throw new TypeError('socket closed before the response arrived');
        }
        return response;
      },
    });
    const actions = useTaskActions(client, new ActionStore());

    await expect(actions.create('Survive retry')).rejects.toThrow('socket closed');
    expect(actions.error.value).toContain('socket closed');

    const created = await actions.create('Survive retry');
    expect(created.title).toBe('Survive retry');

    const page = await client.listTasks();
    expect(page.items.filter((task) => task.title === 'Survive retry')).toHaveLength(1);
  });

  it('allocates a fresh key when the user changes the input', async () => {
    let calls = 0;
    const realFetch = globalThis.fetch.bind(globalThis);
    const client = createPlannerClient({
      fetch: async (input, init) => {
        const response = await realFetch(input as RequestInfo, init);
        calls += 1;
        if (calls === 1) {
          await response.clone().text();
          throw new TypeError('socket closed before the response arrived');
        }
        return response;
      },
    });
    const actions = useTaskActions(client, new ActionStore());

    await expect(actions.create('Original submission')).rejects.toThrow('socket closed');
    const created = await actions.create('Changed submission');

    expect(created.title).toBe('Changed submission');
    const page = await client.listTasks();
    expect(page.items.filter((task) => task.title === 'Original submission')).toHaveLength(1);
    expect(page.items.filter((task) => task.title === 'Changed submission')).toHaveLength(1);
  });
});

describe('idempotency error typing', () => {
  it('surfaces idempotency_mismatch as an ApiError', async () => {
    const plannerClient = createPlannerClient();
    const key = newActionId('task:create');
    await plannerClient.createTask({ title: 'One' }, key);
    const failure = plannerClient.createTask({ title: 'Two' }, key);

    await expect(failure).rejects.toBeInstanceOf(ApiError);
  });
});
