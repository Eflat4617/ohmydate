import {
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../../src/planner-field-store.js';
import { VikunjaTaskRepository } from '../../src/task-repository.js';
import { FakeHttp } from './fake-http.js';

const EXTERNAL_PROJECT = '7';
const EXTERNAL_TASK = '42';
const UPDATED_AT = '2026-01-01T00:00:00Z';

interface ServerState {
  etag: string;
  title: string;
  description: string;
  done: boolean;
  updated: string;
}

function taskBody(state: ServerState): Record<string, unknown> {
  return {
    id: Number(EXTERNAL_TASK),
    project_id: Number(EXTERNAL_PROJECT),
    title: state.title,
    description: state.description,
    done: state.done,
    due_date: '0001-01-01T00:00:00Z',
    created: '2026-01-01T00:00:00Z',
    updated: state.updated,
    related_tasks: {},
  };
}

async function setup(seedState: Partial<ServerState> = {}) {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(11, clock);
  const ownerId = ids.next();
  const projectId = ids.next();
  const taskId = ids.next();

  const state: ServerState = {
    etag: '"v1"',
    title: 'Draft',
    description: `Original\n\n<!-- ohmydate:${taskId} -->`,
    done: false,
    updated: UPDATED_AT,
    ...seedState,
  };

  const mappings = new InMemoryMappingStore();
  const plannerFields = new InMemoryPlannerFieldStore();
  await mappings.put({
    provider: 'vikunja',
    entityType: 'project',
    entityId: projectId,
    externalId: EXTERNAL_PROJECT,
    ownerId,
    localVersion: 1 as Version,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  await mappings.put({
    provider: 'vikunja',
    entityType: 'task',
    entityId: taskId,
    externalId: EXTERNAL_TASK,
    ownerId,
    externalEtag: state.etag,
    externalUpdatedAt: UPDATED_AT as Instant,
    localVersion: 1 as Version,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  plannerFields.putTask(taskId, {
    splittable: false,
    priority: 2,
    status: 'todo',
    dependsOn: [],
  });

  const http = new FakeHttp((request) => {
    if (request.method === 'GET' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      return { status: 200, body: taskBody(state), headers: { etag: state.etag } };
    }
    if (request.method === 'PATCH' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      const patch = request.body as Record<string, unknown>;
      if (typeof patch.title === 'string') state.title = patch.title;
      if (typeof patch.description === 'string') state.description = patch.description;
      if (typeof patch.done === 'boolean') state.done = patch.done;
      state.etag = '"v2"';
      state.updated = '2026-01-01T00:00:05Z';
      return { status: 200, body: taskBody(state), headers: { etag: state.etag } };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks') {
      return {
        status: 200,
        body: {
          items: [taskBody(state)],
          total: 1,
          page: 1,
          per_page: 50,
          total_pages: 1,
        },
      };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks/deleted') {
      return {
        status: 200,
        body: { items: [], total: 0, page: 1, per_page: 50, total_pages: 1 },
      };
    }
    return { status: 404, body: { code: 4002, detail: 'not found' } };
  });

  const client = new VikunjaClient({
    baseUrl: 'http://vikunja.test',
    token: 'tk_test',
    fetch: http.fetch,
  });
  const repo = new VikunjaTaskRepository({
    clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
    mappings,
    plannerFields,
    clock,
    ids,
  });
  return { repo, http, state, ownerId, taskId, projectId, clock };
}

describe('VikunjaTaskRepository conflict detection', () => {
  test('rejects a stale local version before making any HTTP call', async () => {
    const { repo, http, ownerId, taskId } = await setup();

    await expect(
      repo.update(ownerId, taskId, { title: 'stale' }, 2 as Version),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(http.calls).toHaveLength(0);
  });

  test('rejects when the remote ETag drifted from the mapping', async () => {
    const { repo, http, state, ownerId, taskId } = await setup();
    state.etag = '"changed-externally"';

    const conflict = await repo
      .update(ownerId, taskId, { title: 'blocked' }, 1 as Version)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(VersionConflictError);
    expect((conflict as VersionConflictError).actual).toBe(2);
    expect(http.calls.filter((call) => call.method === 'PATCH')).toHaveLength(0);
  });

  test('writes, re-reads the ETag and bumps the local version on success', async () => {
    const { repo, http, ownerId, taskId, clock } = await setup();
    clock.advance(1_000);

    const updated = await repo.update(
      ownerId,
      taskId,
      { title: 'Revised' },
      1 as Version,
    );

    expect(updated.version).toBe(2);
    expect(updated.title).toBe('Revised');
    expect(updated.description).toBe('Original');
    expect(updated.updatedAt).not.toBe(updated.createdAt);
    expect(http.calls.map((call) => call.method)).toEqual(['GET', 'PATCH', 'GET']);
  });

  test('complete honours expectedVersion and is a version-stable no-op only when current', async () => {
    const { repo, ownerId, taskId } = await setup({ done: true });

    const completed = await repo.complete(ownerId, taskId, 1 as Version);
    expect(completed.status).toBe('done');
    expect(completed.version).toBe(1);

    await expect(
      repo.complete(ownerId, taskId, 2 as Version),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  test('reconciles same-second remote changes once using the ETag and cursor', async () => {
    const { repo, state, ownerId } = await setup();

    const initial = await repo.listChangedSince(ownerId, null);
    expect(initial.changes.map((change) => change.version)).toEqual([1]);

    state.etag = '"v2"';
    state.updated = '2026-01-01T00:00:05Z';
    const page = await repo.listChangedSince(ownerId, initial.cursor);
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]?.version).toBe(2);

    const drained = await repo.listChangedSince(ownerId, page.cursor);
    expect(drained.changes).toEqual([]);

    const replay = await repo.listChangedSince(ownerId, initial.cursor);
    expect(replay.changes.map((change) => change.version)).toEqual([2]);
  });
});
