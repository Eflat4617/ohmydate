import {
  ProviderUnavailableError,
  epochMsToInstant,
  type Id,
  type Instant,
  type TaskStatus,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryChangeJournalStore } from '../../src/change-journal-store.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import {
  InMemoryPlannerFieldStore,
  type PlannerTaskFields,
} from '../../src/planner-field-store.js';
import { VikunjaTaskRepository } from '../../src/task-repository.js';
import { FakeHttp, type FakeRequest } from './fake-http.js';

const EXTERNAL_PROJECT = 7;
const BASE_MS = Date.parse('2026-01-01T00:00:00Z');
const NO_DUE = '0001-01-01T00:00:00Z';

function atSeconds(offsetSeconds: number): string {
  return new Date(BASE_MS + offsetSeconds * 1000).toISOString();
}

interface RemoteTask {
  id: number;
  projectId: number;
  title: string;
  description: string;
  done: boolean;
  dueDate: string;
  updated: string;
  deletedAt?: string;
  dependencies: readonly number[];
}

function remoteTask(
  id: number,
  updatedOffset: number,
  overrides: Partial<RemoteTask> = {},
): RemoteTask {
  return {
    id,
    projectId: EXTERNAL_PROJECT,
    title: `Task ${id}`,
    description: '',
    done: false,
    dueDate: NO_DUE,
    updated: atSeconds(updatedOffset),
    dependencies: [],
    ...overrides,
  };
}

interface HarnessServer {
  readonly tasks: Map<number, RemoteTask>;
  nextTaskId: number;
  createUpdated: string;
  failTaskGets: number;
  failPatchAfterApply?: '502' | 'timeout';
  nextPatchUpdated?: (task: RemoteTask) => string;
  beforeListResponse?: (() => Promise<void>) | undefined;
  deletedAt?: string;
}

/**
 * Minimal Vikunja double with the semantics the change feed depends on:
 * second-precision ETags (two writes in one second share an ETag), an
 * `updated >= ...` list filter, and a snapshot hook that runs after the scan
 * response has been captured so an edit can land "during a poll".
 */
function createHandler(server: HarnessServer) {
  return (request: FakeRequest) => {
    const taskMatch = /^\/api\/v2\/tasks\/(\d+)$/.exec(request.path);
    if (request.method === 'GET' && taskMatch !== null) {
      if (server.failTaskGets > 0) {
        server.failTaskGets -= 1;
        return { status: 503, body: { title: 'unavailable' } };
      }
      const task = server.tasks.get(Number(taskMatch[1]));
      if (task === undefined || task.deletedAt !== undefined) {
        return { status: 404, body: { code: 4002, detail: 'not found' } };
      }
      return { status: 200, body: taskBody(task), headers: { etag: etag(task) } };
    }
    if (request.method === 'PATCH' && taskMatch !== null) {
      const task = server.tasks.get(Number(taskMatch[1]));
      if (task === undefined) return { status: 404, body: { code: 4002 } };
      const patch = request.body as Record<string, unknown>;
      if (typeof patch.title === 'string') task.title = patch.title;
      if (typeof patch.description === 'string') task.description = patch.description;
      if (typeof patch.done === 'boolean') task.done = patch.done;
      if (typeof patch.due_date === 'string') task.dueDate = patch.due_date;
      task.updated =
        server.nextPatchUpdated === undefined
          ? atSeconds(Math.floor((Date.parse(task.updated) - BASE_MS) / 1000) + 5)
          : server.nextPatchUpdated(task);
      if (server.failPatchAfterApply === '502') {
        return { status: 502, body: { title: 'bad gateway' } };
      }
      if (server.failPatchAfterApply === 'timeout') {
        const error = new Error('timeout');
        error.name = 'AbortError';
        throw error;
      }
      return { status: 200, body: taskBody(task), headers: { etag: etag(task) } };
    }
    if (request.method === 'DELETE' && taskMatch !== null) {
      const task = server.tasks.get(Number(taskMatch[1]));
      if (task !== undefined) task.deletedAt = server.deletedAt ?? task.updated;
      return { status: 200, body: {} };
    }
    const createMatch = /^\/api\/v2\/projects\/(\d+)\/tasks$/.exec(request.path);
    if (request.method === 'POST' && createMatch !== null) {
      const body = request.body as Record<string, unknown>;
      const task: RemoteTask = {
        id: server.nextTaskId,
        projectId: Number(createMatch[1]),
        title: String(body.title),
        description:
          typeof body.description === 'string' ? body.description : '',
        done: body.done === true,
        dueDate:
          typeof body.due_date === 'string' ? body.due_date : NO_DUE,
        updated: server.createUpdated,
        dependencies: [],
      };
      server.nextTaskId += 1;
      server.tasks.set(task.id, task);
      return { status: 201, body: taskBody(task) };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks') {
      const threshold = filterThreshold(request.url);
      const items = [...server.tasks.values()]
        .filter(
          (task) =>
            task.deletedAt === undefined && Date.parse(task.updated) >= threshold,
        )
        .sort((left, right) => Date.parse(left.updated) - Date.parse(right.updated))
        .map(taskBody);
      if (server.beforeListResponse !== undefined) {
        const hook = server.beforeListResponse;
        server.beforeListResponse = undefined;
        return hook().then(() => ({
          status: 200,
          body: page(items),
        }));
      }
      return { status: 200, body: page(items) };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks/deleted') {
      const items = [...server.tasks.values()]
        .filter((task) => task.deletedAt !== undefined)
        .map((task) => ({
          ...taskBody(task),
          deleted_at: task.deletedAt,
        }));
      return { status: 200, body: page(items) };
    }
    return { status: 404, body: { code: 4002, detail: 'not found' } };
  };
}

