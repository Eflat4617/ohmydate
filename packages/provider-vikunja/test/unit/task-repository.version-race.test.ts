import {
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { InMemoryChangeJournalStore } from '../../src/change-journal-store.js';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../../src/planner-field-store.js';
import { VikunjaTaskRepository } from '../../src/task-repository.js';
import { FakeHttp } from './fake-http.js';

const EXTERNAL_PROJECT = '7';
const EXTERNAL_TASK = '42';
const EXTERNAL_DEPENDENCY = '43';
const CREATED_AT = '2026-01-01T00:00:00Z';

type PollTrigger = 'none' | 'create-relation' | 'patch' | 'sweep-race';

interface ServerState {
  etagVersion: number;
  title: string;
  description: string;
  done: boolean;
  updated: string;
  related: number[];
}

function taskBody(state: ServerState, id = Number(EXTERNAL_TASK)): Record<string, unknown> {
  return {
    id,
    project_id: Number(EXTERNAL_PROJECT),
    title: state.title,
    description: state.description,
    done: state.done,
    due_date: '0001-01-01T00:00:00Z',
    created: CREATED_AT,
    updated: state.updated,
    related_tasks:
      state.related.length === 0
        ? {}
        : {
            blocked: state.related.map((relatedId) => ({
              id: relatedId,
              project_id: Number(EXTERNAL_PROJECT),
              title: 'Dependency',
            })),
          },
  };
}

async function setup() {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(31, clock);
  const ownerId = ids.next();
  const projectId = ids.next();
  const dependencyId = ids.next();

  const state: ServerState = {
    etagVersion: 1,
    title: 'Dependency',
    description: '',
    done: false,
    updated: CREATED_AT,
    related: [],
  };
  let trigger: PollTrigger = 'none';
  const holder: { repo?: VikunjaTaskRepository } = {};
  let subjectId: Id | undefined;
  let captureMid = false;
  const midWindow: { version: Version | undefined; priority: number | undefined } = {
    version: undefined,
    priority: undefined,
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
    entityId: dependencyId,
    externalId: EXTERNAL_DEPENDENCY,
    ownerId,
    externalEtag: '"v1"',
    externalUpdatedAt: CREATED_AT as Instant,
    localVersion: 1 as Version,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  plannerFields.putTask(dependencyId, {
    splittable: false,
    priority: 2,
    status: 'todo',
    dependsOn: [],
  });

  async function pollNow(): Promise<void> {
    if (holder.repo === undefined) throw new Error('repository not initialised');
    await holder.repo.listChangedSince(ownerId, null);
  }

  const http = new FakeHttp(async (request) => {
    if (request.method === 'GET' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      if (trigger === 'sweep-race' && subjectId !== undefined) {
        trigger = 'none';
        // The sweep already read the v1 mapping; a concurrent writer commits v3
        // while this GET is in flight, then the sweep receives this stale body.
        const current = await mappings.get('task', subjectId);
        if (current !== null) {
          await mappings.put(
            {
              ...current,
              externalEtag: '"v3"',
              externalUpdatedAt: '2026-01-01T00:00:09Z' as Instant,
              contentFingerprint: 'newer-concurrent-state',
              localVersion: 3 as Version,
            },
            { expectedLocalVersion: current.localVersion },
          );
        }
      }
      return {
        status: 200,
        body: taskBody(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
    }
    if (
      request.method === 'GET' &&
      request.path === `/api/v2/tasks/${EXTERNAL_DEPENDENCY}`
    ) {
      return {
        status: 200,
        body: taskBody({ ...state, title: 'Dependency', related: [] }, Number(EXTERNAL_DEPENDENCY)),
        headers: { etag: '"v1"' },
      };
    }
    if (
      request.method === 'POST' &&
      request.path === `/api/v2/projects/${EXTERNAL_PROJECT}/tasks`
    ) {
      const body = request.body as Record<string, unknown>;
      state.title = String(body.title);
      state.description = String(body.description ?? '');
      state.done = body.done === true;
      state.etagVersion = 1;
      state.updated = '2026-01-01T00:00:01Z';
      return {
        status: 201,
        body: taskBody(state),
        headers: { etag: '"v1"' },
      };
    }
    if (
      request.method === 'POST' &&
      request.path === `/api/v2/tasks/${EXTERNAL_TASK}/relations`
    ) {
      const body = request.body as { other_task_id: number };
      state.related = [...state.related, body.other_task_id];
      state.etagVersion += 1;
      state.updated = '2026-01-01T00:00:02Z';
      if (trigger === 'create-relation') {
        trigger = 'none';
        await pollNow();
      }
      return { status: 201, body: {} };
    }
    if (request.method === 'PATCH' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      const patch = request.body as Record<string, unknown>;
      if (typeof patch.title === 'string') state.title = patch.title;
      if (typeof patch.description === 'string') state.description = patch.description;
      if (typeof patch.done === 'boolean') state.done = patch.done;
      state.etagVersion += 1;
      state.updated = '2026-01-01T00:00:05Z';
      if (trigger === 'patch') {
        trigger = 'none';
        await pollNow();
        if (captureMid && subjectId !== undefined && holder.repo !== undefined) {
          captureMid = false;
          const mid = await holder.repo.get(ownerId, subjectId);
          midWindow.version = mid?.version;
          midWindow.priority = mid?.priority;
        }
      }
      return {
        status: 200,
        body: taskBody(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
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
    retries: 0,
    sleep: async () => {},
  });
  const journal = new InMemoryChangeJournalStore();
  const repo = new VikunjaTaskRepository({
    clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
    mappings,
    plannerFields,
    journal,
    clock,
    ids,
  });
  holder.repo = repo;

  return {
    repo,
    mappings,
    journal,
    ownerId,
    projectId,
    dependencyId,
    midWindow,
    setTrigger: (value: PollTrigger) => {
      trigger = value;
    },
    setSubject: (id: Id) => {
      subjectId = id;
    },
    captureMidWindow: () => {
      captureMid = true;
    },
    mutateRemote: (patch: Partial<ServerState>) => {
      Object.assign(state, patch);
    },
  };
}

async function taskVersions(
  repo: VikunjaTaskRepository,
  ownerId: Id,
  taskId: Id,
): Promise<Version[]> {
  const page = await repo.listChangedSince(ownerId, null);
  return page.changes
    .filter((change) => change.id === taskId)
    .map((change) => change.version);
}

describe('VikunjaTaskRepository mapping version preconditions', () => {
  test('a poll during the create relation window never reuses or regresses a version', async () => {
    const context = await setup();
    context.setTrigger('create-relation');

    const task = await context.repo.create(
      context.ownerId,
      {
        projectId: context.projectId,
        title: 'With dependency',
        dependsOn: [context.dependencyId],
      },
      'create-relation-race',
    );

    expect(task.version).toBe(2);
    const stored = await context.mappings.get('task', task.id);
    expect(stored?.localVersion).toBe(2);

    const versions = await taskVersions(context.repo, context.ownerId, task.id);
    expect(versions).toEqual([2]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test('a poll during update adopts the poll version instead of reissuing it', async () => {
    const context = await setup();
    const created = await context.repo.create(
      context.ownerId,
      { projectId: context.projectId, title: 'Original' },
      'update-race-create',
    );
    context.setTrigger('patch');

    const updated = await context.repo.update(
      context.ownerId,
      created.id,
      { title: 'Changed' },
      created.version,
    );

    expect(updated.version).toBe(2);
    const versions = await taskVersions(context.repo, context.ownerId, created.id);
    expect(versions).toEqual([1, 2]);
    expect(new Set(versions).size).toBe(versions.length);

    const next = await context.repo.update(
      context.ownerId,
      created.id,
      { title: 'Changed again' },
      updated.version,
    );
    expect(next.version).toBe(3);
    await expect(
      context.repo.update(context.ownerId, created.id, { title: 'stale' }, 2 as Version),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });

  test('P10: adopting a poll version is refused when planner fields also changed', async () => {
    const context = await setup();
    const created = await context.repo.create(
      context.ownerId,
      { projectId: context.projectId, title: 'Original' },
      'p10-fields-create',
    );
    context.setSubject(created.id);
    context.captureMidWindow();
    context.setTrigger('patch');

    const updated = await context.repo.update(
      context.ownerId,
      created.id,
      { title: 'Changed', priority: 4 },
      created.version,
    );

    expect(updated.version).toBe(3);
    expect(updated.priority).toBe(4);
    // A feed consumer that saw v2 inside the write window had the old planner
    // fields; the forced v3 is the entry that tells it about priority 4.
    expect(context.midWindow).toEqual({ version: 2, priority: 2 });

    const final = await context.repo.get(context.ownerId, created.id);
    expect(final?.version).toBe(3);
    expect(final?.priority).toBe(4);

    const versions = await taskVersions(context.repo, context.ownerId, created.id);
    expect(versions).toEqual([1, 2, 3]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test('S2: a reconcile conflict with a stale observation skips without journaling', async () => {
    const context = await setup();
    const created = await context.repo.create(
      context.ownerId,
      { projectId: context.projectId, title: 'Original' },
      's2-reconcile-create',
    );
    context.setSubject(created.id);
    const before = (await context.journal.readAfter(context.ownerId, 0))
      .filter((record) => record.taskId === created.id)
      .map((record) => record.version);

    // The sweep reads a stale remote body while a concurrent writer advances
    // the mapping to v3; the retry path must skip, not re-stamp the stale body.
    context.mutateRemote({
      title: 'stale-remote',
      etagVersion: 2,
      updated: '2026-01-01T00:00:07Z',
    });
    context.setTrigger('sweep-race');
    await context.repo.listChangedSince(context.ownerId, null);

    const after = (await context.journal.readAfter(context.ownerId, 0))
      .filter((record) => record.taskId === created.id)
      .map((record) => record.version);
    expect(after).toEqual(before);
    const stored = await context.mappings.get('task', created.id);
    expect(stored?.localVersion).toBe(3);
    expect(stored?.contentFingerprint).toBe('newer-concurrent-state');
  });

  test('a poll during complete records the completion once at one version', async () => {
    const context = await setup();
    const created = await context.repo.create(
      context.ownerId,
      { projectId: context.projectId, title: 'Complete me' },
      'complete-race-create',
    );
    context.setTrigger('patch');

    const completed = await context.repo.complete(
      context.ownerId,
      created.id,
      created.version,
    );
    expect(completed.version).toBe(2);
    expect(completed.status).toBe('done');

    const page = await context.repo.listChangedSince(context.ownerId, null);
    const changes = page.changes.filter((change) => change.id === created.id);
    expect(changes.map((change) => change.version)).toEqual([1, 2]);
    expect(changes.filter((change) => change.completedOccurrenceAt !== undefined)).toHaveLength(1);
    const stored = await context.mappings.get('task', created.id);
    expect(stored?.localVersion).toBe(2);
  });
});
