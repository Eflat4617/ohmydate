import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

describe.skipIf(!hasDatabase)('projects and tasks', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let bob: TestSession;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.seedUser({ email: 'alice@example.com', password: 'correct-horse' });
    await ctx.seedUser({ email: 'bob@example.com', password: 'correct-horse' });
    alice = await login(ctx, 'alice@example.com', 'correct-horse');
    bob = await login(ctx, 'bob@example.com', 'correct-horse');
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function createProject(session: TestSession, title: string) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/projects',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { id: string; version: number };
  }

  async function createTask(session: TestSession, payload: Record<string, unknown>) {
    return ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload,
    });
  }

  test('creates a project and a task with ETag W/"1"', async () => {
    const project = await createProject(alice, 'Work');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Write report', projectId: project.id },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers['etag']).toBe('W/"1"');
    const task = created.json() as { id: string; projectId: string; version: number };
    expect(task.projectId).toBe(project.id);

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers['etag']).toBe('W/"1"');
    expect(fetched.json()).toMatchObject({ id: task.id, title: 'Write report' });

    const notModified = await ctx.app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, { 'if-none-match': 'W/"1"' }),
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.headers['etag']).toBe('W/"1"');
  });

  test('updates with matching If-Match and rejects stale or missing preconditions', async () => {
    const created = await createTask(alice, { title: 'Update me' });
    expect(created.statusCode).toBe(201);
    const task = created.json();

    const missingIfMatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'nope' },
    });
    expect(missingIfMatch.statusCode).toBe(428);

    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'Updated title', priority: 4 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ title: 'Updated title', priority: 4, version: 2 });

    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'stale' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ code: 'version_conflict' });

    const missingKey = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, { 'if-match': 'W/"2"' }),
      payload: { title: 'no key' },
    });
    expect(missingKey.statusCode).toBe(400);
  });

  test('completes and soft-deletes a task', async () => {
    const created = await createTask(alice, { title: 'Finish me' });
    const task = created.json();

    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'done', version: 2 });

    const deleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await ctx.app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice),
    });
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ code: 'not_found' });
  });

  test('adds a dependency through the sub-resource endpoint', async () => {
    const first = (await createTask(alice, { title: 'Dependency A' })).json();
    const second = (await createTask(alice, { title: 'Dependency B' })).json();

    const dependency = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/dependencies`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { dependsOnTaskId: second.id },
    });
    expect(dependency.statusCode).toBe(201);
    expect(dependency.json()).toEqual({ taskId: first.id, dependsOnTaskId: second.id });
    expect(dependency.headers['etag']).toBe('W/"2"');

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/tasks/${first.id}`,
      headers: authHeaders(alice),
    });
    expect(fetched.json()).toMatchObject({ dependsOn: [second.id] });
  });

  test('lists tasks by project and status', async () => {
    const project = await createProject(alice, 'List project');
    const listA = (await createTask(alice, { title: 'Todo one', projectId: project.id })).json();
    const listB = (await createTask(alice, { title: 'Todo two', projectId: project.id })).json();
    await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${listA.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });

    const todo = await ctx.app.inject({
      method: 'GET',
      url: `/tasks?projectId=${project.id}&status=todo`,
      headers: authHeaders(alice),
    });
    expect(todo.statusCode).toBe(200);
    const items = (todo.json() as { items: { id: string }[] }).items;
    expect(items.map((item) => item.id)).toEqual([listB.id]);
  });

  test('owner isolation returns 404 for another owner`s resources', async () => {
    const alicesTask = (await createTask(alice, { title: 'Private' })).json();

    const fetch = await ctx.app.inject({
      method: 'GET',
      url: `/tasks/${alicesTask.id}`,
      headers: authHeaders(bob),
    });
    expect(fetch.statusCode).toBe(404);

    const update = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${alicesTask.id}`,
      headers: authHeaders(bob, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'hijack' },
    });
    expect(update.statusCode).toBe(404);

    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/tasks/${alicesTask.id}`,
      headers: authHeaders(bob, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(remove.statusCode).toBe(404);
  });

  test('create POSTs reject missing Idempotency-Key with 400', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice),
      payload: { title: 'No key' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'validation_failed' });
  });
});