function filterThreshold(url: string): number {
  const filter = new URL(url).searchParams.get('filter') ?? '';
  const match = /updated >= "([^"]+)"/.exec(filter);
  return match === null ? 0 : Date.parse(match[1] ?? '');
}

function etag(task: RemoteTask): string {
  // Live Vikunja: `<updated second>-<constant>`. Two writes in the same second
  // share this value, which is exactly why FU-16 needs a content fingerprint.
  return `"${Math.floor(Date.parse(task.updated) / 1000)}-2"`;
}

function taskBody(task: RemoteTask): Record<string, unknown> {
  const blocked = task.dependencies.map((id) => ({
    id,
    project_id: task.projectId,
    title: `Dependency ${id}`,
    description: '',
    done: false,
    due_date: NO_DUE,
    created: atSeconds(0),
    updated: atSeconds(0),
  }));
  return {
    id: task.id,
    project_id: task.projectId,
    title: task.title,
    description: task.description,
    done: task.done,
    due_date: task.dueDate,
    created: atSeconds(0),
    updated: task.updated,
    related_tasks: blocked.length === 0 ? {} : { blocked },
  };
}

function page(items: readonly Record<string, unknown>[]) {
  return {
    items,
    total: items.length,
    page: 1,
    per_page: 50,
    total_pages: 1,
  };
}

interface HarnessOptions {
  readonly tasks?: readonly RemoteTask[];
  readonly seedTaskMappings?: boolean;
  readonly clockStart?: string;
  readonly plannerStatus?: TaskStatus;
}

async function setup(options: HarnessOptions = {}) {
  const clock = new FakeClock(
    epochMsToInstant(Date.parse(options.clockStart ?? atSeconds(0))),
  );
  const ids = createSeededIdGenerator(101, clock);
  const ownerId = ids.next();
  const projectId = ids.next();
  const taskIds = new Map<number, Id>();
  for (const task of options.tasks ?? []) {
    taskIds.set(task.id, ids.next());
  }

  const mappings = new InMemoryMappingStore();
  const plannerFields = new InMemoryPlannerFieldStore();
  const journal = new InMemoryChangeJournalStore();
  await mappings.put({
    provider: 'vikunja',
    entityType: 'project',
    entityId: projectId,
    externalId: String(EXTERNAL_PROJECT),
    ownerId,
    localVersion: 1 as Version,
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });

  const server: HarnessServer = {
    tasks: new Map((options.tasks ?? []).map((task) => [task.id, { ...task }])),
    nextTaskId: 900,
    createUpdated: atSeconds(0),
    failTaskGets: 0,
  };

  if (options.seedTaskMappings !== false) {
    for (const task of options.tasks ?? []) {
      const entityId = taskIds.get(task.id);
      if (entityId === undefined) continue;
      await mappings.put({
        provider: 'vikunja',
        entityType: 'task',
        entityId,
        externalId: String(task.id),
        ownerId,
        externalEtag: etag(task),
        externalUpdatedAt: task.updated as Instant,
        localVersion: 1 as Version,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      });
      const fields: PlannerTaskFields = {
        splittable: false,
        priority: 2,
        status: options.plannerStatus ?? 'todo',
        dependsOn: [],
      };
      plannerFields.putTask(entityId, fields);
    }
  }

  const http = new FakeHttp(createHandler(server));
  const client = new VikunjaClient({
    baseUrl: 'http://vikunja.test',
    token: 'tk_test',
    fetch: http.fetch,
    retries: 0,
    sleep: async () => {},
  });

  const createRepo = (store: InMemoryChangeJournalStore = journal) =>
    new VikunjaTaskRepository({
      clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
      mappings,
      plannerFields,
      journal: store,
      clock,
      ids,
    });

  return {
    createRepo,
    repository: createRepo(),
    journal,
    server,
    mappings,
    plannerFields,
    clock,
    ids,
    ownerId,
    projectId,
    taskIds,
    client,
  };
}

