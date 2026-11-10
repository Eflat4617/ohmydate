import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

interface OutboxRow {
  readonly topic: string;
  readonly payload: { taskId: string; version: number };
}

describe.skipIf(!hasDatabase)('outbox events', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let aliceId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    aliceId = await ctx.seedUser({ email: 'alice@example.com', password: 'correct-horse' });
    alice = await login(ctx, 'alice@example.com', 'correct-horse');
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function outboxFor(ownerId: string): Promise<OutboxRow[]> {
    return ctx.db
      .selectFrom('outbox_event')
      .select(['topic', 'payload'])
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute() as unknown as Promise<OutboxRow[]>;
  }

  test('create, update, complete and delete emit task events with id+version', async () => {
    const key = newIdempotencyKey();
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': key }),
      payload: { title: 'Outbox lifecycle' },
    });
    expect(create.statusCode).toBe(201);
    const task = create.json() as { id: string; version: number };

    const update = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'Outbox lifecycle v2' },
    });
    expect(update.statusCode).toBe(200);

    const complete = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(complete.statusCode).toBe(200);

    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"3"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(remove.statusCode).toBe(204);

    const rows = await outboxFor(aliceId);
    expect(rows.map((row) => row.topic)).toEqual([
      'task.created',
      'task.updated',
      'task.completed',
      'task.deleted',
    ]);
    expect(rows.map((row) => row.payload.version)).toEqual([1, 2, 3, 4]);
    expect(rows.every((row) => row.payload.taskId === task.id)).toBe(true);

    const completedKeys = await ctx.db
      .selectFrom('idempotency_record')
      .select(['status'])
      .where('owner_id', '=', aliceId)
      .execute();
    expect(completedKeys.filter((row) => row.status === 'completed').length).toBeGreaterThanOrEqual(4);
  });

  test('completing an already done task does not emit a duplicate completed event', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Already done' },
    });
    const task = create.json() as { id: string };

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ status: 'done', version: 2 });

    const completedRows = async () =>
      (await outboxFor(aliceId)).filter(
        (row) => row.topic === 'task.completed' && row.payload.taskId === task.id,
      );
    expect((await completedRows()).length).toBe(1);

    const second = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${task.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ status: 'done', version: 2 });
    expect((await completedRows()).length).toBe(1);
  });

  test('a mutation that fails does not write outbox rows for that attempt', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'No outbox on failure' },
    });
    const task = create.json() as { id: string };
    const before = (await outboxFor(aliceId)).length;

    const failed = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"99"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'should fail' },
    });
    expect(failed.statusCode).toBe(412);

    const after = (await outboxFor(aliceId)).length;
    expect(after).toBe(before);
  });
});
