import type { Id, Version } from '@ohmydate/domain';
import {
  VikunjaProjectRepository,
  VikunjaTaskRepository,
  type ExternalMapping,
} from '@ohmydate/provider-vikunja';
import { PgChangeJournalStore } from '../../src/adapters/vikunja/pg-change-journal-store.js';
import { PgMappingStore } from '../../src/adapters/vikunja/pg-mapping-store.js';
import { PgPlannerFieldStore } from '../../src/adapters/vikunja/pg-planner-field-store.js';
import {
  FakeClock,
  createSeededIdGenerator,
  describeTaskRepositoryContract,
} from '@ohmydate/testkit';
import { createSyntheticUser, purgeUserData, type LiveUser } from '../../../../packages/provider-vikunja/test/live-support.js';
import { createPgTestStore, hasDatabase } from './pg-support.js';

const baseUrl = process.env['VIKUNJA_URL'];
const live = hasDatabase && baseUrl !== undefined && baseUrl.length > 0;

if (!live) {
  describe('VikunjaTaskRepository contract on PostgreSQL (live)', () => {
    test('SKIPPED: set DATABASE_URL and VIKUNJA_URL=http://127.0.0.1:3456', (context) => {
      context.skip();
    });
  });
} else {
  const liveUrl: string = baseUrl as string;
  let usersPromise: Promise<readonly [LiveUser, LiveUser]> | undefined;
  let seed = 20261111;

  function users(): Promise<readonly [LiveUser, LiveUser]> {
    usersPromise ??= Promise.all([
      createSyntheticUser(liveUrl),
      createSyntheticUser(liveUrl),
    ]).then(([first, second]) => [first, second] as const);
    return usersPromise;
  }

  describeTaskRepositoryContract(
    `VikunjaTaskRepository + PG stores (live ${liveUrl})`,
    async () => {
      const [userA, userB] = await users();
      const store = await createPgTestStore();
      const clock = new FakeClock();
      seed += 1;
      const ids = createSeededIdGenerator(seed, clock);
      const ownerA = ids.next();
      const ownerB = ids.next();
      const mappings = new PgMappingStore(store.db);
      const plannerFields = new PgPlannerFieldStore(store.db);
      const journal = new PgChangeJournalStore(store.db);
      const clients = new Map<Id, LiveUser['client']>([
        [ownerA, userA.client],
        [ownerB, userB.client],
      ]);
      return {
        repo: new VikunjaTaskRepository({ clients, mappings, plannerFields, journal, clock, ids }),
        projects: new VikunjaProjectRepository({ clients, mappings, clock, ids }),
        clock,
        ids,
        ownerA,
        ownerB,
        cleanup: async () => {
          await purgeUserData(userA.client, mappings, ownerA);
          await purgeUserData(userB.client, mappings, ownerB);
          await store.close();
        },
      };
    },
  );

  describe('PG store restart semantics (live)', () => {
    test('a reconstructed repository on the same database keeps the cursor valid', async () => {
      const [user] = await users();
      const store = await createPgTestStore();
      const clock = new FakeClock();
      const ids = createSeededIdGenerator(424242, clock);
      const ownerId = ids.next();
      const projectId = ids.next();
      const remoteProject = await user.client.createProject('M1-10 PG restart');
      let externalTaskIds: string[] = [];
      try {
        const mapping: ExternalMapping = {
          provider: 'vikunja',
          entityType: 'project',
          entityId: projectId,
          externalId: String(remoteProject.id),
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        };
        await new PgMappingStore(store.db).put(mapping);

        const first = new VikunjaTaskRepository({
          clients: new Map<Id, LiveUser['client']>([[ownerId, user.client]]),
          mappings: new PgMappingStore(store.db),
          plannerFields: new PgPlannerFieldStore(store.db),
          journal: new PgChangeJournalStore(store.db),
          clock,
          ids,
        });
        const created = await first.create(
          ownerId,
          { projectId, title: 'Survives restart' },
          'restart-key-1',
        );
        externalTaskIds = created.external.map((reference) => reference.externalId);
        const cursor = (await first.listChangedSince(ownerId, null)).cursor;

        const second = new VikunjaTaskRepository({
          clients: new Map<Id, LiveUser['client']>([[ownerId, user.client]]),
          mappings: new PgMappingStore(store.db),
          plannerFields: new PgPlannerFieldStore(store.db),
          journal: new PgChangeJournalStore(store.db),
          clock,
          ids,
        });
        const page = await second.listChangedSince(ownerId, cursor);
        expect(page.changes).toEqual([]);

        const next = await second.create(
          ownerId,
          { projectId, title: 'After restart' },
          'restart-key-2',
        );
        externalTaskIds = [...externalTaskIds, ...next.external.map((ref) => ref.externalId)];
        const incremental = await second.listChangedSince(ownerId, page.cursor);
        expect(incremental.changes.map((change) => change.id)).toEqual([next.id]);
      } finally {
        for (const externalId of externalTaskIds) {
          await user.client.deleteTask(externalId).catch(() => undefined);
          await user.client.permanentDeleteTask(externalId).catch(() => undefined);
        }
        await user.client.deleteProject(String(remoteProject.id)).catch(() => undefined);
        await user.client
          .permanentDeleteProject(String(remoteProject.id))
          .catch(() => undefined);
        await store.close();
      }
    });
  });
}
