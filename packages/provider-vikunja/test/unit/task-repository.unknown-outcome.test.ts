import {
  ProviderUnavailableError,
  ValidationFailedError,
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryChangeJournalStore } from '../../src/change-journal-store.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../../src/planner-field-store.js';
import { VikunjaTaskRepository } from '../../src/task-repository.js';
import { FakeHttp } from './fake-http.js';

const EXTERNAL_PROJECT = '7';
const EXTERNAL_TASK = '42';
const CREATED_AT = '2026-01-01T00:00:00Z';
const FIRST_DUE = '2026-11-20T12:00:00Z';

type PatchMode = 'ok' | 'apply-502' | 'apply-timeout' | 'reject-422';

interface State {
  etagVersion: number;
  title: string;
  description: string;
  done: boolean;
  dueDate: string;
  updated: string;
  repeatAfter: number;
  patchCount: number;
}

interface SetupOptions {
  readonly repeat?: boolean;
  readonly patchMode?: PatchMode;
}

function body(state: State, id = Number(EXTERNAL_TASK)): Record<string, unknown> {
  return {
    id,
    project_id: Number(EXTERNAL_PROJECT),
    title: state.title,
    description: state.description,
    done: state.done,
    due_date: state.dueDate,
    repeat_after: state.repeatAfter,
    repeat_mode: 0,
    created: CREATED_AT,
    updated: state.updated,
    related_tasks: {},
  };
}

function applyPatch(state: State, patch: Record<string, unknown>): void {
  if (typeof patch.title === 'string') state.title = patch.title;
  if (typeof patch.description === 'string') state.description = patch.description;
  if (typeof patch.done === 'boolean') state.done = patch.done;
  state.etagVersion += 1;
  state.updated = '2026-01-01T00:00:05Z';
  if (patch.done === true && state.repeatAfter > 0) {
    // Vikunja reopens a repeating task and advances its due date immediately.
    state.done = false;
    state.dueDate = new Date(Date.parse(state.dueDate) + 86_400_000).toISOString();
  }
}

