import {
  ProviderUnavailableError,
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator, describeTaskRepositoryContract } from '@ohmydate/testkit';
import { VikunjaClient, type FetchLike } from '../src/client.js';
import { InMemoryMappingStore } from '../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../src/planner-field-store.js';
import { VikunjaProjectRepository } from '../src/project-repository.js';
import { VikunjaTaskRepository } from '../src/task-repository.js';
import { normalizeRemoteInstant } from '../src/time.js';
import { appendMarker } from '../src/marker.js';
import { createSyntheticUser, purgeUserData, type LiveUser } from './live-support.js';

const baseUrl = process.env.VIKUNJA_URL;

if (baseUrl === undefined || baseUrl.length === 0) {
  describe('VikunjaTaskRepository contract (live v2.8.0)', () => {
    test('SKIPPED: set VIKUNJA_URL=http://127.0.0.1:3456 to run the live contract suite', (context) => {
      context.skip();
    });
  });
} else {
  const liveUrl: string = baseUrl;
  let usersPromise: Promise<readonly [LiveUser, LiveUser]> | undefined;

  function users(): Promise<readonly [LiveUser, LiveUser]> {
    usersPromise ??= Promise.all([
      createSyntheticUser(liveUrl),
      createSyntheticUser(liveUrl),
    ]).then(([first, second]) => [first, second] as const);
    return usersPromise;
  }

  /** Sleep until just after the next wall-clock second boundary. */
  async function waitForSecondStart(): Promise<void> {
    const now = Date.now();
    const target = Math.ceil((now + 5) / 1000) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, target - now) + 5));
  }

  /**
   * Real fetch wrapper that lets the next PATCH reach Vikunja (so the write is
   * applied) and then reports the outcome as lost, modelling the R2 HIGH
   * applied-then-timeout case on the live server.
   */
  function lostResponseFetch(real: FetchLike): { fetch: FetchLike; arm: () => void } {
    let armed = false;
    return {
      arm: () => {
        armed = true;
      },
      fetch: async (input, init) => {
        const response = await real(input, init);
        if (armed && (init?.method ?? 'GET') === 'PATCH') {
          armed = false;
          const error = new Error('timeout');
          error.name = 'AbortError';
          throw error;
        }
        return response;
      },
    };
  }

  describeTaskRepositoryContract(
    `VikunjaTaskRepository (live ${liveUrl})`,
    async () => {
      const [userA, userB] = await users();
      const clock = new FakeClock();
      const ids = createSeededIdGenerator(20261111, clock);
      const ownerA = ids.next();
      const ownerB = ids.next();
      const mappings = new InMemoryMappingStore();
      const plannerFields = new InMemoryPlannerFieldStore();
      const clients = new Map<Id, VikunjaClient>([
        [ownerA, userA.client],
        [ownerB, userB.client],
      ]);

      return {
        repo: new VikunjaTaskRepository({ clients, mappings, plannerFields, clock, ids }),
        projects: new VikunjaProjectRepository({ clients, mappings, clock, ids }),
        clock,
        ids,
        ownerA,
        ownerB,
        cleanup: async () => {
          await purgeUserData(userA.client, mappings, ownerA);
          await purgeUserData(userB.client, mappings, ownerB);
        },
      };
    },
  );

  describe('Vikunja recurring completion (live)', () => {
    test('records completedOccurrenceAt and reflects the provider-reopened task', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(7, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const taskId = ids.next();
      const mappings = new InMemoryMappingStore();
      const plannerFields = new InMemoryPlannerFieldStore();
      const remoteProject = await user.client.createProject('M1-05 recurring completion');
      let remoteTaskId: string | undefined;
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const created = await user.client.createTask(String(remoteProject.id), {
          title: 'Repeating task',
          due_date: '2026-11-20T12:00:00Z',
          repeat_after: 86_400,
          repeat_mode: 0,
        });
        remoteTaskId = String(created.id);
        const loaded = await user.client.getTask(remoteTaskId);
        const remoteUpdatedAt = normalizeRemoteInstant(loaded.data.updated);
        await mappings.put({
          provider: 'vikunja',
          entityType: 'task',
          entityId: taskId,
          externalId: remoteTaskId,
          ownerId,
          ...(loaded.etag === null ? {} : { externalEtag: loaded.etag }),
          ...(remoteUpdatedAt === undefined
            ? {}
            : { externalUpdatedAt: remoteUpdatedAt as Instant }),
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

        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, user.client]]),
          mappings,
          plannerFields,
          clock,
          ids,
        });

        const before = await repo.get(ownerId, taskId);
        expect(before?.status).toBe('todo');
        expect(before?.dueAt).toBeDefined();

        const completed = await repo.complete(ownerId, taskId, 1 as Version);
        expect(completed.version).toBe(2);
        expect(completed.status).toBe('todo');
        expect(completed.dueAt).not.toBe(before?.dueAt);
        expect(Date.parse(completed.dueAt as string)).toBe(
          Date.parse(before?.dueAt as string) + 86_400_000,
        );

        const feed = await repo.listChangedSince(ownerId, null);
        // The first use of the owner also seeds the v1 snapshot (FU-15); the
        // completion is the v2 entry for the task.
        const completion = feed.changes.find(
          (change) => change.id === taskId && change.version === 2,
        );
        expect(completion?.version).toBe(2);
        expect(completion?.completedOccurrenceAt).toBe(before?.dueAt);
      } finally {
        // Best-effort cleanup; cleanup failures must not mask the test result.
        if (remoteTaskId !== undefined) {
          await user.client.deleteTask(remoteTaskId).catch(() => undefined);
          await user.client.permanentDeleteTask(remoteTaskId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    });
  });

  describe('Vikunja same-second lost response (live)', () => {
    test('a content fingerprint detects an applied-then-lost update that reused the ETag', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(20261112, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const mappings = new InMemoryMappingStore();
      const plannerFields = new InMemoryPlannerFieldStore();
      const remoteProject = await user.client.createProject('FU-16 same-second');
      let remoteTaskId: string | undefined;
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const wrapped = lostResponseFetch((input, init) =>
          globalThis.fetch(input, init),
        );
        const wrappedClient = new VikunjaClient({
          baseUrl: liveUrl,
          token: user.token,
          fetch: wrapped.fetch,
          retries: 0,
          sleep: async () => {},
        });
        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, wrappedClient]]),
          mappings,
          plannerFields,
          clock,
          ids,
        });

        const created = await repo.create(
          ownerId,
          { projectId, title: 'S1' },
          'fu16-live-same-second',
        );
        remoteTaskId = created.external?.[0]?.externalId;
        expect(remoteTaskId).toBeDefined();

        let confirmed = false;
        for (let attempt = 1; attempt <= 8 && !confirmed; attempt += 1) {
          await waitForSecondStart();
          const current = await repo.get(ownerId, created.id);
          expect(current).not.toBeNull();
          const first = await repo.update(
            ownerId,
            created.id,
            { title: `S1-${attempt}` },
            (current as { version: Version }).version,
          );
          const storedEtag = (await mappings.get('task', created.id))?.externalEtag;
          expect(storedEtag).toBeDefined();

          wrapped.arm();
          await expect(
            repo.update(
              ownerId,
              created.id,
              { title: `S2-ghost-${attempt}` },
              first.version,
            ),
          ).rejects.toBeInstanceOf(ProviderUnavailableError);

          const remote = await user.client.getTask(remoteTaskId as string);
          if (remote.etag === storedEtag) {
            // Same second => same ETag. Only the content fingerprint can tell
            // that the provider state changed.
            confirmed = true;
            const reconciled = await repo.get(ownerId, created.id);
            expect(reconciled?.title).toBe(`S2-ghost-${attempt}`);
            expect(reconciled?.version).toBe(first.version + 1);

            const feed = await repo.listChangedSince(ownerId, null);
            const change = feed.changes.find(
              (entry) =>
                entry.id === created.id && entry.version === first.version + 1,
            );
            expect(change).toBeDefined();
          }
        }
        expect(confirmed).toBe(true);
      } finally {
        if (remoteTaskId !== undefined) {
          await user.client.deleteTask(remoteTaskId).catch(() => undefined);
          await user.client.permanentDeleteTask(remoteTaskId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    });
  });

  describe('Vikunja create with dependencies (live)', () => {
    test('returns v1 and the first write at v1 succeeds without a phantom bump', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(20261113, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const mappings = new InMemoryMappingStore();
      const plannerFields = new InMemoryPlannerFieldStore();
      const remoteProject = await user.client.createProject('FU-14R dependencies');
      const remoteTaskIds: string[] = [];
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, user.client]]),
          mappings,
          plannerFields,
          clock,
          ids,
        });

        const dependency = await repo.create(
          ownerId,
          { projectId, title: 'Dependency' },
          'live-dep-dependency',
        );
        remoteTaskIds.push(dependency.external?.[0]?.externalId as string);
        const forUpdate = await repo.create(
          ownerId,
          { projectId, title: 'For update', dependsOn: [dependency.id] },
          'live-dep-update',
        );
        remoteTaskIds.push(forUpdate.external?.[0]?.externalId as string);
        const forComplete = await repo.create(
          ownerId,
          { projectId, title: 'For complete', dependsOn: [dependency.id] },
          'live-dep-complete',
        );
        remoteTaskIds.push(forComplete.external?.[0]?.externalId as string);
        const forDelete = await repo.create(
          ownerId,
          { projectId, title: 'For delete', dependsOn: [dependency.id] },
          'live-dep-delete',
        );
        remoteTaskIds.push(forDelete.external?.[0]?.externalId as string);

        for (const task of [forUpdate, forComplete, forDelete]) {
          expect(task.version).toBe(1);
          expect(task.dependsOn).toEqual([dependency.id]);
        }

        const feed = await repo.listChangedSince(ownerId, null);
        for (const task of [forUpdate, forComplete, forDelete]) {
          expect(
            feed.changes
              .filter((change) => change.id === task.id)
              .map((change) => change.version),
          ).toEqual([1]);
        }

        const updated = await repo.update(
          ownerId,
          forUpdate.id,
          { title: 'For update 2' },
          forUpdate.version,
        );
        expect(updated.version).toBe(2);

        const completed = await repo.complete(ownerId, forComplete.id, forComplete.version);
        expect(completed.version).toBe(2);

        await repo.softDelete(ownerId, forDelete.id, forDelete.version);
        expect(await repo.get(ownerId, forDelete.id)).toBeNull();
      } finally {
        for (const externalId of remoteTaskIds) {
          await user.client.deleteTask(externalId).catch(() => undefined);
          await user.client.permanentDeleteTask(externalId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    });
  });

  describe('Vikunja relation touch in a later second (live, FU-73)', () => {
    test('own relation writes never bump even when the async touch lands a second later; a remote edit still does', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(20261173, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const mappings = new InMemoryMappingStore();
      const remoteProject = await user.client.createProject('FU-73 relation touch');
      const remoteTaskIds: string[] = [];
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        // Vikunja touches the base task's `updated` from an asynchronous
        // listener after a relation write returns. Starting every relation
        // write just after a second boundary forces that touch into a later
        // second than the adapter's preceding read: the case a loaded CI host
        // only hit by chance.
        const boundaryFetch: FetchLike = async (input, init) => {
          if (/\/relations(\/|$)/.test(new URL(input).pathname)) await waitForSecondStart();
          return globalThis.fetch(input, init);
        };
        const client = new VikunjaClient({
          baseUrl: liveUrl,
          token: user.token,
          fetch: boundaryFetch,
        });
        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, client]]),
          mappings,
          plannerFields: new InMemoryPlannerFieldStore(),
          clock,
          ids,
        });
        const versionsOf = async (taskId: Id): Promise<Version[]> =>
          (await repo.listChangedSince(ownerId, null)).changes
            .filter((change) => change.id === taskId)
            .map((change) => change.version);

        const first = await repo.create(ownerId, { projectId, title: 'First' }, 'fu73-first');
        remoteTaskIds.push(first.external?.[0]?.externalId as string);
        const second = await repo.create(ownerId, { projectId, title: 'Second' }, 'fu73-second');
        remoteTaskIds.push(second.external?.[0]?.externalId as string);
        const task = await repo.create(
          ownerId,
          { projectId, title: 'Blocked', dependsOn: [first.id] },
          'fu73-blocked',
        );
        const externalId = task.external?.[0]?.externalId as string;
        remoteTaskIds.push(externalId);
        expect(task.version).toBe(1);

        // Once while the touch may still be in flight, once after it landed.
        expect(await versionsOf(task.id)).toEqual([1]);
        await pause(1_500);
        expect(await versionsOf(task.id)).toEqual([1]);

        // Delete + create relation, each in a later second than the last read.
        const moved = await repo.update(
          ownerId,
          task.id,
          { dependsOn: [second.id] },
          task.version,
        );
        expect(moved.version).toBe(2);
        await pause(1_500);
        expect(await versionsOf(task.id)).toEqual([1, 2]);
        const loaded = await repo.get(ownerId, task.id);
        expect(loaded?.version).toBe(2);
        expect(loaded?.dependsOn).toEqual([second.id]);
        expect(await versionsOf(first.id)).toEqual([1]);
        expect(await versionsOf(second.id)).toEqual([1]);

        // Negative: a genuine edit by another Vikunja client still bumps, even
        // right after the adapter's own relation writes.
        await user.client.patchTask(externalId, { title: 'Edited in Vikunja' });
        expect(await versionsOf(task.id)).toEqual([1, 2, 3]);
        await expect(
          repo.update(ownerId, task.id, { title: 'stale' }, moved.version),
        ).rejects.toBeInstanceOf(VersionConflictError);
      } finally {
        for (const externalId of remoteTaskIds) {
          await user.client.deleteTask(externalId).catch(() => undefined);
          await user.client.permanentDeleteTask(externalId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    }, 30_000);
  });

  describe('Vikunja no-op PATCH (live)', () => {
    test('treats a 304 status-only update as a planner change, not an outage', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(20261114, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const mappings = new InMemoryMappingStore();
      const plannerFields = new InMemoryPlannerFieldStore();
      const remoteProject = await user.client.createProject('FU-14R 304');
      let remoteTaskId: string | undefined;
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const patchStatuses: number[] = [];
        const recordingFetch: FetchLike = async (input, init) => {
          const response = await globalThis.fetch(input, init);
          if ((init?.method ?? 'GET') === 'PATCH') {
            patchStatuses.push(response.status);
          }
          return response;
        };
        const recordingClient = new VikunjaClient({
          baseUrl: liveUrl,
          token: user.token,
          fetch: recordingFetch,
          retries: 0,
          sleep: async () => {},
        });
        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, recordingClient]]),
          mappings,
          plannerFields,
          clock,
          ids,
        });

        const created = await repo.create(
          ownerId,
          { projectId, title: 'Status only' },
          'live-304-create',
        );
        remoteTaskId = created.external?.[0]?.externalId;

        const updated = await repo.update(
          ownerId,
          created.id,
          { status: 'in_progress' },
          created.version,
        );
        expect(patchStatuses).toEqual([304]);
        expect(updated.version).toBe(2);
        expect(updated.status).toBe('in_progress');
      } finally {
        if (remoteTaskId !== undefined) {
          await user.client.deleteTask(remoteTaskId).catch(() => undefined);
          await user.client.permanentDeleteTask(remoteTaskId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    });
  });

  describe('Vikunja Inbox adoption (live)', () => {
    test('serves exactly one Inbox after the default project is trashed', async () => {
      const user = await createSyntheticUser(liveUrl);
      const clock = new FakeClock();
      const ids = createSeededIdGenerator(99, clock);
      const ownerId = ids.next();
      const mappings = new InMemoryMappingStore();
      const repo = new VikunjaProjectRepository({
        clients: new Map<Id, VikunjaClient>([[ownerId, user.client]]),
        mappings,
        clock,
        ids,
      });
      let replacementExternalId: string | undefined;
      try {
        const inbox = await repo.getInbox(ownerId);
        expect(inbox.kind).toBe('inbox');
        const inboxMapping = await mappings.get('project', inbox.id);
        if (inboxMapping === null) throw new Error('inbox mapping missing');
        await user.client.deleteProject(inboxMapping.externalId);

        const adopted = await repo.getInbox(ownerId);
        expect(adopted.kind).toBe('inbox');
        expect(adopted.id).not.toBe(inbox.id);
        replacementExternalId = (await mappings.get('project', adopted.id))?.externalId;

        const list = await repo.list(ownerId, { limit: 100 });
        expect(list.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
        expect(list.items.find((project) => project.kind === 'inbox')?.id).toBe(adopted.id);

        const repeated = await repo.getInbox(ownerId);
        expect(repeated.id).toBe(adopted.id);
        const repeatedList = await repo.list(ownerId, { limit: 100 });
        expect(repeatedList.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
      } finally {
        if (replacementExternalId !== undefined) {
          await user.client.deleteProject(replacementExternalId).catch(() => undefined);
          await user.client
            .permanentDeleteProject(replacementExternalId)
            .catch(() => undefined);
        }
      }
    });
  });
  describe('Vikunja planned-id orphan recovery (live)', () => {
    test('adopts a marker-only task instead of creating a duplicate', async () => {
      const [user] = await users();
      const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
      const ids = createSeededIdGenerator(20261201, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const plannedId = ids.next();
      const mappings = new InMemoryMappingStore();
      const remoteProject = await user.client.createProject('M2-03 planned orphan');
      let remoteTaskId: string | undefined;
      try {
        await mappings.put({
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });
        const orphan = await user.client.createTask(String(remoteProject.id), {
          title: 'Planned orphan',
          description: appendMarker('created before crash', plannedId),
        });
        remoteTaskId = String(orphan.id);

        // Fresh mapping store: the local mapping was lost in the crash.
        const repo = new VikunjaTaskRepository({
          clients: new Map<Id, VikunjaClient>([[ownerId, user.client]]),
          mappings,
          plannerFields: new InMemoryPlannerFieldStore(),
          clock,
          ids,
        });
        const adopted = await repo.create(
          ownerId,
          { projectId, title: 'Planned orphan' },
          'planned-orphan-retry',
          { plannedId },
        );
        expect(adopted.id).toBe(plannedId);
        const remoteTasks = await user.client.listAllProjectTasks(String(remoteProject.id));
        expect(remoteTasks.filter((task) => String(task.id) === remoteTaskId)).toHaveLength(1);
        expect(remoteTasks).toHaveLength(1);
      } finally {
        if (remoteTaskId !== undefined) {
          await user.client.deleteTask(remoteTaskId).catch(() => undefined);
          await user.client.permanentDeleteTask(remoteTaskId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
      }
    });
  });

}
