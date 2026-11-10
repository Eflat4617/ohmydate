import { IdempotencyKeyStore, createPlannerClient, newActionId } from '../src/api';
import { useTaskActions } from '../src/composables/useTaskActions';

describe('version-conflict flow', () => {
  it('keeps the local edit, reports the server version, and overwrites on request', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const keys = new IdempotencyKeyStore();
    const actions = useTaskActions(client, keys);

    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Changed elsewhere' }, newActionId('other'));

    const outcome = await actions.rename(task, 'My local edit');

    expect(outcome).toBeNull();
    expect(actions.conflict.value?.server.version).toBe(2);
    expect(actions.conflict.value?.server.title).toBe('Changed elsewhere');
    expect(actions.conflict.value?.localTitle).toBe('My local edit');
    expect(keys.has(`task:${task.id}:rename`)).toBe(true);

    const overwritten = await actions.overwrite();

    expect(overwritten?.title).toBe('My local edit');
    expect(overwritten?.version).toBe(3);
    expect(actions.conflict.value).toBeNull();
    expect(keys.has(`task:${task.id}:rename`)).toBe(false);
  });

  it('can reload the server version and abandon the local edit', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const keys = new IdempotencyKeyStore();
    const actions = useTaskActions(client, keys);

    const task = await client.createTask({ title: 'Before' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server wins' }, newActionId('other'));

    expect(await actions.rename(task, 'Local loses')).toBeNull();
    const reloaded = await actions.reload();

    expect(reloaded?.title).toBe('Server wins');
    expect(actions.conflict.value).toBeNull();
    expect(keys.has(`task:${task.id}:rename`)).toBe(false);

    const fresh = await client.getTask(task.id, { fresh: true });
    expect(fresh.title).toBe('Server wins');
  });
});
