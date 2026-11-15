/**
 * `updateProject` (FOLD-01): the rules the generic suite cannot know.
 *
 * `services/api/test/project-update.test.ts` pins the same answers for the
 * TypeScript API, so the two implementations stay interchangeable for the
 * web client: same statuses, same `errors[]`, same versions.
 */
import {
  API_PREFIX,
  UNKNOWN_ID,
  expectProblem,
  expectSuccess,
  routeById,
} from './support/contract.js';
import { startCore, type Core, type CoreResponse } from './support/core.js';
import { createProject, createTask, newIdempotencyKey } from './support/routes.js';

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

let core: Core;

beforeAll(async () => {
  core = await startCore();
});

afterAll(async () => {
  await core.dispose();
});

const route = routeById('updateProject');

function patch(
  id: string,
  version: number,
  body: unknown,
  key: string = newIdempotencyKey(),
): Promise<CoreResponse> {
  return core.request('PATCH', `${API_PREFIX}/projects/${id}`, {
    headers: { 'if-match': `W/"${version}"`, 'idempotency-key': key },
    body,
  });
}

async function listProjects(): Promise<ProjectBody[]> {
  const response = await core.request('GET', `${API_PREFIX}/projects?limit=100`);
  expectSuccess(routeById('listProjects'), response, 200);
  return (response.body as { items: ProjectBody[] }).items;
}

async function projectOf(id: string): Promise<ProjectBody | undefined> {
  return (await listProjects()).find((project) => project.id === id);
}

async function inbox(): Promise<ProjectBody> {
  const inboxes = (await listProjects()).filter((project) => project.kind === 'inbox');
  expect(inboxes).toHaveLength(1);
  return inboxes[0] as ProjectBody;
}

async function tasksOf(projectId: string): Promise<unknown[]> {
  const response = await core.request('GET', `${API_PREFIX}/tasks?projectId=${projectId}&limit=100`);
  expectSuccess(routeById('listTasks'), response, 200);
  return (response.body as { items: unknown[] }).items;
}

function errorsOf(response: CoreResponse): unknown {
  return (response.body as { errors?: unknown }).errors;
}

