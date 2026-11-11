import type { ContextDocumentDto, Task as TaskDto } from '@ohmydate/contracts';
import type { Id } from '@ohmydate/domain';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

interface Users {
  readonly ctx: TestContext;
  readonly aliceId: Id;
  readonly bobId: Id;
  readonly alice: TestSession;
  readonly bob: TestSession;
}

async function setup(): Promise<Users> {
  const ctx = await createTestContext();
  const aliceId = await ctx.seedUser({ email: 'notes-a@example.com', password: 'correct-horse' });
  const bobId = await ctx.seedUser({ email: 'notes-b@example.com', password: 'correct-horse' });
  const alice = await login(ctx, 'notes-a@example.com', 'correct-horse');
  const bob = await login(ctx, 'notes-b@example.com', 'correct-horse');
  return { ctx, aliceId, bobId, alice, bob };
}

function create(ctx: TestContext, session: TestSession, payload: unknown, key = newIdempotencyKey()) {
  return ctx.app.inject({
    method: 'POST',
    url: '/api/v1/documents',
    headers: authHeaders(session, { 'idempotency-key': key }),
    payload: payload as Record<string, unknown>,
  });
}

function mutate(
  ctx: TestContext,
  session: TestSession,
  method: 'PATCH' | 'DELETE' | 'POST',
  url: string,
  version: number | null,
  payload?: unknown,
) {
  return ctx.app.inject({
    method,
    url,
    headers: authHeaders(session, {
      ...(version === null ? {} : { 'if-match': `W/"${version}"` }),
      'idempotency-key': newIdempotencyKey(),
    }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function get(ctx: TestContext, session: TestSession, url: string, headers: Record<string, string> = {}) {
  return ctx.app.inject({ method: 'GET', url, headers: authHeaders(session, headers) });
}

async function seedGoal(ctx: TestContext, ownerId: Id): Promise<Id> {
  const id = ctx.ids.next();
  await ctx.db.insertInto('goal').values({ id, owner_id: ownerId, title: 'Goal' }).execute();
  return id;
}

async function createTask(ctx: TestContext, session: TestSession, payload: Record<string, unknown>): Promise<TaskDto> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/v1/tasks',
    headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    payload,
  });
  expect(response.statusCode).toBe(201);
  return response.json() as TaskDto;
}

describe.skipIf(!hasDatabase)('notes (ContextDocument) API', () => {
  test('create/get/patch/delete with ETag, If-Match and raw Markdown', async () => {
    const { ctx, aliceId, alice } = await setup();
    try {
      const body = '# 메모\n\n<script>alert(1)</script> **raw** markdown';
      const created = await create(ctx, alice, { title: '논문 메모', bodyMd: body });
      expect(created.statusCode).toBe(201);
      expect(created.headers['content-type']).toMatch(/^application\/json/);
      const note = created.json() as ContextDocumentDto;
      expect(note).toMatchObject({
        ownerId: aliceId,
        title: '논문 메모',
        bodyMd: body,
        sensitivity: 'P2',
        llmAllowed: false,
        source: 'manual',
        links: [],
        version: 1,
      });
      expect(Object.keys(note)).not.toContain('bodyHtml');
      expect(created.headers.etag).toBe('W/"1"');

      const read = await get(ctx, alice, `/api/v1/documents/${note.id}`);
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(note);
      const notModified = await get(ctx, alice, `/api/v1/documents/${note.id}`, { 'if-none-match': 'W/"1"' });
      expect(notModified.statusCode).toBe(304);

      const missingIfMatch = await mutate(ctx, alice, 'PATCH', `/api/v1/documents/${note.id}`, null, { llmAllowed: true });
      expect(missingIfMatch.statusCode).toBe(428);
      const patched = await mutate(ctx, alice, 'PATCH', `/api/v1/documents/${note.id}`, 1, {
        llmAllowed: true,
        sensitivity: 'P1',
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ llmAllowed: true, sensitivity: 'P1', version: 2, bodyMd: body });
      expect(patched.headers.etag).toBe('W/"2"');
      const stale = await mutate(ctx, alice, 'PATCH', `/api/v1/documents/${note.id}`, 1, { title: 'x' });
      expect(stale.statusCode).toBe(412);
      expect(stale.json()).toMatchObject({ code: 'version_conflict' });

      const removed = await mutate(ctx, alice, 'DELETE', `/api/v1/documents/${note.id}`, 2);
      expect(removed.statusCode).toBe(204);
      expect((await get(ctx, alice, `/api/v1/documents/${note.id}`)).statusCode).toBe(404);
      const list = await get(ctx, alice, '/api/v1/documents');
      expect((list.json() as { items: unknown[] }).items).toEqual([]);
      const row = await ctx.db
        .selectFrom('context_document')
        .select(['deleted_at', 'version'])
        .where('id', '=', note.id as Id)
        .executeTakeFirstOrThrow();
      expect(row.deleted_at).not.toBeNull();
      expect(row.version).toBe(3);
    } finally {
      await ctx.close();
    }
  });

  test('create is idempotent and rejects a reused key with a different body', async () => {
    const { ctx, alice } = await setup();
    try {
      const key = newIdempotencyKey();
      const first = await create(ctx, alice, { title: 'Once' }, key);
      const replay = await create(ctx, alice, { title: 'Once' }, key);
      expect(replay.statusCode).toBe(201);
      expect((replay.json() as ContextDocumentDto).id).toBe((first.json() as ContextDocumentDto).id);
      const mismatch = await create(ctx, alice, { title: 'Twice' }, key);
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json()).toMatchObject({ code: 'idempotency_mismatch' });
      const count = await ctx.db.selectFrom('context_document').select(ctx.db.fn.countAll().as('n')).executeTakeFirst();
      expect(Number(count?.n)).toBe(1);
    } finally {
      await ctx.close();
    }
  });

  test('enforces title/body limits and rejects blank titles, NUL and empty patches', async () => {
    const { ctx, alice } = await setup();
    try {
      expect((await create(ctx, alice, { title: 'x'.repeat(201) })).statusCode).toBe(400);
      expect((await create(ctx, alice, { title: 'x', bodyMd: 'x'.repeat(65_537) })).statusCode).toBe(400);
      expect((await create(ctx, alice, { title: 'x', extra: true })).statusCode).toBe(400);
      const blank = await create(ctx, alice, { title: '   ' });
      expect(blank.statusCode).toBe(422);
      expect(blank.json()).toMatchObject({ code: 'validation_failed' });
      expect((await create(ctx, alice, { title: 'x', bodyMd: 'a\u0000b' })).statusCode).toBe(422);
      const big = await create(ctx, alice, { title: 'big', bodyMd: '가'.repeat(65_536) });
      expect(big.statusCode).toBe(201);
      const note = big.json() as ContextDocumentDto;
      expect((await mutate(ctx, alice, 'PATCH', `/api/v1/documents/${note.id}`, 1, {})).statusCode).toBe(400);
    } finally {
      await ctx.close();
    }
  });

  test('searches title and body with simple-config prefix terms, pages and validates cursors', async () => {
    const { ctx, alice } = await setup();
    try {
      for (const [title, bodyMd] of [
        ['논문 요약', '논문을 다섯 편 읽는다'],
        ['Paper summaries', 'read five papers'],
        ['장보기', '우유와 빵'],
      ] as const) {
        expect((await create(ctx, alice, { title, bodyMd })).statusCode).toBe(201);
      }
      const korean = await get(ctx, alice, `/api/v1/documents?q=${encodeURIComponent('논문')}`);
      expect((korean.json() as { items: ContextDocumentDto[] }).items.map((item) => item.title)).toEqual(['논문 요약']);
      const english = await get(ctx, alice, '/api/v1/documents?q=PAPER%20five');
      expect((english.json() as { items: ContextDocumentDto[] }).items.map((item) => item.title)).toEqual([
        'Paper summaries',
      ]);
      const operators = await get(ctx, alice, `/api/v1/documents?q=${encodeURIComponent("!&|:*()'")}`);
      expect(operators.statusCode).toBe(200);
      expect((operators.json() as { items: unknown[] }).items).toEqual([]);

      const first = await get(ctx, alice, '/api/v1/documents?limit=2');
      const firstPage = first.json() as { items: ContextDocumentDto[]; nextCursor: string | null };
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.nextCursor).not.toBeNull();
      const second = await get(ctx, alice, `/api/v1/documents?limit=2&cursor=${firstPage.nextCursor}`);
      const secondPage = second.json() as { items: ContextDocumentDto[]; nextCursor: string | null };
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeNull();
      const seen = new Set([...firstPage.items, ...secondPage.items].map((item) => item.id));
      expect(seen.size).toBe(3);

      expect((await get(ctx, alice, '/api/v1/documents?cursor=bogus')).statusCode).toBe(422);
      expect((await get(ctx, alice, '/api/v1/documents?targetKind=task')).statusCode).toBe(422);
    } finally {
      await ctx.close();
    }
  });

  test('links goals, projects and tasks of the owner only; duplicates and unknown targets fail', async () => {
    const { ctx, aliceId, bobId, alice, bob } = await setup();
    try {
      const goalId = await seedGoal(ctx, aliceId);
      const bobGoal = await seedGoal(ctx, bobId);
      const project = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/projects',
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: 'Thesis' },
      });
      const projectId = (project.json() as { id: string }).id;
      const task = await createTask(ctx, alice, { title: 'Read papers' });
      const bobTask = await createTask(ctx, bob, { title: 'Bob task' });

      const created = await create(ctx, alice, {
        title: 'Linked',
        links: [{ targetKind: 'goal', targetId: goalId }],
      });
      expect(created.statusCode).toBe(201);
      let note = created.json() as ContextDocumentDto;
      expect(note.links.map((link) => link.targetKind)).toEqual(['goal']);

      for (const [targetKind, targetId] of [
        ['project', projectId],
        ['task', task.id],
      ] as const) {
        const added = await mutate(ctx, alice, 'POST', `/api/v1/documents/${note.id}/links`, note.version, {
          targetKind,
          targetId,
        });
        expect(added.statusCode).toBe(201);
        note = added.json() as ContextDocumentDto;
      }
      expect(note.version).toBe(3);
      expect(note.links.map((link) => link.targetKind)).toEqual(['goal', 'project', 'task']);

      const duplicate = await mutate(ctx, alice, 'POST', `/api/v1/documents/${note.id}/links`, note.version, {
        targetKind: 'task',
        targetId: task.id,
      });
      expect(duplicate.statusCode).toBe(422);
      for (const [targetKind, targetId] of [
        ['task', bobTask.id],
        ['goal', bobGoal],
        ['task', ctx.ids.next()],
        ['project', ctx.ids.next()],
      ] as const) {
        const foreign = await mutate(ctx, alice, 'POST', `/api/v1/documents/${note.id}/links`, note.version, {
          targetKind,
          targetId,
        });
        expect({ targetKind, status: foreign.statusCode }).toEqual({ targetKind, status: 404 });
      }
      expect(
        (await create(ctx, alice, { title: 'x', links: [{ targetKind: 'task', targetId: bobTask.id }] })).statusCode,
      ).toBe(404);
      expect(
        (await mutate(ctx, alice, 'POST', `/api/v1/documents/${note.id}/links`, 1, { targetKind: 'goal', targetId: goalId }))
          .statusCode,
      ).toBe(412);

      const byTask = await get(ctx, alice, `/api/v1/documents?targetKind=task&targetId=${task.id}`);
      expect((byTask.json() as { items: ContextDocumentDto[] }).items.map((item) => item.id)).toEqual([note.id]);

      const taskLink = note.links.find((link) => link.targetKind === 'task');
      const unlinked = await mutate(
        ctx,
        alice,
        'DELETE',
        `/api/v1/documents/${note.id}/links/${taskLink?.id}`,
        note.version,
      );
      expect(unlinked.statusCode).toBe(200);
      note = unlinked.json() as ContextDocumentDto;
      expect(note.links.map((link) => link.targetKind)).toEqual(['goal', 'project']);
      const missingLink = await mutate(
        ctx,
        alice,
        'DELETE',
        `/api/v1/documents/${note.id}/links/${ctx.ids.next()}`,
        note.version,
      );
      expect(missingLink.statusCode).toBe(404);
      const afterUnlink = await get(ctx, alice, `/api/v1/documents?targetKind=task&targetId=${task.id}`);
      expect((afterUnlink.json() as { items: unknown[] }).items).toEqual([]);
    } finally {
      await ctx.close();
    }
  });

  test('another owner can never read, change, link, search or list a note', async () => {
    const { ctx, alice, bob, bobId } = await setup();
    try {
      const note = (await create(ctx, alice, { title: 'Alice private', bodyMd: 'alice secret plan' })).json() as ContextDocumentDto;
      const url = `/api/v1/documents/${note.id}`;
      expect((await get(ctx, bob, url)).statusCode).toBe(404);
      expect((await get(ctx, bob, `${url}/ai-usage`)).statusCode).toBe(404);
      expect((await mutate(ctx, bob, 'PATCH', url, 1, { title: 'pwned' })).statusCode).toBe(404);
      expect((await mutate(ctx, bob, 'DELETE', url, 1)).statusCode).toBe(404);
      const bobGoal = await seedGoal(ctx, bobId);
      expect(
        (await mutate(ctx, bob, 'POST', `${url}/links`, 1, { targetKind: 'goal', targetId: bobGoal })).statusCode,
      ).toBe(404);
      const search = await get(ctx, bob, '/api/v1/documents?q=secret');
      expect((search.json() as { items: unknown[] }).items).toEqual([]);
      expect(((await get(ctx, bob, '/api/v1/documents')).json() as { items: unknown[] }).items).toEqual([]);
      const unchanged = (await get(ctx, alice, url)).json() as ContextDocumentDto;
      expect(unchanged).toMatchObject({ title: 'Alice private', version: 1, links: [] });
    } finally {
      await ctx.close();
    }
  });

  test('promotes the current task description once, as tag-free Markdown linked to the task', async () => {
    const { ctx, alice, bob } = await setup();
    try {
      const task = await createTask(ctx, alice, {
        title: 'Literature review',
        description: '<h2>목표</h2><p>논문 <b>5편</b> 요약</p><ul><li>하나</li><li>둘</li></ul><script>x()</script>',
      });
      const url = `/api/v1/tasks/${task.id}:promote-description`;
      expect((await mutate(ctx, alice, 'POST', url, task.version + 1)).statusCode).toBe(412);
      expect((await mutate(ctx, alice, 'POST', url, null)).statusCode).toBe(428);
      expect((await mutate(ctx, bob, 'POST', url, task.version)).statusCode).toBe(404);

      const promoted = await mutate(ctx, alice, 'POST', url, task.version);
      expect(promoted.statusCode).toBe(201);
      const note = promoted.json() as ContextDocumentDto;
      expect(note).toMatchObject({
        title: 'Literature review',
        bodyMd: '## 목표\n\n논문 5편 요약\n\n- 하나\n- 둘',
        source: 'task_description',
        sourceTaskId: task.id,
        llmAllowed: false,
      });
      expect(note.bodyMd).not.toContain('<');
      expect(note.links).toEqual([expect.objectContaining({ targetKind: 'task', targetId: task.id })]);

      const again = await mutate(ctx, alice, 'POST', url, task.version);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'illegal_transition' });

      // No sync: editing the task later does not change the note.
      const edited = await ctx.app.inject({
        method: 'PATCH',
        url: `/api/v1/tasks/${task.id}`,
        headers: authHeaders(alice, { 'if-match': `W/"${task.version}"`, 'idempotency-key': newIdempotencyKey() }),
        payload: { description: 'changed later' },
      });
      expect(edited.statusCode).toBe(200);
      expect(((await get(ctx, alice, `/api/v1/documents/${note.id}`)).json() as ContextDocumentDto).bodyMd).toBe(
        note.bodyMd,
      );

      // Deleting the copy allows promoting the (new) description again.
      expect((await mutate(ctx, alice, 'DELETE', `/api/v1/documents/${note.id}`, note.version)).statusCode).toBe(204);
      const editedTask = edited.json() as TaskDto;
      const second = await mutate(ctx, alice, 'POST', url, editedTask.version);
      expect(second.statusCode).toBe(201);
      expect((second.json() as ContextDocumentDto).bodyMd).toBe('changed later');

      const empty = await createTask(ctx, alice, { title: 'No description' });
      const none = await mutate(ctx, alice, 'POST', `/api/v1/tasks/${empty.id}:promote-description`, empty.version);
      expect(none.statusCode).toBe(422);
    } finally {
      await ctx.close();
    }
  });
});
