import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
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

  it('creates a real owner-local Inbox project for tasks without a projectId', async () => {
    const { owner, tasks, projects } = createContext();

    const first = await tasks.create(owner, { title: 'First inbox task' }, 'inbox-first');
    const second = await tasks.create(owner, { title: 'Second inbox task' }, 'inbox-second');
    expect(second.projectId).toBe(first.projectId);

    const inbox = await projects.get(owner, first.projectId);
    expect(inbox).not.toBeNull();
    expect(inbox?.title).toBe('Inbox');
    expect(inbox?.ownerId).toBe(owner);
  });
});
