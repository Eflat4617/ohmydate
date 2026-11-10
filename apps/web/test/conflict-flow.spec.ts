import { HttpResponse, http } from 'msw';
import { ActionStore, createPlannerClient, newActionId } from '../src/api';
import { useTaskActions } from '../src/composables/useTaskActions';
import { server } from '../src/mocks/server';

describe('version-conflict flow', () => {
  it('keeps the local edit, reports the server version, and overwrites on request', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const store = new ActionStore();
    const actions = useTaskActions(client, store);

    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Changed elsewhere' }, newActionId('other'));

    const outcome = await actions.rename(task, 'My local edit');

    expect(outcome).toBeNull();
    expect(actions.conflict.value?.operation).toBe('rename');
    expect(actions.conflict.value?.server.version).toBe(2);
    expect(actions.conflict.value?.server.title).toBe('Changed elsewhere');
    expect(actions.conflict.value?.localTitle).toBe('My local edit');
    expect(store.has(`task:${task.id}:rename`)).toBe(true);

    const overwritten = await actions.overwrite();

    expect(overwritten?.title).toBe('My local edit');
    expect(overwritten?.version).toBe(3);
    expect(actions.conflict.value).toBeNull();
    expect(store.has(`task:${task.id}:rename`)).toBe(false);
  });

  it('re-fetches before overwrite so a newer server version is not rejected', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const actions = useTaskActions(client, new ActionStore());

    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server v2' }, newActionId('other'));
    expect(await actions.rename(task, 'Local draft')).toBeNull();
    expect(actions.conflict.value?.server.version).toBe(2);

    await otherDevice.updateTask(task.id, { title: 'Server v3' }, newActionId('other-2'), 2);

    const overwritten = await actions.overwrite();
    expect(overwritten?.title).toBe('Local draft');
    expect(overwritten?.version).toBe(4);
    expect(actions.conflict.value).toBeNull();
  });

  it('refreshes the dialog when overwrite races with another 412', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const actions = useTaskActions(client, new ActionStore());

    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server v2' }, newActionId('other'));
    expect(await actions.rename(task, 'Local draft')).toBeNull();

    await otherDevice.updateTask(task.id, { title: 'Server v3' }, newActionId('other-2'), 2);

    server.use(
      http.patch('*/api/v1/tasks/:id', () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Version precondition failed',
            status: 412,
            code: 'version_conflict',
            detail: 'forced race',
          },
          { status: 412, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );

    expect(await actions.overwrite()).toBeNull();
    expect(actions.conflict.value?.server.version).toBe(3);
    expect(actions.conflict.value?.localTitle).toBe('Local draft');

    server.resetHandlers();

    const overwritten = await actions.overwrite();
    expect(overwritten?.title).toBe('Local draft');
    expect(overwritten?.version).toBe(4);
    expect(actions.conflict.value).toBeNull();
  });

  it('can reload the server version and abandon the local edit', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const store = new ActionStore();
    const actions = useTaskActions(client, store);

    const task = await client.createTask({ title: 'Before' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server wins' }, newActionId('other'));

    expect(await actions.rename(task, 'Local loses')).toBeNull();
    const reloaded = await actions.reload();

    expect(reloaded?.title).toBe('Server wins');
    expect(actions.conflict.value).toBeNull();
    expect(store.has(`task:${task.id}:rename`)).toBe(false);

    const fresh = await client.getTask(task.id, { fresh: true });
    expect(fresh.title).toBe('Server wins');
  });

  it('offers the same recovery for a stale complete', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const actions = useTaskActions(client, new ActionStore());

    const task = await client.createTask({ title: 'Finish me' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Renamed elsewhere' }, newActionId('other'));

    expect(await actions.complete(task)).toBeNull();
    expect(actions.conflict.value?.operation).toBe('complete');
    expect(actions.conflict.value?.server.version).toBe(2);

    const completed = await actions.overwrite();
    expect(completed?.status).toBe('done');
    expect(completed?.version).toBe(3);
    expect(actions.conflict.value).toBeNull();
  });

  it('offers the same recovery for a stale delete', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const actions = useTaskActions(client, new ActionStore());

    const task = await client.createTask({ title: 'Remove me' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Changed elsewhere' }, newActionId('other'));

    expect(await actions.remove(task)).toBe(false);
    expect(actions.conflict.value?.operation).toBe('delete');
    expect(actions.conflict.value?.server.version).toBe(2);

    expect(await actions.overwrite()).toBeNull();
    expect(actions.conflict.value).toBeNull();
    await expect(client.getTask(task.id, { fresh: true })).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('idempotency key rotation across If-Match changes', () => {
  it('mints a fresh key when overwrite changes If-Match', async () => {
    const keys: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    const client = createPlannerClient({
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? input : new Request(String(input), init);
        if (request.method === 'PATCH') {
          const key = request.headers.get('Idempotency-Key');
          if (key !== null) keys.push(key);
        }
        return realFetch(input as RequestInfo, init);
      },
    });
    const otherDevice = createPlannerClient();
    const store = new ActionStore();
    const actions = useTaskActions(client, store);

    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server title' }, newActionId('other'));

    expect(await actions.rename(task, 'Local title')).toBeNull();
    expect(actions.conflict.value?.server.version).toBe(2);

    const overwritten = await actions.overwrite();
    expect(overwritten?.title).toBe('Local title');
    expect(overwritten?.version).toBe(3);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
