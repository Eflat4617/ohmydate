import {
  ProviderUnavailableError,
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
}
