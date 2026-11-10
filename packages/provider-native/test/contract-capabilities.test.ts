import {
  FakeClock,
  createSeededIdGenerator,
  describeTaskRepositoryContract,
} from '@ohmydate/testkit';
import type {
  Id,
  Page,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectQuery,
  ProjectRepository,
  RepositoryCapabilities,
  Task,
  TaskChangePage,
  TaskCreate,
  TaskPatch,
  TaskQuery,
  TaskRepository,
  Version,
} from '@ohmydate/domain';
import {
  createInMemoryRepositories,
  type InMemoryProjectRepository,
  type InMemoryTaskRepository,
} from '../src/in-memory/index.js';

const NON_STRICT_CAPABILITIES: RepositoryCapabilities = {
  strictConcurrency: false,
  idempotentCreate: false,
};

class NonStrictTaskRepository implements TaskRepository {
  readonly capabilities = NON_STRICT_CAPABILITIES;

  readonly #inner: InMemoryTaskRepository;

  constructor(inner: InMemoryTaskRepository) {
    this.#inner = inner;
  }

  create(ownerId: Id, input: TaskCreate, idemKey: string): Promise<Task> {
    return this.#inner.create(ownerId, input, idemKey);
  }

  get(ownerId: Id, id: Id): Promise<Task | null> {
    return this.#inner.get(ownerId, id);
  }

  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    return this.#inner.list(ownerId, query);
  }

  update(
    ownerId: Id,
    id: Id,
    patch: TaskPatch,
    expectedVersion: Version,
  ): Promise<Task> {
    return this.#inner.update(ownerId, id, patch, expectedVersion);
  }

  complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task> {
    return this.#inner.complete(ownerId, id, expectedVersion);
  }

  softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<void> {
    return this.#inner.softDelete(ownerId, id, expectedVersion);
  }

  listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage> {
    return this.#inner.listChangedSince(ownerId, cursor);
  }
}

class NonStrictProjectRepository implements ProjectRepository {
  readonly capabilities = NON_STRICT_CAPABILITIES;

  readonly #inner: InMemoryProjectRepository;

  constructor(inner: InMemoryProjectRepository) {
    this.#inner = inner;
  }

  create(ownerId: Id, input: ProjectCreate, idemKey: string): Promise<Project> {
    return this.#inner.create(ownerId, input, idemKey);
  }

  get(ownerId: Id, id: Id): Promise<Project | null> {
    return this.#inner.get(ownerId, id);
  }

  list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>> {
    return this.#inner.list(ownerId, query);
  }

  update(
    ownerId: Id,
    id: Id,
    patch: ProjectPatch,
    expectedVersion: Version,
  ): Promise<Project> {
    return this.#inner.update(ownerId, id, patch, expectedVersion);
  }
}

describeTaskRepositoryContract('InMemoryTaskRepository with non-strict capabilities', async () => {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(7, clock);
  const ownerA = ids.next();
  const ownerB = ids.next();
  const { tasks, projects } = createInMemoryRepositories({ clock, ids });

  return {
    repo: new NonStrictTaskRepository(tasks),
    projects: new NonStrictProjectRepository(projects),
    clock,
    ids,
    ownerA,
    ownerB,
    cleanup: async () => {},
  };
});
