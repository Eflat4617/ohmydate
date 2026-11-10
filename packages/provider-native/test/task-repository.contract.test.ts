import { FakeClock, createSeededIdGenerator, describeTaskRepositoryContract } from '@ohmydate/testkit';
import { createInMemoryRepositories } from '../src/in-memory/index.js';

describeTaskRepositoryContract('InMemoryTaskRepository', async () => {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(20261111, clock);
  const ownerA = ids.next();
  const ownerB = ids.next();
  const { tasks, projects } = createInMemoryRepositories({ clock, ids });

  return {
    repo: tasks,
    projects,
    clock,
    ids,
    ownerA,
    ownerB,
    cleanup: async () => {},
  };
});
