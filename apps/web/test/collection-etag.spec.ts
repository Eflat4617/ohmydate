import { createPlannerClient, newActionId } from '../src/api';

const API = 'http://localhost:3000/api/v1';

async function get(path: string, etag?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (etag !== undefined) headers['If-None-Match'] = etag;
  return fetch(`${API}${path}`, { headers });
}

async function etagOf(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status).toBe(200);
  const etag = response.headers.get('ETag');
  expect(etag).toBeTruthy();
  return etag as string;
}

describe('collection ETags', () => {
  it('revalidates after create, update, and delete', async () => {
    const client = createPlannerClient();
    const before = await etagOf('/tasks');
    expect((await get('/tasks', before)).status).toBe(304);

    const task = await client.createTask({ title: 'ETag create' }, newActionId('create'));
    const afterCreate = await get('/tasks', before);
    expect(afterCreate.status).toBe(200);
    const createEtag = afterCreate.headers.get('ETag') as string;
    expect(createEtag).not.toBe(before);

    const updated = await client.updateTask(
      task.id,
      { title: 'ETag update' },
      newActionId('update'),
      task.version,
    );
    const afterUpdate = await get('/tasks', createEtag);
    expect(afterUpdate.status).toBe(200);
    const updateEtag = afterUpdate.headers.get('ETag') as string;
    expect(updateEtag).not.toBe(createEtag);

    await client.deleteTask(task.id, newActionId('delete'), updated.version);
    const afterDelete = await get('/tasks', updateEtag);
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.headers.get('ETag')).not.toBe(updateEtag);
  });

  it('includes the query representation in the validator', async () => {
    const all = await etagOf('/tasks');
    const todo = await etagOf('/tasks?status=todo');
    const done = await etagOf('/tasks?status=done');

    expect(todo).not.toBe(all);
    expect(done).not.toBe(todo);
    expect((await get('/tasks?status=done', todo)).status).toBe(200);
    expect((await get('/tasks?status=done', done)).status).toBe(304);
  });

  it('revalidates the project collection after a create', async () => {
    const client = createPlannerClient();
    const before = await etagOf('/projects');
    expect((await get('/projects', before)).status).toBe(304);

    await client.createProject('ETag project', newActionId('project:create'));

    const after = await get('/projects', before);
    expect(after.status).toBe(200);
    expect(after.headers.get('ETag')).not.toBe(before);
  });
});
