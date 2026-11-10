import { createPlannerClient, newActionId } from '../src/api';

describe('task completion handler', () => {
  it('parses the literal :complete suffix and completes the task', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Complete me' }, newActionId('create'));

    const done = await client.completeTask(task.id, newActionId('complete'), task.version);

    expect(done.id).toBe(task.id);
    expect(done.status).toBe('done');
    expect(done.version).toBe(task.version + 1);
  });

  it('returns 412 for a stale completion attempt', async () => {
    const client = createPlannerClient();
    const otherDevice = createPlannerClient();
    const task = await client.createTask({ title: 'Stale complete' }, newActionId('create'));
    await otherDevice.updateTask(task.id, { title: 'Moved on' }, newActionId('update'));

    await expect(
      client.completeTask(task.id, newActionId('complete'), task.version),
    ).rejects.toMatchObject({ status: 412, code: 'version_conflict' });
  });

  it('returns 409 when the task is already completed', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Already done' }, newActionId('create'));
    const done = await client.completeTask(task.id, newActionId('complete'), task.version);

    await expect(
      client.completeTask(task.id, newActionId('complete-again'), done.version),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('replays a completion for the same idempotency key even with a stale version', async () => {
    const client = createPlannerClient();
    const task = await client.createTask({ title: 'Replay complete' }, newActionId('create'));
    const key = newActionId('complete');
    const done = await client.completeTask(task.id, key, task.version);

    const replay = await client.completeTask(task.id, key, task.version);

    expect(replay.id).toBe(done.id);
    expect(replay.status).toBe('done');
    expect(replay.version).toBe(done.version);
    const page = await client.listTasks();
    expect(page.items.filter((item) => item.id === task.id)).toHaveLength(1);
  });
});