describe('FU-14 remote watermark comes from the Vikunja scan', () => {
  test('an external edit landing after the poll scan is delivered exactly once', async () => {
    const context = await setup({
      tasks: [remoteTask(42, 0), remoteTask(43, 0)],
    });
    const taskA = context.taskIds.get(42) as Id;
    const taskB = context.taskIds.get(43) as Id;

    const initial = await context.repository.listChangedSince(context.ownerId, null);
    expect(initial.changes.map((change) => change.id).sort()).toEqual(
      [taskA, taskB].sort(),
    );

    // A normal planner write. Its ETag/updated is a remote time.
    await context.repository.update(
      context.ownerId,
      taskA,
      { title: 'A first' },
      1 as Version,
    );
    const poll1 = await context.repository.listChangedSince(
      context.ownerId,
      initial.cursor,
    );
    expect(poll1.changes.map((change) => change.id)).toEqual([taskA]);
    expect(poll1.changes[0]?.version).toBe(2);

    // B's edit lands after the next scan response is captured, while a planner
    // write to A is journaled even later (planner-clock independent).
    context.server.beforeListResponse = async () => {
      const taskBState = context.server.tasks.get(43) as RemoteTask;
      taskBState.title = 'B-external';
      taskBState.updated = atSeconds(6);
      await context.repository.update(
        context.ownerId,
        taskA,
        { title: 'A second' },
        2 as Version,
      );
    };
    const poll2 = await context.repository.listChangedSince(
      context.ownerId,
      poll1.cursor,
    );
    expect(poll2.changes.map((change) => `${change.id}:${change.version}`)).toEqual([
      `${taskA}:3`,
    ]);

    const poll3 = await context.repository.listChangedSince(
      context.ownerId,
      poll2.cursor,
    );
    expect(poll3.changes.map((change) => `${change.id}:${change.version}`)).toEqual([
      `${taskB}:2`,
    ]);
    const poll4 = await context.repository.listChangedSince(
      context.ownerId,
      poll3.cursor,
    );
    expect(poll4.changes).toEqual([]);

    const external = await context.repository.get(context.ownerId, taskB);
    expect(external?.title).toBe('B-external');
    expect(external?.version).toBe(2);
  });

  test('a planner clock 60s ahead cannot step the feed over a later external edit', async () => {
    const context = await setup({
      tasks: [remoteTask(42, 0), remoteTask(43, 0)],
      clockStart: atSeconds(60),
    });
    const taskA = context.taskIds.get(42) as Id;
    const taskB = context.taskIds.get(43) as Id;

    const initial = await context.repository.listChangedSince(context.ownerId, null);
    await context.repository.softDelete(context.ownerId, taskA, 1 as Version);

    const poll1 = await context.repository.listChangedSince(
      context.ownerId,
      initial.cursor,
    );
    expect(poll1.changes.map((change) => `${change.id}:${change.version}`)).toEqual([
      `${taskA}:2`,
    ]);
    expect(poll1.changes[0]?.deletedAt).toBeDefined();

    // Remote time is well behind the planner clock but after the remote
    // watermark carried by the cursor.
    const taskBState = context.server.tasks.get(43) as RemoteTask;
    taskBState.title = 'B-late';
    taskBState.updated = atSeconds(30);

    const poll2 = await context.repository.listChangedSince(
      context.ownerId,
      poll1.cursor,
    );
    expect(poll2.changes.map((change) => `${change.id}:${change.version}`)).toEqual([
      `${taskB}:2`,
    ]);
    expect(
      (await context.repository.listChangedSince(context.ownerId, poll2.cursor))
        .changes,
    ).toEqual([]);
    expect((await context.repository.get(context.ownerId, taskB))?.title).toBe(
      'B-late',
    );
  });
});

