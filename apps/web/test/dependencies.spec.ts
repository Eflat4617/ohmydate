import { createPlannerClient, newActionId, type Task } from '../src/api';

const API = 'http://localhost:3000/api/v1';

async function addDependency(task: Task, dependsOnTaskId: string): Promise<Response> {
  return fetch(`${API}/tasks/${task.id}/dependencies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': `W/"${task.version}"`,
      'Idempotency-Key': newActionId('dependency:create'),
    },
    body: JSON.stringify({ dependsOnTaskId }),
  });
}

async function patchDependencies(task: Task, dependsOn: string[]): Promise<Response> {
  return fetch(`${API}/tasks/${task.id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': `W/"${task.version}"`,
      'Idempotency-Key': newActionId('dependency:patch'),
    },
    body: JSON.stringify({ dependsOn }),
  });
}

async function current(client: ReturnType<typeof createPlannerClient>, id: string): Promise<Task> {
  return client.getTask(id, { fresh: true });
}

describe('dependency mock semantics', () => {
  it('rejects self dependencies with dependency_cycle', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Self dep' }, newActionId('create'));

    const response = await addDependency(task, task.id);
    expect(response.status).toBe(422);
    const problem = (await response.json()) as { code: string };
    expect(problem.code).toBe('dependency_cycle');
  });

  it('rejects transitive cycles and accepts acyclic edges', async () => {
    const client = createPlannerClient();
    const a = await client.createTask({ title: 'A' }, newActionId('create'));
    const b = await client.createTask({ title: 'B' }, newActionId('create'));
    const c = await client.createTask({ title: 'C' }, newActionId('create'));

    expect((await addDependency(a, b.id)).status).toBe(201);
    const aAfter = await current(client, a.id);
    expect(aAfter.dependsOn).toContain(b.id);

    expect((await addDependency(b, c.id)).status).toBe(201);

    const cFresh = await current(client, c.id);
    const cycle = await addDependency(cFresh, a.id);
    expect(cycle.status).toBe(422);
    expect(((await cycle.json()) as { code: string }).code).toBe('dependency_cycle');
  });

  it('validates dependency patches consistently', async () => {
    const client = createPlannerClient();
    const a = await client.createTask({ title: 'Patch A' }, newActionId('create'));
    const b = await client.createTask({ title: 'Patch B' }, newActionId('create'));
    const c = await client.createTask({ title: 'Patch C' }, newActionId('create'));

    expect((await addDependency(a, b.id)).status).toBe(201);
    expect((await addDependency(b, c.id)).status).toBe(201);

    const aFresh = await current(client, a.id);
    const selfPatch = await patchDependencies(aFresh, [aFresh.id]);
    expect(selfPatch.status).toBe(422);
    expect(((await selfPatch.json()) as { code: string }).code).toBe('dependency_cycle');

    const cFresh = await current(client, c.id);
    const cyclePatch = await patchDependencies(cFresh, [aFresh.id]);
    expect(cyclePatch.status).toBe(422);
    expect(((await cyclePatch.json()) as { code: string }).code).toBe('dependency_cycle');

    const missingPatch = await patchDependencies(aFresh, ['01900000-0000-7000-8000-00000000dead']);
    expect(missingPatch.status).toBe(422);
    expect(((await missingPatch.json()) as { code: string }).code).toBe('validation_failed');

    const validPatch = await patchDependencies(aFresh, []);
    expect(validPatch.status).toBe(200);
  });
});
