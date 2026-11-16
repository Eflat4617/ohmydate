import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, plannerClient, type Project, type Task } from '../src/api';
import { useFolderActions } from '../src/composables/useFolderActions';
import { INBOX_PROJECT_ID, SAMPLE_PROJECT_ID, SEED_TASK_TITLE, mockDb, seedMonth } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';

/**
 * HOLO-05 folders. A folder is a project: `PATCH /projects/{id}` (FOLD-01)
 * renames and archives it, and a to-do is filed by changing its `projectId`.
 * These tests hold three things:
 *
 * - the client call and the mock route, which mirrors the live rules (404 for
 *   an id that is not yours, 412 stale, 422 for archiving the inbox and for
 *   renaming an archived folder without bringing it back, an empty patch is a
 *   no-op) and the backend's refusal of every write to a to-do in an archived
 *   folder;
 * - 폴더 없애기 in its one safe order — every to-do out first, the archive
 *   only when the folder is empty, never with something inside;
 * - the undo in the reverse order — the folder back first, then its to-dos.
 */
interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

const seen: Seen[] = [];

function record(): void {
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (request.method === 'GET') return;
    void request
      .clone()
      .text()
      .then((raw) => {
        seen.push({ method: request.method, path: url.pathname.replace('/api/v1', ''), body: raw.length > 0 ? JSON.parse(raw) : null });
      });
  });
}

function project(id: string): Project {
  const found = mockDb.projects.get(id);
  if (found === undefined) throw new Error(`no project ${id}`);
  return found;
}

function tasksIn(projectId: string): Task[] {
  return [...mockDb.tasks.values()].filter((task) => task.projectId === projectId && task.deletedAt === undefined);
}

function actions(online = true) {
  return useFolderActions({ canMutate: () => online, inboxId: () => INBOX_PROJECT_ID });
}

async function patchError(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof ApiError) return cause;
    throw cause;
  }
  throw new Error('the request did not fail');
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  seedMonth(mockDb);
  seen.length = 0;
  record();
});

afterEach(() => {
  server.events.removeAllListeners();
  adoptActiveOwner(null, 'bootstrap');
});

