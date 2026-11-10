import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { IdempotencyMismatchError } from '@ohmydate/domain';
import { createInMemoryRepositories } from '../src/in-memory/index.js';

function createContext() {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(99, clock);
  const owner = ids.next();
  const { tasks, projects } = createInMemoryRepositories({ clock, ids });
  return { clock, ids, owner, tasks, projects };
}

describe('InMemory repositories', () => {
  it('declares strict concurrency and idempotent create capabilities', () => {
    const { tasks, projects } = createContext();

    expect(tasks.capabilities).toEqual({
      strictConcurrency: true,
      idempotentCreate: true,
    });
    expect(projects.capabilities).toEqual({
      strictConcurrency: true,
      idempotentCreate: true,
    });
  });

  it('replays the original project create response after an update', async () => {
    const { owner, projects } = createContext();
    const original = await projects.create(owner, { title: 'Original project' }, 'project-replay');

    const updated = await projects.update(
      owner,
      original.id,
      { title: 'Changed project' },
      original.version,
    );
    expect(updated.version).toBe(original.version + 1);

    const replay = await projects.create(owner, { title: 'Original project' }, 'project-replay');
    expect(replay).toEqual(original);
    expect(replay.title).toBe('Original project');
    expect(replay.version).toBe(original.version);
  });

  it('scopes project idempotency keys per owner', async () => {
    const { ids, projects } = createContext();
    const ownerA = ids.next();
    const ownerB = ids.next();
    const key = 'shared-project-key';
    const sameTitle = 'Shared project title';

    const first = await projects.create(ownerA, { title: sameTitle }, key);
    const second = await projects.create(ownerB, { title: sameTitle }, key);
    expect(first.id).not.toBe(second.id);
    expect(first.ownerId).toBe(ownerA);
    expect(second.ownerId).toBe(ownerB);

    expect(await projects.create(ownerA, { title: sameTitle }, key)).toEqual(first);
    expect(await projects.create(ownerB, { title: sameTitle }, key)).toEqual(second);

    await expect(
      projects.create(ownerA, { title: 'Different title' }, key),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);
    await expect(
      projects.create(ownerB, { title: 'Different title' }, key),
    ).rejects.toBeInstanceOf(IdempotencyMismatchError);

    const firstOwnerProjects = await projects.list(ownerA, { limit: 100 });
    expect(firstOwnerProjects.items.map((project) => project.id)).toEqual([first.id]);
    const secondOwnerProjects = await projects.list(ownerB, { limit: 100 });
    expect(secondOwnerProjects.items.map((project) => project.id)).toEqual([second.id]);
  });

  it('creates a real owner-local Inbox project for tasks without a projectId', async () => {
    const { owner, tasks, projects } = createContext();

    const first = await tasks.create(owner, { title: 'First inbox task' }, 'inbox-first');
    const second = await tasks.create(owner, { title: 'Second inbox task' }, 'inbox-second');
    expect(second.projectId).toBe(first.projectId);

    const inbox = await projects.get(owner, first.projectId);
    expect(inbox).not.toBeNull();
    expect(inbox?.kind).toBe('inbox');
    expect(inbox?.title).toBe('Inbox');
    expect(inbox?.ownerId).toBe(owner);
    await expect(projects.getInbox(owner)).resolves.toEqual(inbox);
  });
});
