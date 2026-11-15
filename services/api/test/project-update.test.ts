/**
 * FOLD-01: `PATCH /projects/{id}` (`updateProject`) — rename and archive a
 * folder. The rules the route promises, each with its negative case.
 */
import { ProblemSchema, ProjectSchema, routes } from '@ohmydate/contracts';
import type { Id } from '@ohmydate/domain';
import { vi } from 'vitest';
import { compile } from './support/schemas.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

interface ProjectBody {
  readonly id: string;
  readonly ownerId: string;
  readonly title: string;
  readonly kind: 'inbox' | 'normal';
  readonly archived: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface TaskBody {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: string;
  readonly version: number;
  readonly updatedAt: string;
}

interface ProblemBody {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

const UNKNOWN_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const validProject = compile(ProjectSchema);
const validProblem = compile(ProblemSchema);

describe.skipIf(!hasDatabase)('updateProject: rename and archive a folder', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let bob: TestSession;
  let aliceId: Id;

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

  async function createProject(session: TestSession, title: string): Promise<ProjectBody> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as ProjectBody;
  }

  async function createTask(
    session: TestSession,
    payload: Record<string, unknown>,
  ): Promise<TaskBody> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
      payload,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as TaskBody;
  }

  function patch(
    session: TestSession,
    id: string,
    payload: unknown,
    headers: Record<string, string> = {},
  ) {
    return ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${id}`,
      headers: authHeaders(session, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
        ...headers,
      }),
      payload: payload as Record<string, unknown>,
    });
  }

  async function listProjects(session: TestSession): Promise<ProjectBody[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/projects?limit=100',
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: ProjectBody[] }).items;
  }

  async function projectOf(session: TestSession, id: string): Promise<ProjectBody | undefined> {
    return (await listProjects(session)).find((project) => project.id === id);
  }

  async function tasksOf(session: TestSession, projectId: string): Promise<TaskBody[]> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/tasks?projectId=${projectId}&limit=100`,
      headers: authHeaders(session),
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as { items: TaskBody[] }).items;
  }

  async function inboxOf(session: TestSession): Promise<ProjectBody> {
    const inboxes = (await listProjects(session)).filter((project) => project.kind === 'inbox');
    expect(inboxes).toHaveLength(1);
    return inboxes[0] as ProjectBody;
  }

  function expectProblem(
    response: { statusCode: number; headers: Record<string, unknown>; body: string },
    status: number,
    code: string,
  ): ProblemBody {
    expect(response.statusCode).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(response.body) as ProblemBody;
    expect(validProblem(body)).toBe(true);
    expect(body).toMatchObject({ status, code });
    // Every status this route answers with is one the contract declares.
    const declared = Object.keys(
      routes.find((route) => route.operationId === 'updateProject')?.responses ?? {},
    ).map(Number);
    expect(declared).toContain(status);
    return body;
  }

  test('renames a project: 200, the new version as ETag, a contract-valid body', async () => {
    const project = await createProject(alice, 'Thesiss');
    ctx.clock.advance(1_000);

    const response = await patch(alice, project.id, { title: 'Thesis' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['etag']).toBe('W/"2"');
    const renamed = response.json() as ProjectBody;
    expect(validProject(renamed)).toBe(true);
    expect(renamed).toEqual({
      ...project,
      title: 'Thesis',
      version: 2,
      updatedAt: renamed.updatedAt,
    });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(project.updatedAt));
    expect(await projectOf(alice, project.id)).toEqual(renamed);
  });

  test('archives a project and brings it back; its tasks are not touched', async () => {
    const project = await createProject(alice, 'Old course');
    const open = await createTask(alice, { title: 'still open', projectId: project.id });
    const finished = await createTask(alice, { title: 'finished', projectId: project.id });
    const completed = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${finished.id}:complete`,
      headers: authHeaders(alice, {
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(completed.statusCode).toBe(200);
    const before = await tasksOf(alice, project.id);
    expect(before.map((task) => task.id).sort()).toEqual([open.id, finished.id].sort());
    ctx.clock.advance(1_000);

    const archived = await patch(alice, project.id, { archived: true });
    expect(archived.statusCode).toBe(200);
    expect(archived.headers['etag']).toBe('W/"2"');
    expect(archived.json()).toMatchObject({
      id: project.id,
      title: 'Old course',
      kind: 'normal',
      archived: true,
      version: 2,
    });
    // The server neither deletes nor moves nor re-versions the tasks.
    expect(await tasksOf(alice, project.id)).toEqual(before);

    const back = await patch(alice, project.id, { archived: false }, { 'if-match': 'W/"2"' });
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ archived: false, version: 3 });
    expect(await tasksOf(alice, project.id)).toEqual(before);
  });

  test("another owner's project is 404, exactly like an id that names nothing", async () => {
    const project = await createProject(alice, 'Private thesis title');

    const foreign = await patch(bob, project.id, { title: 'Taken over', archived: true });
    const foreignBody = expectProblem(foreign, 404, 'not_found');
    const unknown = await patch(bob, UNKNOWN_ID, { title: 'Taken over', archived: true });
    const unknownBody = expectProblem(unknown, 404, 'not_found');

    // Not 403, and nothing in the answer tells the two cases apart.
    expect(foreignBody.title).toBe(unknownBody.title);
    expect(foreignBody.detail).toBe(unknownBody.detail?.replace(UNKNOWN_ID, project.id));
    expect(foreign.body).not.toContain('Private thesis title');
    expect(foreign.body).not.toContain(aliceId);
    expect(foreign.headers['etag']).toBeUndefined();

    // A foreign caller learns nothing from the version either: any If-Match is 404.
    const guessed = await patch(bob, project.id, { title: 'x' }, { 'if-match': 'W/"7"' });
    expectProblem(guessed, 404, 'not_found');
    const emptyProbe = await patch(bob, project.id, {});
    expectProblem(emptyProbe, 404, 'not_found');

    expect(await projectOf(alice, project.id)).toEqual(project);
    expect(await projectOf(bob, project.id)).toBeUndefined();
  });

  test('a stale If-Match is 412 and changes nothing; the key stays usable', async () => {
    const project = await createProject(alice, 'Versioned');
    const first = await patch(alice, project.id, { title: 'Versioned 2' });
    expect(first.statusCode).toBe(200);
    const current = first.json() as ProjectBody;

    const key = newIdempotencyKey();
    const stale = await patch(
      alice,
      project.id,
      { title: 'Lost update', archived: true },
      { 'if-match': 'W/"1"', 'idempotency-key': key },
    );
    expectProblem(stale, 412, 'version_conflict');
    expect(await projectOf(alice, project.id)).toEqual(current);

    const ahead = await patch(alice, project.id, { title: 'Lost update' }, { 'if-match': 'W/"9"' });
    expectProblem(ahead, 412, 'version_conflict');
    expect(await projectOf(alice, project.id)).toEqual(current);

    // 08 §1: a 412 is not stored, so the same key retries with the right version.
    const retried = await patch(
      alice,
      project.id,
      { title: 'Lost update', archived: true },
      { 'if-match': 'W/"2"', 'idempotency-key': key },
    );
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ title: 'Lost update', archived: true, version: 3 });
  });

  test('If-Match, Idempotency-Key, the session and the CSRF token are all required', async () => {
    const project = await createProject(alice, 'Guarded');
    const url = `/api/v1/projects/${project.id}`;
    const payload = { title: 'Changed' };

    const noIfMatch = await ctx.app.inject({
      method: 'PATCH',
      url,
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload,
    });
    expectProblem(noIfMatch, 428, 'version_conflict');

    for (const malformed of ['1', '"1"', 'W/"0"', '*', 'W/"availability:1"']) {
      const response = await patch(alice, project.id, payload, { 'if-match': malformed });
      expectProblem(response, 400, 'validation_failed');
    }

    const noKey = await ctx.app.inject({
      method: 'PATCH',
      url,
      headers: authHeaders(alice, { 'if-match': 'W/"1"' }),
      payload,
    });
    expectProblem(noKey, 400, 'validation_failed');
    const badKey = await patch(alice, project.id, payload, { 'idempotency-key': 'not-a-uuid' });
    expectProblem(badKey, 400, 'validation_failed');

    const noCsrf = await ctx.app.inject({
      method: 'PATCH',
      url,
      headers: {
        cookie: alice.cookie,
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      },
      payload,
    });
    expectProblem(noCsrf, 403, 'forbidden');
    const foreignCsrf = await ctx.app.inject({
      method: 'PATCH',
      url,
      headers: {
        cookie: alice.cookie,
        'x-csrf-token': bob.csrf,
        'if-match': 'W/"1"',
        'idempotency-key': newIdempotencyKey(),
      },
      payload,
    });
    expectProblem(foreignCsrf, 403, 'forbidden');

    const anonymous = await ctx.app.inject({
      method: 'PATCH',
      url,
      headers: { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() },
      payload,
    });
    expectProblem(anonymous, 401, 'unauthenticated');

    const malformedId = await patch(alice, 'not-a-uuid', payload);
    expectProblem(malformedId, 400, 'validation_failed');
    const unknownId = await patch(alice, UNKNOWN_ID, payload);
    expectProblem(unknownId, 404, 'not_found');

    // None of the refused requests changed the project.
    expect(await projectOf(alice, project.id)).toEqual(project);
  });

  test('a replayed Idempotency-Key returns the first answer and writes once', async () => {
    const project = await createProject(alice, 'Replayed');
    const update = vi.spyOn(ctx.repos.projects, 'update');
    try {
      const headers = { 'idempotency-key': newIdempotencyKey() };
      const first = await patch(alice, project.id, { title: 'Replayed once' }, headers);
      expect(first.statusCode).toBe(200);

      // The replay still carries the old If-Match: the stored answer wins.
      const replay = await patch(alice, project.id, { title: 'Replayed once' }, headers);
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['etag']).toBe(first.headers['etag']);
      expect(replay.headers['etag']).toBe('W/"2"');

      expect(update).toHaveBeenCalledTimes(1);
      expect(await projectOf(alice, project.id)).toMatchObject({
        title: 'Replayed once',
        version: 2,
      });

      // The same key with another body is refused and writes nothing.
      const other = await patch(alice, project.id, { title: 'Something else' }, headers);
      expectProblem(other, 422, 'idempotency_mismatch');
      const otherField = await patch(alice, project.id, { archived: true }, headers);
      expectProblem(otherField, 422, 'idempotency_mismatch');
      expect(update).toHaveBeenCalledTimes(1);
      expect(await projectOf(alice, project.id)).toMatchObject({
        title: 'Replayed once',
        archived: false,
        version: 2,
      });
    } finally {
      update.mockRestore();
    }
  });

  test('the Inbox can never be archived: 422 validation_failed, stored for its key', async () => {
    const inbox = await inboxOf(alice);
    const headers = {
      'if-match': `W/"${inbox.version}"`,
      'idempotency-key': newIdempotencyKey(),
    };

    const refused = await patch(alice, inbox.id, { archived: true }, headers);
    const problem = expectProblem(refused, 422, 'validation_failed');
    expect(problem.errors).toEqual([
      { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
    ]);
    // 08 §1: a 422 domain result is stored and replayed for the same key.
    const replay = await patch(alice, inbox.id, { archived: true }, headers);
    expect(replay.statusCode).toBe(422);
    expect(replay.json()).toEqual(refused.json());

    // Not even together with a rename: the whole patch is refused.
    const withTitle = await patch(
      alice,
      inbox.id,
      { title: 'Gone', archived: true },
      { 'if-match': `W/"${inbox.version}"` },
    );
    expectProblem(withTitle, 422, 'validation_failed');
    expect(await inboxOf(alice)).toEqual(inbox);

    // archived: false is what the Inbox already is, so it is accepted.
    const stays = await patch(
      alice,
      inbox.id,
      { archived: false },
      { 'if-match': `W/"${inbox.version}"` },
    );
    expect(stays.statusCode).toBe(200);
    expect(stays.json()).toMatchObject({ kind: 'inbox', archived: false });
  });

  test('the Inbox can be renamed and stays the one Inbox', async () => {
    const inbox = await inboxOf(bob);

    const renamed = await patch(
      bob,
      inbox.id,
      { title: '바깥' },
      { 'if-match': `W/"${inbox.version}"` },
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({
      id: inbox.id,
      title: '바깥',
      kind: 'inbox',
      archived: false,
      version: inbox.version + 1,
    });
    expect((await inboxOf(bob)).id).toBe(inbox.id);

    // It is found by kind, not by title: new tasks without a project still land in it.
    const task = await createTask(bob, { title: 'lands outside' });
    expect(task.projectId).toBe(inbox.id);

    // Renamed or not, it is still the Inbox and still cannot be archived.
    const refused = await patch(
      bob,
      inbox.id,
      { archived: true },
      { 'if-match': `W/"${inbox.version + 1}"` },
    );
    expectProblem(refused, 422, 'validation_failed');
  });

  test('an empty patch is a no-op: 200 with the current project, nothing written', async () => {
    const project = await createProject(alice, 'Untouched');
    const update = vi.spyOn(ctx.repos.projects, 'update');
    try {
      ctx.clock.advance(1_000);
      const response = await patch(alice, project.id, {});
      expect(response.statusCode).toBe(200);
      expect(response.headers['etag']).toBe('W/"1"');
      expect(response.json()).toEqual(project);
      expect(update).not.toHaveBeenCalled();
      expect(await projectOf(alice, project.id)).toEqual(project);

      // It is still a conditional request on a project of the caller.
      const stale = await patch(alice, project.id, {}, { 'if-match': 'W/"2"' });
      expectProblem(stale, 412, 'version_conflict');
      const unknown = await patch(alice, UNKNOWN_ID, {});
      expectProblem(unknown, 404, 'not_found');
      expect(update).not.toHaveBeenCalled();
    } finally {
      update.mockRestore();
    }

    // The version did not move: the next real change still matches W/"1".
    const next = await patch(alice, project.id, { title: 'Touched' });
    expect(next.statusCode).toBe(200);
    expect(next.json()).toMatchObject({ title: 'Touched', version: 2 });
  });

  test('the title is validated as on create, and a refused patch changes nothing', async () => {
    const project = await createProject(alice, 'Validated');

    // Outside the contract schema: 400 with field errors.
    for (const body of [
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: null },
      { title: 7 },
      { archived: 'yes' },
      { archived: null },
      { kind: 'inbox' },
      { title: 'ok', version: 9 },
      { unexpectedField: true },
    ]) {
      const response = await patch(alice, project.id, body);
      const problem = expectProblem(response, 400, 'validation_failed');
      expect(problem.errors?.length ?? 0).toBeGreaterThan(0);
    }

    // Inside the schema but blank: the same 422 createProject answers.
    const createBlank = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '   ' },
    });
    const patchBlank = await patch(alice, project.id, { title: '   ', archived: true });
    const blank = expectProblem(patchBlank, 422, 'validation_failed');
    expect(blank.errors).toEqual([{ path: 'title', message: 'title must not be empty' }]);
    expect(createBlank.statusCode).toBe(422);
    expect((createBlank.json() as ProblemBody).errors).toEqual(blank.errors);

    // A 200-character title is accepted, as on create.
    expect(await projectOf(alice, project.id)).toEqual(project);
    const longest = await patch(alice, project.id, { title: '가'.repeat(200) });
    expect(longest.statusCode).toBe(200);
    expect((longest.json() as ProjectBody).title).toBe('가'.repeat(200));
  });

  test('an archived project is renamed only together with bringing it back', async () => {
    const project = await createProject(alice, 'Shelved');
    const archived = await patch(alice, project.id, { archived: true });
    expect(archived.statusCode).toBe(200);
    const shelved = archived.json() as ProjectBody;

    const refused = await patch(alice, project.id, { title: 'Renamed' }, { 'if-match': 'W/"2"' });
    const problem = expectProblem(refused, 422, 'validation_failed');
    expect(problem.errors).toEqual([
      { path: 'title', message: 'an archived project cannot be renamed; bring it back first' },
    ]);
    const stillArchived = await patch(
      alice,
      project.id,
      { title: 'Renamed', archived: true },
      { 'if-match': 'W/"2"' },
    );
    expectProblem(stillArchived, 422, 'validation_failed');
    expect(await projectOf(alice, project.id)).toEqual(shelved);

    const back = await patch(
      alice,
      project.id,
      { title: 'Renamed', archived: false },
      { 'if-match': 'W/"2"' },
    );
    expect(back.statusCode).toBe(200);
    expect(back.json()).toMatchObject({ title: 'Renamed', archived: false, version: 3 });
  });

  test('like createProject it writes no outbox event', async () => {
    const outboxCount = async (): Promise<number> => {
      const rows = await ctx.db
        .selectFrom('outbox_event')
        .select('id')
        .where('owner_id', '=', aliceId)
        .execute();
      return rows.length;
    };
    const project = await createProject(alice, 'Quiet');
    const before = await outboxCount();
    const response = await patch(alice, project.id, { title: 'Quieter', archived: true });
    expect(response.statusCode).toBe(200);
    expect(await outboxCount()).toBe(before);
  });
});