describe('updateProject: the client call and the mock’s rules (FOLD-01)', () => {
  it('renames a folder with If-Match and an idempotency key, and answers its new version', async () => {
    let headers: Headers | null = null;
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') headers = request.headers;
    });
    const updated = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '학위 논문' }, 'key-rename-1', 1);
    expect(updated).toMatchObject({ id: SAMPLE_PROJECT_ID, title: '학위 논문', archived: false, version: 2 });
    expect((headers as Headers | null)?.get('If-Match')).toBe('W/"1"');
    expect((headers as Headers | null)?.get('Idempotency-Key')).toBe('key-rename-1');
    expect(plannerClient.cachedProjectVersion(SAMPLE_PROJECT_ID)).toBe(2);
    expect(project(SAMPLE_PROJECT_ID).title).toBe('학위 논문');
  });

  it('replays the same key instead of changing the folder twice', async () => {
    await plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '학위 논문' }, 'key-replay', 1);
    const again = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '학위 논문' }, 'key-replay', 1);
    expect(again.version).toBe(2);
    expect(project(SAMPLE_PROJECT_ID).version).toBe(2);
  });

  it('archives and brings back; archiving touches no to-do', async () => {
    const before = tasksIn(SAMPLE_PROJECT_ID).map((task) => [task.id, task.version]);
    const archived = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { archived: true }, 'key-archive', 1);
    expect(archived).toMatchObject({ archived: true, version: 2 });
    expect(tasksIn(SAMPLE_PROJECT_ID).map((task) => [task.id, task.version])).toEqual(before);
    const back = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { archived: false }, 'key-back', archived.version);
    expect(back).toMatchObject({ archived: false, version: 3 });
  });

  it('an empty patch changes nothing: the folder as it is, with its current version', async () => {
    const same = await plannerClient.updateProject(SAMPLE_PROJECT_ID, {}, 'key-empty', 1);
    expect(same.version).toBe(1);
    expect(project(SAMPLE_PROJECT_ID).version).toBe(1);
  });

  it('412 for a stale version (negative)', async () => {
    const failure = await patchError(() => plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '늦은 이름' }, 'key-stale', 7));
    expect(failure.status).toBe(412);
    expect(project(SAMPLE_PROJECT_ID).title).toBe('졸업 논문');
  });

  it('404 for an id that is not there, and for another owner’s folder (negative)', async () => {
    const missing = await patchError(() => plannerClient.updateProject('01900000-0000-7000-8000-00000000ffff', { title: '없음' }, 'key-404', 1));
    expect(missing.status).toBe(404);
    mockDb.projects.set(SAMPLE_PROJECT_ID, { ...project(SAMPLE_PROJECT_ID), ownerId: '01900000-0000-7000-8000-0000000000ee' });
    const foreign = await patchError(() => plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '남의 것' }, 'key-foreign', 1));
    expect(foreign.status).toBe(404);
    expect(project(SAMPLE_PROJECT_ID).title).toBe('졸업 논문');
  });

  it('422: the inbox cannot be archived — but it can be renamed and stays the inbox', async () => {
    const failure = await patchError(() => plannerClient.updateProject(INBOX_PROJECT_ID, { archived: true }, 'key-inbox', 1));
    expect(failure.status).toBe(422);
    expect(failure.code).toBe('validation_failed');
    expect(project(INBOX_PROJECT_ID).archived).toBe(false);
    const renamed = await plannerClient.updateProject(INBOX_PROJECT_ID, { title: '받은 것' }, 'key-inbox-name', 1);
    expect(renamed).toMatchObject({ kind: 'inbox', title: '받은 것' });
  });

  it('422: an archived folder is renamed only by a patch that also brings it back', async () => {
    const archived = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { archived: true }, 'key-a', 1);
    const failure = await patchError(() => plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '새 이름' }, 'key-b', archived.version));
    expect(failure.status).toBe(422);
    expect(project(SAMPLE_PROJECT_ID).title).toBe('졸업 논문');
    const back = await plannerClient.updateProject(SAMPLE_PROJECT_ID, { title: '새 이름', archived: false }, 'key-c', archived.version);
    expect(back).toMatchObject({ title: '새 이름', archived: false });
  });

  it('the backend refuses every write to a to-do inside an archived folder (negative)', async () => {
    const inside = tasksIn(SAMPLE_PROJECT_ID)[0] as Task;
    await plannerClient.updateProject(SAMPLE_PROJECT_ID, { archived: true }, 'key-shut', 1);
    const move = await patchError(() => plannerClient.updateTask(inside.id, { projectId: INBOX_PROJECT_ID }, 'key-move', inside.version));
    expect(move.status).toBe(503);
    const done = await patchError(() => plannerClient.completeTask(inside.id, 'key-done', inside.version));
    expect(done.status).toBe(503);
    const gone = await patchError(() => plannerClient.deleteTask(inside.id, 'key-gone', inside.version));
    expect(gone.status).toBe(503);
    // …and nothing can be filed into it either.
    const outside = tasksIn(INBOX_PROJECT_ID)[0] as Task;
    const into = await patchError(() => plannerClient.updateTask(outside.id, { projectId: SAMPLE_PROJECT_ID }, 'key-into', outside.version));
    expect(into.status).toBe(503);
    expect(mockDb.tasks.get(inside.id)?.projectId).toBe(SAMPLE_PROJECT_ID);
  });
});

