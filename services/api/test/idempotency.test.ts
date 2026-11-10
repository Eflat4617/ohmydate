import { canonicalJson, sha256Hex } from '../src/application/canonical.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

describe.skipIf(!hasDatabase)('idempotency middleware', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let aliceId: string;
  let bob: TestSession;

  beforeAll(async () => {
    ctx = await createTestContext();
    aliceId = await ctx.seedUser({ email: 'alice@example.com', password: 'correct-horse' });
    await ctx.seedUser({ email: 'bob@example.com', password: 'correct-horse' });
    alice = await login(ctx, 'alice@example.com', 'correct-horse');
    bob = await login(ctx, 'bob@example.com', 'correct-horse');
  });

  afterAll(async () => {
    await ctx.close();
  });

  async function listTitles(session: TestSession, title: string): Promise<number> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/tasks?limit=100',
      headers: authHeaders(session),
    });
    const body = response.json() as { items: { title: string }[] };
    return body.items.filter((item) => item.title === title).length;
  }

  test('replays an identical request without double-creating', async () => {
    const key = newIdempotencyKey();
    const payload = { title: 'Replay me' };
    const headers = authHeaders(alice, { 'idempotency-key': key });

    const first = await ctx.app.inject({ method: 'POST', url: '/tasks', headers, payload });
    const replay = await ctx.app.inject({ method: 'POST', url: '/tasks', headers, payload });

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['etag']).toBe(first.headers['etag']);
    expect(await listTitles(alice, 'Replay me')).toBe(1);

    const outbox = await ctx.db
      .selectFrom('outbox_event')
      .select(['topic'])
      .where('owner_id', '=', aliceId)
      .execute();
    expect(outbox.filter((row) => row.topic === 'task.created').length).toBeGreaterThanOrEqual(1);

    const record = await ctx.db
      .selectFrom('idempotency_record')
      .selectAll()
      .where('owner_id', '=', aliceId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    expect(record.status).toBe('completed');
  });

  test('reusing a key with a different body returns 422 idempotency_mismatch', async () => {
    const key = newIdempotencyKey();
    const headers = authHeaders(alice, { 'idempotency-key': key });
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'Original body' },
    });
    expect(first.statusCode).toBe(201);

    const mismatch = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers,
      payload: { title: 'Different body' },
    });
    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.headers['content-type']).toContain('application/problem+json');
    expect(mismatch.json()).toMatchObject({ code: 'idempotency_mismatch' });
  });

  test('a pending key returns 409 without executing', async () => {
    const key = newIdempotencyKey();
    const payload = { title: 'Pending body' };
    const hash = sha256Hex(
      canonicalJson({ method: 'POST', path: '/tasks', body: payload }),
    );
    await ctx.db
      .insertInto('idempotency_record')
      .values({
        id: ctx.ids.next(),
        owner_id: aliceId,
        key,
        route: '/tasks',
        request_hash: hash,
        status: 'pending',
        expires_at: new Date(Date.parse(ctx.clock.now()) + 60 * 60 * 1000),
      })
      .execute();

    const response = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': key }),
      payload,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'idempotency_in_progress' });
    expect(response.headers['retry-after']).toBe('1');
    expect(await listTitles(alice, 'Pending body')).toBe(0);
  });

  test('concurrent requests with the same key: one create, rest 409/replay, no 5xx', async () => {
    // Pre-warm the pool so the race is not serialized by connection creation.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        ctx.db.selectFrom('user').select('id').limit(1).execute(),
      ),
    );

    let sawInProgress = false;
    const rounds = 10;
    for (let round = 0; round < rounds && !sawInProgress; round += 1) {
      const key = newIdempotencyKey();
      const title = `Concurrent body ${round}`;
      const payload = { title };
      const makeRequest = () =>
        ctx.app.inject({
          method: 'POST',
          url: '/tasks',
          headers: authHeaders(alice, { 'idempotency-key': key }),
          payload,
        });

      const responses = await Promise.all(Array.from({ length: 6 }, () => makeRequest()));
      const statuses = responses.map((response) => response.statusCode);
      expect(statuses.every((status) => status === 201 || status === 409)).toBe(true);
      expect(statuses.filter((status) => status === 201).length).toBeGreaterThanOrEqual(1);
      const conflicts = responses.filter((entry) => entry.statusCode === 409);
      if (conflicts.length > 0) sawInProgress = true;
      for (const response of conflicts) {
        expect((response.json() as { code: string }).code).toBe('idempotency_in_progress');
        expect(response.headers['retry-after']).toBe('1');
      }
      const created = responses.filter((entry) => entry.statusCode === 201);
      const ids = new Set(created.map((entry) => (entry.json() as { id: string }).id));
      expect(ids.size).toBe(1);
      expect(await listTitles(alice, title)).toBe(1);
    }

    expect(sawInProgress).toBe(true);
  });

  test('idempotency keys are scoped per owner', async () => {
    const key = newIdempotencyKey();
    const payload = { title: 'Owner scoped key' };

    const first = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': key }),
      payload,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(bob, { 'idempotency-key': key }),
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((first.json() as { id: string }).id).not.toBe((second.json() as { id: string }).id);
  });

  test('a stored 422 is replayed even after the domain state changes', async () => {
    const createTask = async (title: string) => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/tasks',
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title },
      });
      expect(response.statusCode).toBe(201);
      return response.json() as { id: string };
    };
    const first = await createTask('Cycle A');
    const second = await createTask('Cycle B');

    const depends = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${second.id}/dependencies`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { dependsOnTaskId: first.id },
    });
    expect(depends.statusCode).toBe(201);

    const key = newIdempotencyKey();
    const cycleBody = { dependsOnTaskId: second.id };
    const cycle = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/dependencies`,
      headers: authHeaders(alice, { 'if-match': 'W/"1"', 'idempotency-key': key }),
      payload: cycleBody,
    });
    expect(cycle.statusCode).toBe(422);
    expect(cycle.json()).toMatchObject({ code: 'dependency_cycle' });

    const stored = await ctx.db
      .selectFrom('idempotency_record')
      .selectAll()
      .where('owner_id', '=', aliceId)
      .where('key', '=', key)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe('completed');

    // Remove the reverse edge so the same request would now succeed.
    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${second.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"2"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { dependsOn: [] },
    });
    expect(cleared.statusCode).toBe(200);

    const beforeOutbox = await ctx.db
      .selectFrom('outbox_event')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('owner_id', '=', aliceId)
      .executeTakeFirstOrThrow();

    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/tasks/${first.id}/dependencies`,
      headers: authHeaders(alice, { 'if-match': 'W/"1"', 'idempotency-key': key }),
      payload: cycleBody,
    });
    expect(replay.statusCode).toBe(422);
    expect(replay.headers['content-type']).toContain('application/problem+json');
    expect(replay.json()).toEqual(cycle.json());

    const afterOutbox = await ctx.db
      .selectFrom('outbox_event')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('owner_id', '=', aliceId)
      .executeTakeFirstOrThrow();
    expect(Number(afterOutbox.count)).toBe(Number(beforeOutbox.count));
  });

  test('a failed mutation releases the key so a corrected retry can run', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'Retry after conflict' },
    });
    const task = created.json() as { id: string };
    const bump = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
      payload: { title: 'Retry after conflict v2' },
    });
    expect(bump.statusCode).toBe(200);

    const key = newIdempotencyKey();
    const body = { title: 'retry body' };
    const stale = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, { 'if-match': 'W/"1"', 'idempotency-key': key }),
      payload: body,
    });
    expect(stale.statusCode).toBe(412);

    const retry = await ctx.app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(alice, { 'if-match': 'W/"2"', 'idempotency-key': key }),
      payload: body,
    });
    expect(retry.statusCode).toBe(200);
  });
});
