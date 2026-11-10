import type { Id } from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator, describeTaskRepositoryContract } from '@ohmydate/testkit';
import { VikunjaClient } from '../src/client.js';
import { InMemoryMappingStore } from '../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../src/planner-field-store.js';
import { VikunjaProjectRepository } from '../src/project-repository.js';
import { VikunjaTaskRepository } from '../src/task-repository.js';
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
}