describe('filing: a to-do’s folder is its project', () => {
  it('files to-dos one by one and answers what moved', async () => {
    const [first, second] = tasksIn(INBOX_PROJECT_ID) as [Task, Task];
    const folder = actions();
    const result = await folder.file([first, second], SAMPLE_PROJECT_ID);
    expect(result.moved.map((task) => task.id)).toEqual([first.id, second.id]);
    expect(result.failed).toEqual([]);
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([
      ['PATCH', `/tasks/${first.id}`, { projectId: SAMPLE_PROJECT_ID }],
      ['PATCH', `/tasks/${second.id}`, { projectId: SAMPLE_PROJECT_ID }],
    ]);
    expect(mockDb.tasks.get(first.id)?.projectId).toBe(SAMPLE_PROJECT_ID);
  });

  it('a to-do changed elsewhere is still filed: the move is retried once on its newest version', async () => {
    const task = tasksIn(INBOX_PROJECT_ID).find((item) => item.title === SEED_TASK_TITLE) as Task;
    // Another device renamed it meanwhile.
    mockDb.tasks.set(task.id, { ...task, title: '다른 곳에서 바꾼 제목', version: task.version + 1 });
    const result = await actions().file([task], SAMPLE_PROJECT_ID);
    expect(result.moved).toHaveLength(1);
    const now = mockDb.tasks.get(task.id) as Task;
    expect(now.projectId).toBe(SAMPLE_PROJECT_ID);
    // The move did not undo the other change.
    expect(now.title).toBe('다른 곳에서 바꾼 제목');
  });

  it('what is already there is not sent again, and what the server refuses is reported (negative)', async () => {
    const [first, second] = tasksIn(INBOX_PROJECT_ID) as [Task, Task];
    const folder = actions();
    expect(await folder.file([first], INBOX_PROJECT_ID)).toEqual({ moved: [], failed: [] });
    expect(seen).toEqual([]);

    server.use(http.patch(`*/api/v1/tasks/${first.id}`, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 500, code: 'internal', detail: 'x' }, { status: 500 })));
    const result = await folder.file([first, second], SAMPLE_PROJECT_ID);
    expect(result.failed.map((task) => task.id)).toEqual([first.id]);
    expect(result.moved.map((task) => task.id)).toEqual([second.id]);
    expect(folder.error.value).not.toBeNull();
  });

  it('offline nothing is filed and nothing is sent (negative)', async () => {
    const task = tasksIn(INBOX_PROJECT_ID)[0] as Task;
    const folder = actions(false);
    const result = await folder.file([task], SAMPLE_PROJECT_ID);
    expect(result.moved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(folder.error.value).toBe('오프라인이에요. 다시 연결될 때까지 편집할 수 없어요.');
    expect(await folder.create('오프라인 폴더')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('sets a deadline and takes it away', async () => {
    const task = tasksIn(INBOX_PROJECT_ID).find((item) => item.dueAt === undefined) as Task;
    const folder = actions();
    const dated = await folder.setDue(task, '2026-11-20T09:00:00.000Z');
    expect(dated?.dueAt).toBe('2026-11-20T09:00:00.000Z');
    const cleared = await folder.setDue(dated as Task, null);
    expect(cleared?.dueAt).toBeUndefined();
    expect(seen.map((request) => request.body)).toEqual([{ dueAt: '2026-11-20T09:00:00.000Z' }, { dueAt: null }]);
  });
});

describe('폴더 만들기 and renaming', () => {
  it('makes a folder with the existing route, trimmed', async () => {
    const created = await actions().create('  새 폴더  ');
    expect(created).toMatchObject({ title: '새 폴더', kind: 'normal', archived: false });
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([['POST', '/projects', { title: '새 폴더' }]]);
  });

  it('a blank name makes nothing, and a name that did not change renames nothing (negative)', async () => {
    const folder = actions();
    expect(await folder.create('   ')).toBeNull();
    expect(await folder.rename(project(SAMPLE_PROJECT_ID), '졸업 논문')).toBeNull();
    expect(await folder.rename(project(SAMPLE_PROJECT_ID), '  ')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('renames in place, and once more against the newest version when the page’s copy was stale', async () => {
    const stale = project(SAMPLE_PROJECT_ID);
    mockDb.projects.set(SAMPLE_PROJECT_ID, { ...stale, version: 4 });
    const renamed = await actions().rename(stale, '학위 논문');
    expect(renamed).toMatchObject({ title: '학위 논문', version: 5 });
    expect(seen.filter((request) => request.method === 'PATCH')).toHaveLength(2);
  });
});

describe('폴더 없애기: the one safe order', () => {
  it('moves EVERY to-do — open and finished — to the inbox first, then archives the empty folder', async () => {
    // A finished to-do in the folder, too.
    const inside = tasksIn(SAMPLE_PROJECT_ID);
    mockDb.tasks.set((inside[0] as Task).id, { ...(inside[0] as Task), status: 'done' });
    expect(inside.length).toBeGreaterThanOrEqual(2);

    const outcome = await actions().remove(project(SAMPLE_PROJECT_ID));
    expect(outcome.status).toBe('removed');
    const order = seen.map((request) => `${request.method} ${request.path}`);
    // Every move comes before the one archive.
    expect(order.slice(0, inside.length).sort()).toEqual(inside.map((task) => `PATCH /tasks/${task.id}`).sort());
    expect(order[order.length - 1]).toBe(`PATCH /projects/${SAMPLE_PROJECT_ID}`);
    expect(seen[seen.length - 1]?.body).toEqual({ archived: true });
    expect(seen.slice(0, inside.length).every((request) => (request.body as { projectId?: string }).projectId === INBOX_PROJECT_ID)).toBe(true);

    expect(project(SAMPLE_PROJECT_ID).archived).toBe(true);
    expect(tasksIn(SAMPLE_PROJECT_ID)).toEqual([]);
    // Nothing was deleted: they are all in the inbox, the finished one still finished.
    for (const task of inside) expect(mockDb.tasks.get(task.id)).toMatchObject({ projectId: INBOX_PROJECT_ID });
    expect(mockDb.tasks.get((inside[0] as Task).id)?.status).toBe('done');
    expect(seen.some((request) => request.method === 'DELETE')).toBe(false);
  });

  it('stops and says so when a move fails: the folder stays, partly emptied, and is NOT archived (negative)', async () => {
    const inside = tasksIn(SAMPLE_PROJECT_ID);
    const stuck = inside[inside.length - 1] as Task;
    server.use(http.patch(`*/api/v1/tasks/${stuck.id}`, () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 503, code: 'provider_unavailable', detail: 'x' }, { status: 503 })));
    const folder = actions();
    const outcome = await folder.remove(project(SAMPLE_PROJECT_ID));
    expect(outcome.status).toBe('partial');
    expect(folder.error.value).toBe('“졸업 논문” 폴더를 비우다 멈췄어요. 옮기지 못한 할 일이 있어 폴더는 그대로 뒀어요.');
    expect(project(SAMPLE_PROJECT_ID).archived).toBe(false);
    expect(seen.some((request) => request.path === `/projects/${SAMPLE_PROJECT_ID}`)).toBe(false);
    expect(mockDb.tasks.get(stuck.id)?.projectId).toBe(SAMPLE_PROJECT_ID);
  });

  it('does not archive while the server still lists something in it (negative)', async () => {
    // The moves "succeed" but the folder is not empty afterwards (something was added to it meanwhile).
    const late = { ...(tasksIn(INBOX_PROJECT_ID)[0] as Task), id: '01900000-0000-7000-8000-0000000009a1', projectId: SAMPLE_PROJECT_ID };
    let listed = 0;
    server.use(
      http.get('*/api/v1/tasks', ({ request }) => {
        if (new URL(request.url).searchParams.get('projectId') !== SAMPLE_PROJECT_ID) return undefined;
        listed += 1;
        // Rounds one to three see nothing; the last look before the archive finds a to-do.
        return HttpResponse.json({ items: listed >= 2 ? [late] : [], nextCursor: null });
      }),
    );
    const outcome = await actions().remove(project(SAMPLE_PROJECT_ID));
    expect(outcome.status).toBe('partial');
    expect(project(SAMPLE_PROJECT_ID).archived).toBe(false);
  });

  it('an empty folder is simply archived; the inbox is never removed (negative)', async () => {
    const empty = await actions().create('빈 폴더');
    seen.length = 0;
    const outcome = await actions().remove(empty as Project);
    expect(outcome.status).toBe('removed');
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([`PATCH /projects/${(empty as Project).id}`]);

    seen.length = 0;
    expect((await actions().remove(project(INBOX_PROJECT_ID))).status).toBe('failed');
    expect(seen).toEqual([]);
    expect(project(INBOX_PROJECT_ID).archived).toBe(false);
  });
});

describe('되돌리기: the reverse order', () => {
  it('brings the folder back FIRST, with the version the archive answered, THEN moves the to-dos back', async () => {
    const inside = tasksIn(SAMPLE_PROJECT_ID);
    const folder = actions();
    const outcome = await folder.remove(project(SAMPLE_PROJECT_ID));
    if (outcome.status !== 'removed') throw new Error('not removed');
    expect(outcome.removed.project).toMatchObject({ archived: true, version: 2 });
    seen.length = 0;

    const result = await folder.restore(outcome.removed);
    expect(result).toEqual({ restored: true, failed: 0 });
    const order = seen.map((request) => `${request.method} ${request.path}`);
    expect(order[0]).toBe(`PATCH /projects/${SAMPLE_PROJECT_ID}`);
    expect(seen[0]?.body).toEqual({ archived: false });
    expect(order.slice(1).sort()).toEqual(inside.map((task) => `PATCH /tasks/${task.id}`).sort());
    expect(project(SAMPLE_PROJECT_ID).archived).toBe(false);
    expect(tasksIn(SAMPLE_PROJECT_ID).map((task) => task.id).sort()).toEqual(inside.map((task) => task.id).sort());
  });

  it('when the folder cannot be brought back nothing is moved: the to-dos stay safely in the inbox (negative)', async () => {
    const inside = tasksIn(SAMPLE_PROJECT_ID);
    const folder = actions();
    const outcome = await folder.remove(project(SAMPLE_PROJECT_ID));
    if (outcome.status !== 'removed') throw new Error('not removed');
    seen.length = 0;
    // The un-archive is refused (changed elsewhere since).
    mockDb.projects.set(SAMPLE_PROJECT_ID, { ...project(SAMPLE_PROJECT_ID), version: 9 });
    const result = await folder.restore(outcome.removed);
    expect(result).toEqual({ restored: false, failed: inside.length });
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([`PATCH /projects/${SAMPLE_PROJECT_ID}`]);
    for (const task of inside) expect(mockDb.tasks.get(task.id)?.projectId).toBe(INBOX_PROJECT_ID);
  });
});
