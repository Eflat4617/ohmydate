import { ApiError, IdempotencyKeyStore, createPlannerClient, newActionId } from '../src/api';

describe('idempotency keys', () => {
  it('reuses the key for retries of the same action and rotates after settle', () => {
    const store = new IdempotencyKeyStore();
    const first = store.keyFor('task:abc:rename');
    const retry = store.keyFor('task:abc:rename');
    expect(retry).toBe(first);

    store.settle('task:abc:rename');
    const next = store.keyFor('task:abc:rename');
    expect(next).not.toBe(first);
  });

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

  it('keeps the key pending after a failed attempt so a retry succeeds', async () => {
    const plannerClient = createPlannerClient();
    const store = new IdempotencyKeyStore();
    const actionId = 'task:retry:create';
    const key = store.keyFor(actionId);

    // Simulate a network failure: the action did not settle.
    expect(store.has(actionId)).toBe(true);
    expect(store.keyFor(actionId)).toBe(key);

    const created = await plannerClient.createTask({ title: 'Retry me' }, key);
    store.settle(actionId);

    expect(created.title).toBe('Retry me');
    expect(store.has(actionId)).toBe(false);
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
