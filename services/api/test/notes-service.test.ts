import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Id,
} from '@ohmydate/domain';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { DailyProblemError } from '../src/application/daily-errors.js';
import { NotesService, noteSearchTerms } from '../src/application/notes/notes-service.js';
import type { NoteCreateRecord, NoteRecord, NoteStore } from '../src/application/notes/ports.js';

/** Minimal store double: records creates, never touches a database. */
class RecordingStore implements NoteStore {
  readonly created: NoteCreateRecord[] = [];
  promoted: NoteRecord | null = null;
  goals = new Set<string>();
  listCalls: unknown[] = [];

  async create(input: NoteCreateRecord): Promise<NoteRecord> {
    this.created.push(input);
    return {
      id: input.id,
      ownerId: input.ownerId,
      title: input.title,
      bodyMd: input.bodyMd,
      sensitivity: input.sensitivity,
      llmAllowed: input.llmAllowed,
      source: input.source,
      ...(input.sourceTaskId === undefined ? {} : { sourceTaskId: input.sourceTaskId }),
      links: [],
      version: 1 as NoteRecord['version'],
      createdAt: '2026-11-12T00:00:00.000Z' as NoteRecord['createdAt'],
      updatedAt: '2026-11-12T00:00:00.000Z' as NoteRecord['updatedAt'],
    };
  }
  async get(): Promise<NoteRecord | null> {
    return null;
  }
  async list(_owner: Id, query: unknown) {
    this.listCalls.push(query);
    return { items: [], hasMore: false };
  }
  async update(): Promise<NoteRecord> {
    throw new Error('not used');
  }
  async softDelete(): Promise<void> {}
  async addLink(): Promise<NoteRecord> {
    throw new Error('not used');
  }
  async removeLink(): Promise<NoteRecord> {
    throw new Error('not used');
  }
  async findLivePromoted(): Promise<NoteRecord | null> {
    return this.promoted;
  }
  async goalExists(_owner: Id, goalId: Id): Promise<boolean> {
    return this.goals.has(goalId);
  }
  async listUsage() {
    return { items: [], hasMore: false };
  }
}

function service() {
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(61, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  const store = new RecordingStore();
  const notes = new NotesService({ store, tasks: repos.tasks, projects: repos.projects, ids });
  return { notes, store, repos, ids };
}

const OWNER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0c01' as Id;

describe('noteSearchTerms', () => {
  test('keeps letter/digit tokens only, lower-cased, de-duplicated and capped', () => {
    expect(noteSearchTerms('논문 PAPER paper')).toEqual(['논문', 'paper']);
    expect(noteSearchTerms("a:* & b | !c ('d')")).toEqual(['a', 'b', 'c', 'd']);
    expect(noteSearchTerms('ｆｕｌｌｗｉｄｔｈ')).toEqual(['fullwidth']);
    expect(noteSearchTerms('1 2 3 4 5 6 7 8 9 10')).toHaveLength(8);
  });

  test('a query of operators only yields no terms', () => {
    expect(noteSearchTerms("&|!:*()'<>")).toEqual([]);
  });
});

describe('NotesService', () => {
  test('list validates the target pair and cursor before touching the store', async () => {
    const { notes, store } = service();
    await expect(notes.list(OWNER, { targetKind: 'task' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(notes.list(OWNER, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(notes.list(OWNER, { q: '***' })).resolves.toEqual({ items: [], nextCursor: null });
    expect(store.listCalls).toEqual([]);
    await notes.list(OWNER, { q: '논문 요약', limit: 500 });
    expect(store.listCalls).toEqual([{ terms: ['논문', '요약'], offset: 0, limit: 100 }]);
  });

  test('create defaults to P2 / llmAllowed=false and rejects duplicate or unknown targets', async () => {
    const { notes, store } = service();
    const goal = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0c02' as Id;
    store.goals.add(goal);
    await notes.create(OWNER, { title: 'n', links: [{ targetKind: 'goal', targetId: goal }] });
    expect(store.created[0]).toMatchObject({ sensitivity: 'P2', llmAllowed: false, source: 'manual' });
    await expect(
      notes.create(OWNER, {
        title: 'n',
        links: [
          { targetKind: 'goal', targetId: goal },
          { targetKind: 'goal', targetId: goal },
        ],
      }),
    ).rejects.toBeInstanceOf(ValidationFailedError);
    await expect(
      notes.create(OWNER, { title: 'n', links: [{ targetKind: 'task', targetId: goal }] }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(notes.create(OWNER, { title: ' ' })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(store.created).toHaveLength(1);
  });

  test('promote checks ownership, version, prior promotion and an empty description', async () => {
    const { notes, store, repos } = service();
    const task = await repos.tasks.create(OWNER, { title: 'T', description: '<p>body</p>' }, 'k1');
    await expect(notes.promoteTaskDescription('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0c09' as Id, task.id, task.version)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(notes.promoteTaskDescription(OWNER, task.id, task.version + 1)).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    const note = await notes.promoteTaskDescription(OWNER, task.id, task.version);
    expect(note).toMatchObject({ bodyMd: 'body', source: 'task_description', sourceTaskId: task.id });
    expect(store.created[0]?.links).toEqual([expect.objectContaining({ targetKind: 'task', targetId: task.id })]);

    store.promoted = note;
    await expect(notes.promoteTaskDescription(OWNER, task.id, task.version)).rejects.toBeInstanceOf(DailyProblemError);

    const empty = await repos.tasks.create(OWNER, { title: 'E', description: '<p> </p>' }, 'k2');
    store.promoted = null;
    await expect(notes.promoteTaskDescription(OWNER, empty.id, empty.version)).rejects.toBeInstanceOf(
      ValidationFailedError,
    );
  });
});
