import {
  CursorInvalidatedError,
  ProviderUnavailableError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import {
  InMemoryChangeJournalStore,
  type ChangeJournalStore,
} from '../../src/change-journal-store.js';
import { VikunjaClient } from '../../src/client.js';
import { encodeChangeCursor } from '../../src/cursor.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../../src/planner-field-store.js';
import { VikunjaTaskRepository } from '../../src/task-repository.js';
import { FakeHttp } from './fake-http.js';

const EXTERNAL_PROJECT = '7';
const EXTERNAL_TASK = '42';
const EXTERNAL_DEPENDENCY = '43';
const CREATED_AT = '2026-01-01T00:00:00Z';

interface ServerState {
  etagVersion: number;
  title: string;
  description: string;
  done: boolean;
  updated: string;
  patched: boolean;
}

interface Flags {
  failRelationPost: boolean;
  failFinalGet: boolean;
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
    related_tasks: {},
  };
}

function dependencyBody(): Record<string, unknown> {
  return {
    id: Number(EXTERNAL_DEPENDENCY),
    project_id: Number(EXTERNAL_PROJECT),
    title: 'Dependency',
    description: '',
    done: false,
    due_date: '0001-01-01T00:00:00Z',
    created: CREATED_AT,
    updated: CREATED_AT,
    related_tasks: {},
  };
}

