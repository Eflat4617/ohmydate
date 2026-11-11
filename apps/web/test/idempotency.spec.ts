import {
  ActionStore,
  ApiError,
  createPlannerClient,
  isUuidV7Key,
  newActionId,
  uuidV7Key,
} from '../src/api';
import { useTaskActions } from '../src/composables/useTaskActions';
import { mockDb } from '../src/mocks/db';

const API = 'http://localhost:3000/api/v1';

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

  it('rotates the key only when the If-Match changes', () => {
    const store = new ActionStore();
    const same = (left: { title: string }, right: { title: string }): boolean =>
      left.title === right.title;
    const first = store.begin('task:t1:rename', { title: 'Title' }, same, 2);
    const retry = store.begin('task:t1:rename', { title: 'Title' }, same, 2);
    expect(retry.key).toBe(first.key);

    const rotated = store.begin('task:t1:rename', { title: 'Title' }, same, 3);
    expect(rotated.key).not.toBe(first.key);
    expect(rotated.ifMatch).toBe(3);

    const withoutPrecondition = store.begin('task:t1:rename', { title: 'Title' }, same);
    expect(withoutPrecondition.key).toBe(rotated.key);
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
    expect(actions.error.value).toBe('서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');

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

describe('UUIDv7 idempotency keys', () => {
  it('mints UUIDv7 keys for actions and test helpers', () => {
    expect(isUuidV7Key(newActionId('task:create'))).toBe(true);
    expect(isUuidV7Key(uuidV7Key())).toBe(true);
    expect(uuidV7Key()).not.toBe(uuidV7Key());

    const store = new ActionStore();
    const action = store.begin('task:create:inbox', { title: 'Write abstract' }, sameTitle);
    expect(isUuidV7Key(action.key)).toBe(true);
  });
});

describe('mock idempotency storage rule (08 §1)', () => {
  it('does not store a 412 and allows a retry with the same key and a new If-Match', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const task = await client.createTask({ title: 'Original' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Server title' }, newActionId('other'));
    const key = newActionId('rename');

    await expect(
      client.updateTask(task.id, { title: 'Local title' }, key, task.version),
    ).rejects.toMatchObject({ status: 412, code: 'version_conflict' });
    expect(mockDb.idempotency.has(key)).toBe(false);

    const updated = await client.updateTask(task.id, { title: 'Local title' }, key, 2);
    expect(updated.title).toBe('Local title');
    expect(updated.version).toBe(3);
    expect(mockDb.idempotency.has(key)).toBe(true);
  });

  it('does not store 428 or 400 precondition/header failures', async () => {
    const task = await createPlannerClient().createTask(
      { title: 'Needs headers' },
      newActionId('create'),
    );
    const missingIfMatch = newActionId('missing-if-match');
    const response = await fetch(`${API}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': missingIfMatch,
      },
      body: JSON.stringify({ title: 'Changed' }),
    });
    expect(response.status).toBe(428);
    expect(mockDb.idempotency.has(missingIfMatch)).toBe(false);

    const badIfMatch = newActionId('bad-if-match');
    const bad = await fetch(`${API}/tasks/${task.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': badIfMatch,
        'If-Match': 'not-an-etag',
      },
      body: JSON.stringify({ title: 'Changed' }),
    });
    expect(bad.status).toBe(400);
    expect(mockDb.idempotency.has(badIfMatch)).toBe(false);
  });

  it('stores 409 domain results and replays them for the same key', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Finish me' }, newActionId('create'));
    const done = await client.completeTask(task.id, newActionId('complete-1'), task.version);
    const key = newActionId('complete-2');

    await expect(client.completeTask(task.id, key, done.version)).rejects.toMatchObject({
      status: 409,
    });
    expect(mockDb.idempotency.has(key)).toBe(true);

    await expect(client.completeTask(task.id, key, done.version)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('stores 422 domain results and replays them for the same key', async () => {
    const client = createPlannerClient();
    const key = newActionId('invalid-title');

    await expect(client.createTask({ title: '   ' }, key)).rejects.toMatchObject({ status: 422 });
    expect(mockDb.idempotency.has(key)).toBe(true);

    await expect(client.createTask({ title: '   ' }, key)).rejects.toMatchObject({ status: 422 });
  });
});

describe('mock problem codes for the expanded contract', () => {
  it('emits 409 idempotency_in_progress for a pending key', async () => {
    const client = createPlannerClient();
    const key = newActionId('pending');
    mockDb.pendingIdempotency.add(key);

    await expect(client.createTask({ title: 'Pending' }, key)).rejects.toMatchObject({
      status: 409,
      code: 'idempotency_in_progress',
    });
  });

  it('emits 401 unauthenticated when the mock session is missing', async () => {
    mockDb.authenticated = false;

    await expect(createPlannerClient().getMe()).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });
});