describe('FU-15 fresh-epoch snapshot on first use of an owner', () => {
  test('a write after rebuild does not hide earlier mappings from a null resync', async () => {
    const context = await setup({
      tasks: [remoteTask(42, 0), remoteTask(43, 0)],
    });
    const taskA = context.taskIds.get(42) as Id;
    const taskB = context.taskIds.get(43) as Id;

    await context.repository.update(
      context.ownerId,
      taskA,
      { title: 'A v2' },
      1 as Version,
    );

    const rebuilt = context.createRepo(new InMemoryChangeJournalStore());
    const updatedB = await rebuilt.update(
      context.ownerId,
      taskB,
      { title: 'B v2' },
      1 as Version,
    );
    expect(updatedB.version).toBe(2);

    const page = await rebuilt.listChangedSince(context.ownerId, null);
    const aChanges = page.changes.filter((change) => change.id === taskA);
    expect(aChanges.map((change) => change.version)).toEqual([2]);
    expect(
      page.changes
        .filter((change) => change.id === taskB)
        .map((change) => change.version),
    ).toEqual([1, 2]);
    expect((await rebuilt.get(context.ownerId, taskA))?.version).toBe(2);
  });

  test('concurrent null polls on a fresh journal emit the snapshot once', async () => {
    const context = await setup({
      tasks: [remoteTask(42, 0), remoteTask(43, 0)],
    });
    const taskA = context.taskIds.get(42) as Id;
    const taskB = context.taskIds.get(43) as Id;

    const [first, second] = await Promise.all([
      context.repository.listChangedSince(context.ownerId, null),
      context.repository.listChangedSince(context.ownerId, null),
    ]);

    expect(await context.journal.head(context.ownerId)).toBe(2);
    for (const page of [first, second]) {
      expect(page.changes.map((change) => change.id).sort()).toEqual(
        [taskA, taskB].sort(),
      );
      expect(page.changes.map((change) => change.version)).toEqual([1, 1]);
    }
  });
});

describe('FU-16 content fingerprint', () => {
  test('a same-second lost-response update is still delivered', async () => {
    const context = await setup({ seedTaskMappings: false });
    const created = await context.repository.create(
      context.ownerId,
      { projectId: context.projectId, title: 'S1' },
      'create-s1',
    );
    const before = (
      await context.repository.listChangedSince(context.ownerId, null)
    ).cursor;

    // The provider keeps the same updated second, therefore the same ETag.
    context.server.nextPatchUpdated = () => atSeconds(0);
    context.server.failPatchAfterApply = '502';
    await expect(
      context.repository.update(
        context.ownerId,
        created.id,
        { title: 'S2-ghost' },
        1 as Version,
      ),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect((await context.mappings.get('task', created.id))?.needsReconcile).toBe(
      true,
    );

    const task = await context.repository.get(context.ownerId, created.id);
    expect(task?.title).toBe('S2-ghost');
    expect(task?.version).toBe(2);

    const feed = await context.repository.listChangedSince(
      context.ownerId,
      before,
    );
    expect(feed.changes.map((change) => change.version)).toEqual([2]);
  });
});

describe('FU-17 follow-up lows', () => {
  test('a failed create follow-up adopts the first ETag without a version bump', async () => {
    const context = await setup({ seedTaskMappings: false });
    context.server.failTaskGets = 1;

    const created = await context.repository.create(
      context.ownerId,
      { projectId: context.projectId, title: 'Created' },
      'create-follow-up',
    );
    const pending = await context.mappings.get('task', created.id);
    expect(pending?.needsReconcile).toBe(true);
    expect(pending?.externalEtag).toBeUndefined();

    const task = await context.repository.get(context.ownerId, created.id);
    expect(task?.version).toBe(1);
    const adopted = await context.mappings.get('task', created.id);
    expect(adopted?.externalEtag).toBeDefined();
    expect(adopted?.needsReconcile).toBe(false);

    const feed = await context.repository.listChangedSince(context.ownerId, null);
    expect(feed.changes.map((change) => `${change.id}:${change.version}`)).toEqual([
      `${created.id}:1`,
    ]);
  });
});