async function setup(journal?: ChangeJournalStore) {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(21, clock);
  const ownerId = ids.next();
  const projectId = ids.next();
  const taskId = ids.next();
  const dependencyId = ids.next();

  const state: ServerState = {
    etagVersion: 1,
    title: 'Original',
    description: `Original\n\n<!-- ohmydate:${taskId} -->`,
    done: false,
    updated: CREATED_AT,
    patched: false,
  };
  const flags: Flags = { failRelationPost: false, failFinalGet: false };
  let failNextTaskGet = false;

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
  for (const [entityId, externalId] of [
    [taskId, EXTERNAL_TASK],
    [dependencyId, EXTERNAL_DEPENDENCY],
  ] as const) {
    await mappings.put({
      provider: 'vikunja',
      entityType: 'task',
      entityId,
      externalId,
      ownerId,
      externalEtag: '"v1"',
      externalUpdatedAt: CREATED_AT as Instant,
      localVersion: 1 as Version,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
  }
  plannerFields.putTask(taskId, {
    splittable: false,
    priority: 2,
    status: 'todo',
    dependsOn: [],
  });
  plannerFields.putTask(dependencyId, {
    splittable: false,
    priority: 2,
    status: 'todo',
    dependsOn: [],
  });

  const http = new FakeHttp((request) => {
    if (request.method === 'GET' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      if (failNextTaskGet) {
        failNextTaskGet = false;
        return { status: 503, body: { title: 'unavailable' } };
      }
      return {
        status: 200,
        body: taskBody(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
    }
    if (request.method === 'GET' && request.path === `/api/v2/tasks/${EXTERNAL_DEPENDENCY}`) {
      return {
        status: 200,
        body: dependencyBody(),
        headers: { etag: '"v1"' },
      };
    }
    if (request.method === 'PATCH' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      const patch = request.body as Record<string, unknown>;
      if (typeof patch.title === 'string') state.title = patch.title;
      if (typeof patch.description === 'string') state.description = patch.description;
      if (typeof patch.done === 'boolean') state.done = patch.done;
      state.etagVersion += 1;
      state.updated = '2026-01-01T00:00:05Z';
      state.patched = true;
      failNextTaskGet = flags.failFinalGet;
      return {
        status: 200,
        body: taskBody(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
    }
    if (
      request.method === 'POST' &&
      request.path === `/api/v2/tasks/${EXTERNAL_TASK}/relations`
    ) {
      if (flags.failRelationPost) {
        return { status: 503, body: { title: 'unavailable' } };
      }
      return { status: 201, body: {} };
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
  const journalStore = journal ?? new InMemoryChangeJournalStore();
  const createRepo = () =>
    new VikunjaTaskRepository({
      clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
      mappings,
      plannerFields,
      journal: journalStore,
      clock,
      ids,
    });

  return {
    createRepo,
    journal: journalStore,
    flags,
    state,
    ownerId,
    taskId,
    dependencyId,
    clock,
    client,
    ids,
    mappings,
    plannerFields,
  };
}

describe('VikunjaTaskRepository partial failure staging', () => {
  test('a failed relation write does not commit staged planner fields', async () => {
    const context = await setup();
    const repo = context.createRepo();
    const before = (await repo.listChangedSince(context.ownerId, null)).cursor;
    context.flags.failRelationPost = true;

    await expect(
      repo.update(
        context.ownerId,
        context.taskId,
        { priority: 4, dependsOn: [context.dependencyId] },
        1 as Version,
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    context.flags.failRelationPost = false;
    const task = await repo.get(context.ownerId, context.taskId);
    expect(task?.priority).toBe(2);
    expect(task?.version).toBe(1);
    expect(task?.dependsOn).toEqual([]);
    expect((await repo.listChangedSince(context.ownerId, before)).changes).toEqual([]);
  });

  test('a failed final GET marks the mapping and reconciles before serving', async () => {
    const context = await setup();
    const repo = context.createRepo();
    context.flags.failFinalGet = true;

    await expect(
      repo.update(
        context.ownerId,
        context.taskId,
        { title: 'Changed upstream', priority: 4 },
        1 as Version,
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);

    const stored = await context.mappings.get('task', context.taskId);
    expect(stored?.needsReconcile).toBe(true);

    const task = await repo.get(context.ownerId, context.taskId);
    expect(task?.title).toBe('Changed upstream');
    expect(task?.version).toBe(2);
    expect(task?.priority).toBe(2);

    const feed = await repo.listChangedSince(context.ownerId, null);
    // The first use of the owner seeds the epoch with a snapshot of both
    // mapped tasks (FU-15); the reconciled change is the only v2 entry.
    expect(feed.changes.map((change) => change.id).sort()).toEqual(
      [context.taskId, context.taskId, context.dependencyId].sort(),
    );
    expect(feed.changes.map((change) => change.version)).toEqual([1, 1, 2]);
    expect(feed.changes.find((change) => change.version === 2)?.id).toBe(
      context.taskId,
    );
  });
});

describe('VikunjaTaskRepository restart-safe change journal', () => {
  test('an old cursor survives a new repository instance sharing the same stores', async () => {
    const context = await setup();
    const first = context.createRepo();
    context.clock.advance(1_000);
    await first.update(context.ownerId, context.taskId, { title: 'First' }, 1 as Version);
    const oldCursor = (await first.listChangedSince(context.ownerId, null)).cursor;

    const second = context.createRepo();
    context.clock.advance(1_000);
    const updated = await second.update(
      context.ownerId,
      context.taskId,
      { title: 'After restart' },
      2 as Version,
    );
    expect(updated.version).toBe(3);

    const page = await second.listChangedSince(context.ownerId, oldCursor);
    expect(page.changes.map((change) => change.version)).toEqual([3]);
    expect(page.changes[0]?.id).toBe(context.taskId);
  });

  test('a fresh journal with preserved mappings emits a complete resync snapshot', async () => {
    const context = await setup();
    const deletedId = context.ids.next();
    await context.mappings.put({
      provider: 'vikunja',
      entityType: 'task',
      entityId: deletedId,
      externalId: '44',
      ownerId: context.ownerId,
      externalEtag: '"v1"',
      externalUpdatedAt: CREATED_AT as Instant,
      localVersion: 1 as Version,
      createdAt: context.clock.now(),
      updatedAt: context.clock.now(),
      deletedAt: context.clock.now(),
    });

    const fresh = new VikunjaTaskRepository({
      clients: new Map<Id, VikunjaClient>([[context.ownerId, context.client]]),
      mappings: context.mappings,
      plannerFields: context.plannerFields,
      journal: new InMemoryChangeJournalStore(),
      clock: context.clock,
      ids: context.ids,
    });

    const page = await fresh.listChangedSince(context.ownerId, null);
    expect(page.changes.map((change) => change.id).sort()).toEqual(
      [context.taskId, context.dependencyId, deletedId].sort(),
    );
    const deletedChange = page.changes.find((change) => change.id === deletedId);
    expect(deletedChange?.deletedAt).toBeDefined();
  });

  test('cursors are bound to the owner that issued them', async () => {
    const context = await setup();
    const repo = context.createRepo();
    const cursor = (await repo.listChangedSince(context.ownerId, null)).cursor;
    const otherOwner = context.ids.next();

    await expect(
      repo.listChangedSince(otherOwner, cursor),
    ).rejects.toBeInstanceOf(CursorInvalidatedError);
  });

  test('a cursor from a fresh epoch or beyond the head is invalidated', async () => {
    const context = await setup();
    const repo = context.createRepo();
    await repo.update(context.ownerId, context.taskId, { title: 'First' }, 1 as Version);
    const cursor = (await repo.listChangedSince(context.ownerId, null)).cursor;

    const fresh = new VikunjaTaskRepository({
      clients: new Map<Id, VikunjaClient>([[context.ownerId, context.client]]),
      mappings: context.mappings,
      plannerFields: context.plannerFields,
      journal: new InMemoryChangeJournalStore(),
      clock: context.clock,
      ids: context.ids,
    });
    await expect(
      fresh.listChangedSince(context.ownerId, cursor),
    ).rejects.toBeInstanceOf(CursorInvalidatedError);

    const legacy = Buffer.from(
      JSON.stringify({ s: 0, e: '', q: 0 }),
    ).toString('base64url');
    await expect(
      repo.listChangedSince(context.ownerId, legacy),
    ).rejects.toBeInstanceOf(CursorInvalidatedError);

    const epoch = await context.journal.epoch();
    const beyond = encodeChangeCursor({
      seconds: 0,
      remoteSeconds: 0,
      externalId: '',
      sequence: 999,
      epoch,
      owner: String(context.ownerId),
    });
    await expect(
      repo.listChangedSince(context.ownerId, beyond),
    ).rejects.toBeInstanceOf(CursorInvalidatedError);
  });
});
