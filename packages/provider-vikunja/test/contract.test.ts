import {
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator, describeTaskRepositoryContract } from '@ohmydate/testkit';
import { VikunjaClient } from '../src/client.js';
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
        const completion = feed.changes.find((change) => change.id === taskId);
        expect(completion?.version).toBe(2);
        expect(completion?.completedOccurrenceAt).toBeDefined();
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
}