describe('updateProject: rename and archive a folder', () => {
  test('a rename answers the whole project with its new version as ETag', async () => {
    const project = (await createProject(core, 'Thesiss')) as ProjectBody;
    const response = await patch(project.id, 1, { title: 'Thesis' });
    expectSuccess(route, response, 200);
    expect(response.headers.get('etag')).toBe('W/"2"');
    const renamed = response.body as ProjectBody;
    expect(renamed).toEqual({
      ...project,
      title: 'Thesis',
      version: 2,
      updatedAt: renamed.updatedAt,
    });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(project.updatedAt));
    expect(await projectOf(project.id)).toEqual(renamed);
  });

  test('the Inbox cannot be archived: 422 validation_failed, stored for its key', async () => {
    const before = await inbox();
    const key = newIdempotencyKey();
    const refused = await patch(before.id, before.version, { archived: true }, key);
    expectProblem(route, refused, 422, 'validation_failed');
    expect(errorsOf(refused)).toEqual([
      { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
    ]);
    // 08 §1: a 422 domain result is stored and replayed.
    const replay = await patch(before.id, before.version, { archived: true }, key);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual(refused.body);

    // Not together with a rename either, and the Inbox rule answers before
    // the title is looked at.
    for (const body of [
      { title: 'Gone', archived: true },
      { title: '   ', archived: true },
    ]) {
      const response = await patch(before.id, before.version, body);
      expectProblem(route, response, 422, 'validation_failed');
      expect(errorsOf(response)).toEqual([
        { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
      ]);
    }
    expect(await inbox()).toEqual(before);
  });

  test('the Inbox can be renamed and stays the one Inbox', async () => {
    const before = await inbox();
    const renamed = await patch(before.id, before.version, { title: '바깥' });
    expectSuccess(route, renamed, 200);
    expect(renamed.body).toMatchObject({
      id: before.id,
      title: '바깥',
      kind: 'inbox',
      archived: false,
      version: before.version + 1,
    });
    expect((await inbox()).id).toBe(before.id);

    // Found by kind, not by title: a task without a project still lands in it.
    const task = (await createTask(core, 'lands outside')) as unknown as { projectId: string };
    expect(task.projectId).toBe(before.id);

    // Renamed or not, it is still the Inbox.
    const refused = await patch(before.id, before.version + 1, { archived: true });
    expectProblem(route, refused, 422, 'validation_failed');
    // `archived: false` is what the Inbox already is, so it is accepted.
    const stays = await patch(before.id, before.version + 1, { archived: false });
    expectSuccess(route, stays, 200);
    expect(stays.body).toMatchObject({ kind: 'inbox', archived: false });
  });

  test('an empty patch is a no-op: 200 with the current project and its current ETag', async () => {
    const project = (await createProject(core, 'Untouched')) as ProjectBody;
    const response = await patch(project.id, 1, {});
    expectSuccess(route, response, 200);
    expect(response.headers.get('etag')).toBe('W/"1"');
    expect(response.body).toEqual(project);
    expect(await projectOf(project.id)).toEqual(project);

    // It is still a conditional request on an existing project.
    expectProblem(route, await patch(project.id, 2, {}), 412, 'version_conflict');
    expectProblem(route, await patch(UNKNOWN_ID, 1, {}), 404, 'not_found');

    // The version did not move: the next real change still matches W/"1".
    const next = await patch(project.id, 1, { title: 'Touched' });
    expectSuccess(route, next, 200);
    expect(next.body).toMatchObject({ title: 'Touched', version: 2 });
  });

  test('archiving and bringing back does not touch the tasks of the project', async () => {
    const project = (await createProject(core, 'Old course')) as ProjectBody;
    const key = (): Record<string, string> => ({ 'idempotency-key': newIdempotencyKey() });
    const created: { id: string }[] = [];
    for (const title of ['still open', 'finished']) {
      const response = await core.request('POST', `${API_PREFIX}/tasks`, {
        headers: key(),
        body: { title, projectId: project.id },
      });
      expectSuccess(routeById('createTask'), response, 201);
      created.push(response.body as { id: string });
    }
    const completed = await core.request('POST', `${API_PREFIX}/tasks/${created[1]?.id}:complete`, {
      headers: { ...key(), 'if-match': 'W/"1"' },
    });
    expectSuccess(routeById('completeTask'), completed, 200);
    const before = await tasksOf(project.id);
    expect(before).toHaveLength(2);

    const archived = await patch(project.id, 1, { archived: true });
    expectSuccess(route, archived, 200);
    expect(archived.body).toMatchObject({ title: 'Old course', archived: true, version: 2 });
    // Neither deleted nor moved nor re-versioned.
    expect(await tasksOf(project.id)).toEqual(before);
    // This core keeps listing an archived project, with its flag (blueprint 15 §2.2).
    expect(await projectOf(project.id)).toEqual(archived.body);

    const back = await patch(project.id, 2, { archived: false });
    expectSuccess(route, back, 200);
    expect(back.body).toMatchObject({ archived: false, version: 3 });
    expect(await tasksOf(project.id)).toEqual(before);
  });

  test('an archived project is renamed only together with bringing it back', async () => {
    const project = (await createProject(core, 'Shelved')) as ProjectBody;
    const shelved = await patch(project.id, 1, { archived: true });
    expectSuccess(route, shelved, 200);

    for (const body of [{ title: 'Renamed' }, { title: 'Renamed', archived: true }]) {
      const refused = await patch(project.id, 2, body);
      expectProblem(route, refused, 422, 'validation_failed');
      expect(errorsOf(refused)).toEqual([
        { path: 'title', message: 'an archived project cannot be renamed; bring it back first' },
      ]);
    }
    expect(await projectOf(project.id)).toEqual(shelved.body);

    const back = await patch(project.id, 2, { title: 'Renamed', archived: false });
    expectSuccess(route, back, 200);
    expect(back.body).toMatchObject({ title: 'Renamed', archived: false, version: 3 });
  });

  test('the title is validated as on create, and a refused patch changes nothing', async () => {
    const project = (await createProject(core, 'Validated')) as ProjectBody;

    // Outside the contract schema: 400.
    for (const body of [
      { title: '' },
      { title: 'x'.repeat(201) },
      { title: null },
      { archived: 'yes' },
      { archived: null },
      { kind: 'inbox' },
      { title: 'ok', version: 9 },
    ]) {
      const response = await patch(project.id, 1, body);
      expectProblem(route, response, 400, 'validation_failed');
    }

    // Inside the schema but blank: the same 422 createProject answers.
    const createBlank = await core.request('POST', `${API_PREFIX}/projects`, {
      headers: { 'idempotency-key': newIdempotencyKey() },
      body: { title: '   ' },
    });
    expectProblem(routeById('createProject'), createBlank, 422, 'validation_failed');
    const patchBlank = await patch(project.id, 1, { title: '   ', archived: true });
    expectProblem(route, patchBlank, 422, 'validation_failed');
    expect(errorsOf(patchBlank)).toEqual([{ path: 'title', message: 'title must not be empty' }]);
    expect(errorsOf(createBlank)).toEqual(errorsOf(patchBlank));
    // A stale version is reported before the title is looked at.
    expectProblem(route, await patch(project.id, 9, { title: '   ' }), 412, 'version_conflict');
    expect(await projectOf(project.id)).toEqual(project);

    const longest = await patch(project.id, 1, { title: '가'.repeat(200) });
    expectSuccess(route, longest, 200);
    expect((longest.body as ProjectBody).title).toBe('가'.repeat(200));
  });

  test('a 412 is not stored for its key; the retry with the right version writes once', async () => {
    const project = (await createProject(core, 'Versioned')) as ProjectBody;
    const key = newIdempotencyKey();
    const stale = await patch(project.id, 5, { title: 'Second', archived: true }, key);
    expectProblem(route, stale, 412, 'version_conflict');
    expect(await projectOf(project.id)).toEqual(project);

    const retried = await patch(project.id, 1, { title: 'Second', archived: true }, key);
    expectSuccess(route, retried, 200);
    // The replay carries the old If-Match and still gets the stored answer.
    const replay = await patch(project.id, 1, { title: 'Second', archived: true }, key);
    expect(replay.body).toEqual(retried.body);
    expect(await projectOf(project.id)).toMatchObject({ title: 'Second', archived: true, version: 2 });
  });

  test('a project has no read-one and no delete operation', async () => {
    const project = (await createProject(core, 'Kept')) as ProjectBody;
    for (const method of ['GET', 'DELETE', 'PUT', 'POST']) {
      const response = await core.request(method, `${API_PREFIX}/projects/${project.id}`, {
        headers: { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() },
      });
      expect([method, response.status]).toEqual([method, 404]);
      expect((response.body as { code: string }).code).toBe('not_found');
    }
    expect(await projectOf(project.id)).toEqual(project);
  });
});