async function setup(options: SetupOptions = {}) {
  const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
  const ids = createSeededIdGenerator(31, clock);
  const ownerId = ids.next();
  const projectId = ids.next();
  const taskId = ids.next();
  const state: State = {
    etagVersion: 1,
    title: 'Original',
    description: '',
    done: false,
    dueDate: FIRST_DUE,
    updated: CREATED_AT,
    repeatAfter: options.repeat === true ? 86_400 : 0,
    patchCount: 0,
  };
  const mode: PatchMode = options.patchMode ?? 'ok';

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
    externalEtag: '"v1"',
    externalUpdatedAt: CREATED_AT as Instant,
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
      return {
        status: 200,
        body: body(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
    }
    if (request.method === 'PATCH' && request.path === `/api/v2/tasks/${EXTERNAL_TASK}`) {
      state.patchCount += 1;
      if (mode === 'reject-422') {
        return {
          status: 422,
          body: {
            code: 2002,
            detail: 'invalid',
            errors: [{ location: 'title', message: 'invalid title' }],
          },
        };
      }
      applyPatch(state, request.body as Record<string, unknown>);
      if (mode === 'apply-502') {
        return { status: 502, body: { title: 'bad gateway' } };
      }
      if (mode === 'apply-timeout') {
        const error = new Error('timeout');
        error.name = 'AbortError';
        throw error;
      }
      return {
        status: 200,
        body: body(state),
        headers: { etag: `"v${state.etagVersion}"` },
      };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks') {
      return {
        status: 200,
        body: {
          items: [body(state)],
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

  return { repo, mappings, plannerFields, journal, state, ownerId, projectId, taskId, ids, clock };
}

describe('unknown-outcome writes', () => {
  test.each(['apply-502', 'apply-timeout'] as const)(
    'update applied then %s marks reconcile and serves the new version',
    async (patchMode) => {
      const context = await setup({ patchMode });
      const before = (await context.repo.listChangedSince(context.ownerId, null)).cursor;

      await expect(
        context.repo.update(
          context.ownerId,
          context.taskId,
          { title: 'Ghost', priority: 4 },
          1 as Version,
        ),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);

      const marked = await context.mappings.get('task', context.taskId);
      expect(marked?.needsReconcile).toBe(true);

      const task = await context.repo.get(context.ownerId, context.taskId);
      expect(task?.title).toBe('Ghost');
      expect(task?.version).toBe(2);
      expect(task?.priority).toBe(2);

      const feed = await context.repo.listChangedSince(context.ownerId, before);
      expect(feed.changes.map((change) => change.version)).toEqual([2]);
    },
  );

  test('a definitive 4xx write does not mark reconcile or bump the version', async () => {
    const context = await setup({ patchMode: 'reject-422' });
    const before = (await context.repo.listChangedSince(context.ownerId, null)).cursor;

    await expect(
      context.repo.update(
        context.ownerId,
        context.taskId,
        { title: 'Rejected' },
        1 as Version,
      ),
    ).rejects.toBeInstanceOf(ValidationFailedError);

    const mapping = await context.mappings.get('task', context.taskId);
    expect(mapping?.needsReconcile).not.toBe(true);
    expect(mapping?.localVersion).toBe(1);
    expect(await context.repo.get(context.ownerId, context.taskId)).toMatchObject({
      title: 'Original',
      version: 1,
    });
    expect((await context.repo.listChangedSince(context.ownerId, before)).changes).toEqual([]);
  });

  test.each(['apply-502', 'apply-timeout'] as const)(
    'recurring complete applied then %s emits one completedOccurrenceAt and blocks retry',
    async (patchMode) => {
      const context = await setup({ repeat: true, patchMode });
      // A reconciled completion must apply the same status rule as the normal
      // path instead of leaving a stale in_progress value (FU-17).
      context.plannerFields.putTask(context.taskId, {
        splittable: false,
        priority: 2,
        status: 'in_progress',
        dependsOn: [],
      });
      const before = (await context.repo.listChangedSince(context.ownerId, null)).cursor;

      await expect(
        context.repo.complete(context.ownerId, context.taskId, 1 as Version),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);

      const pending = await context.mappings.get('task', context.taskId);
      expect(pending?.pendingCompletion).toBeDefined();
      expect(pending?.needsReconcile).toBe(true);

      const conflict = await context.repo
        .complete(context.ownerId, context.taskId, 1 as Version)
        .catch((error: unknown) => error);
      expect(conflict).toBeInstanceOf(VersionConflictError);
      expect((conflict as VersionConflictError).actual).toBe(2);
      expect(context.state.patchCount).toBe(1);

      const feed = await context.repo.listChangedSince(context.ownerId, before);
      expect(feed.changes.map((change) => change.version)).toEqual([2]);
      // The completion record names the occurrence that was completed, not the
      // reconciliation/completion time (FU-17).
      expect(feed.changes[0]?.completedOccurrenceAt).toBe(
        epochMsToInstant(Date.parse(FIRST_DUE)),
      );

      const task = await context.repo.get(context.ownerId, context.taskId);
      expect(task?.status).toBe('todo');
      expect(task?.version).toBe(2);
      expect(task?.dueAt).toBe(
        new Date(Date.parse(FIRST_DUE) + 86_400_000).toISOString(),
      );
    },
  );

  test('the normal recurring completion records the completed occurrence dueAt', async () => {
    const context = await setup({ repeat: true });

    await context.repo.complete(context.ownerId, context.taskId, 1 as Version);

    const feed = await context.repo.listChangedSince(context.ownerId, null);
    const completion = feed.changes.find((change) => change.version === 2);
    expect(completion?.completedOccurrenceAt).toBe(
      epochMsToInstant(Date.parse(FIRST_DUE)),
    );
  });

  test('a definitive complete 4xx clears the intent without a reconcile mark or version bump', async () => {
    const context = await setup({ repeat: true, patchMode: 'reject-422' });

    await expect(
      context.repo.complete(context.ownerId, context.taskId, 1 as Version),
    ).rejects.toBeInstanceOf(ValidationFailedError);

    const mapping = await context.mappings.get('task', context.taskId);
    expect(mapping?.pendingCompletion).toBeUndefined();
    expect(mapping?.needsReconcile).not.toBe(true);
    expect(mapping?.localVersion).toBe(1);
    expect(context.state.patchCount).toBe(1);
  });

  test('an external ETag drift is reconciled before reporting the conflict version', async () => {
    const context = await setup();
    context.state.etagVersion = 2;
    context.state.title = 'External edit';
    context.state.updated = '2026-01-01T00:00:06Z';

    const conflict = await context.repo
      .update(context.ownerId, context.taskId, { title: 'Mine' }, 1 as Version)
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(VersionConflictError);
    expect((conflict as VersionConflictError).actual).toBe(2);
    expect((await context.mappings.get('task', context.taskId))?.localVersion).toBe(2);
  });
});

describe('create with a failed follow-up GET', () => {
  test('persists a needsReconcile mapping instead of orphaning the created task', async () => {
    const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
    const ids = createSeededIdGenerator(41, clock);
    const ownerId = ids.next();
    const projectId = ids.next();
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

    const createdTask = {
      id: 99,
      project_id: Number(EXTERNAL_PROJECT),
      title: 'Created upstream',
      description: '',
      done: false,
      due_date: '0001-01-01T00:00:00Z',
      created: CREATED_AT,
      updated: CREATED_AT,
      related_tasks: {},
    };
    const http = new FakeHttp((request) => {
      if (
        request.method === 'POST' &&
        request.path === `/api/v2/projects/${EXTERNAL_PROJECT}/tasks`
      ) {
        return { status: 201, body: createdTask };
      }
      if (request.method === 'GET' && request.path === '/api/v2/tasks/99') {
        return { status: 503, body: { title: 'unavailable' } };
      }
      return { status: 404, body: { code: 4002, detail: 'not found' } };
    });
    const client = new VikunjaClient({
      baseUrl: 'http://vikunja.test',
      token: 'tk_test',
      fetch: http.fetch,
      sleep: async () => {},
    });
    const repo = new VikunjaTaskRepository({
      clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
      mappings,
      plannerFields,
      clock,
      ids,
    });

    const created = await repo.create(
      ownerId,
      { projectId, title: 'Created upstream' },
      'create-follow-up-failure',
    );

    const mapping = await mappings.get('task', created.id);
    expect(mapping?.externalId).toBe('99');
    expect(mapping?.needsReconcile).toBe(true);
  });
});
