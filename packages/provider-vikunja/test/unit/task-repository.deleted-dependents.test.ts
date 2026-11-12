import {
  ProviderUnavailableError,
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Task,
  type TaskChange,
  type Version,
} from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { InMemoryChangeJournalStore } from '../../src/change-journal-store.js';
import { VikunjaClient } from '../../src/client.js';
import { InMemoryMappingStore } from '../../src/mapping-store.js';
import { InMemoryPlannerFieldStore } from '../../src/planner-field-store.js';
import {
  DELETED_DEPENDENT_RESCAN_LIMIT,
  VikunjaTaskRepository,
} from '../../src/task-repository.js';
import { FakeHttp, type FakeRequest, type FakeResponse } from './fake-http.js';

const BASE_MS = Date.parse('2026-01-01T00:00:00Z');
const NO_DUE = '0001-01-01T00:00:00Z';

interface FakeTask {
  readonly id: number;
  readonly projectId: number;
  title: string;
  description: string;
  done: boolean;
  dueDate: string;
  updatedMs: number;
  deletedAt?: string;
  blocked: number[];
}

function secondPrecision(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Vikunja v2.8.0 double for FU-81. Measured on the live server: deleting a task
 * removes it from every dependent's `related_tasks.blocked` in the same
 * request, but leaves the dependents' `updated` column (and so the
 * second-precision ETag) untouched. A relation write touches the base task.
 */
class DeleteDropsRelationsVikunja {
  nowMs = BASE_MS + 100;
  nextId = 500;
  readonly tasks = new Map<number, FakeTask>();
  /** GET /tasks/:id answers 503 for these ids. */
  readonly failGets = new Set<number>();
  readonly fetch = new FakeHttp((request) => this.#handle(request)).fetch;
  readonly calls: FakeRequest[] = [];

  advance(ms: number): void {
    this.nowMs += ms;
  }

  /**
   * GET /tasks/:id calls for one task since the last `resetCalls()`, optionally
   * only those made with one owner's token.
   */
  readsOf(id: number, token?: string): number {
    return this.calls.filter(
      (call) =>
        call.method === 'GET' &&
        call.path === `/api/v2/tasks/${id}` &&
        (token === undefined || call.headers.authorization === `Bearer ${token}`),
    ).length;
  }

  resetCalls(): void {
    this.calls.length = 0;
  }

  /** A delete by another Vikunja client (web UI, CalDAV, ...). */
  remoteDelete(id: number): void {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`no remote task ${id}`);
    this.#softDelete(task);
  }

  /** The trash is emptied: the task is gone from `/tasks/deleted` too. */
  purge(id: number): void {
    this.tasks.delete(id);
  }

  /** A write by another Vikunja client. */
  externalEdit(id: number, edit: (task: FakeTask) => void): void {
    const task = this.tasks.get(id);
    if (task === undefined) throw new Error(`no remote task ${id}`);
    edit(task);
    task.updatedMs = this.nowMs;
  }

  #softDelete(task: FakeTask): void {
    task.deletedAt = secondPrecision(this.nowMs);
    for (const other of this.tasks.values()) {
      other.blocked = other.blocked.filter((id) => id !== task.id);
    }
  }

  #etag(task: FakeTask): string {
    return `"${Math.floor(task.updatedMs / 1000)}000000000-2"`;
  }

  #body(task: FakeTask): Record<string, unknown> {
    const summary = (other: FakeTask) => ({
      id: other.id,
      project_id: other.projectId,
      title: other.title,
      updated: secondPrecision(other.updatedMs),
    });
    const blocked = task.blocked
      .map((id) => this.tasks.get(id))
      .filter((other): other is FakeTask => other !== undefined && other.deletedAt === undefined)
      .map(summary);
    // The server-generated inverse; the adapter must never treat it as an edge.
    const blocking = [...this.tasks.values()]
      .filter((other) => other.deletedAt === undefined && other.blocked.includes(task.id))
      .map(summary);
    const related: Record<string, unknown> = {};
    if (blocked.length > 0) related.blocked = blocked;
    if (blocking.length > 0) related.blocking = blocking;
    return {
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      description: task.description,
      done: task.done,
      due_date: task.dueDate,
      created: secondPrecision(BASE_MS),
      updated: secondPrecision(task.updatedMs),
      related_tasks: related,
    };
  }

  #page(items: readonly Record<string, unknown>[]): FakeResponse {
    return {
      status: 200,
      body: { items, total: items.length, page: 1, per_page: 50, total_pages: 1 },
    };
  }

  #handle(request: FakeRequest): FakeResponse {
    this.calls.push(request);
    const notFound: FakeResponse = { status: 404, body: { code: 4002, detail: 'not found' } };
    const clock = { date: new Date(this.nowMs).toUTCString() };
    const taskMatch = /^\/api\/v2\/tasks\/(\d+)$/.exec(request.path);
    if (taskMatch !== null) {
      const task = this.tasks.get(Number(taskMatch[1]));
      if (task === undefined || task.deletedAt !== undefined) return notFound;
      if (request.method === 'GET') {
        if (this.failGets.has(task.id)) return { status: 503, body: { title: 'unavailable' } };
        return { status: 200, body: this.#body(task), headers: { etag: this.#etag(task) } };
      }
      if (request.method === 'PATCH') {
        const patch = request.body as Record<string, unknown>;
        if (typeof patch.title === 'string') task.title = patch.title;
        if (typeof patch.description === 'string') task.description = patch.description;
        if (typeof patch.done === 'boolean') task.done = patch.done;
        task.updatedMs = this.nowMs;
        return { status: 200, body: this.#body(task), headers: { etag: this.#etag(task) } };
      }
      if (request.method === 'DELETE') {
        this.#softDelete(task);
        return { status: 200, body: {} };
      }
    }
    const projectTasksMatch = /^\/api\/v2\/projects\/(\d+)\/tasks$/.exec(request.path);
    if (projectTasksMatch !== null) {
      const projectId = Number(projectTasksMatch[1]);
      if (request.method === 'POST') {
        const body = request.body as Record<string, unknown>;
        const task: FakeTask = {
          id: this.nextId,
          projectId,
          title: String(body.title),
          description: typeof body.description === 'string' ? body.description : '',
          done: body.done === true,
          dueDate: NO_DUE,
          updatedMs: this.nowMs,
          blocked: [],
        };
        this.nextId += 1;
        this.tasks.set(task.id, task);
        return { status: 201, body: this.#body(task) };
      }
      if (request.method === 'GET') {
        return this.#page(
          [...this.tasks.values()]
            .filter((task) => task.projectId === projectId && task.deletedAt === undefined)
            .map((task) => this.#body(task)),
        );
      }
    }
    const relationMatch = /^\/api\/v2\/tasks\/(\d+)\/relations$/.exec(request.path);
    if (request.method === 'POST' && relationMatch !== null) {
      const task = this.tasks.get(Number(relationMatch[1]));
      if (task === undefined) return notFound;
      const body = request.body as { other_task_id: number; relation_kind: string };
      if (body.relation_kind === 'blocked') task.blocked = [...task.blocked, body.other_task_id];
      task.updatedMs = this.nowMs;
      return {
        status: 201,
        body: {
          task_id: task.id,
          other_task_id: body.other_task_id,
          relation_kind: body.relation_kind,
          created: new Date(this.nowMs).toISOString(),
        },
        headers: clock,
      };
    }
    const relationDeleteMatch = /^\/api\/v2\/tasks\/(\d+)\/relations\/([^/]+)\/(\d+)$/.exec(
      request.path,
    );
    if (request.method === 'DELETE' && relationDeleteMatch !== null) {
      const task = this.tasks.get(Number(relationDeleteMatch[1]));
      if (task === undefined) return notFound;
      const other = Number(relationDeleteMatch[3]);
      task.blocked = task.blocked.filter((id) => id !== other);
      task.updatedMs = this.nowMs;
      return { status: 200, body: {}, headers: clock };
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks') {
      const filter = new URL(request.url).searchParams.get('filter') ?? '';
      const match = /updated >= "([^"]+)"/.exec(filter);
      const threshold = match === null ? 0 : Date.parse(match[1] ?? '');
      return this.#page(
        [...this.tasks.values()]
          .filter(
            (task) =>
              task.deletedAt === undefined &&
              Date.parse(secondPrecision(task.updatedMs)) >= threshold,
          )
          .sort((left, right) => left.updatedMs - right.updatedMs)
          .map((task) => this.#body(task)),
      );
    }
    if (request.method === 'GET' && request.path === '/api/v2/tasks/deleted') {
      return this.#page(
        [...this.tasks.values()]
          .filter((task) => task.deletedAt !== undefined)
          .map((task) => ({ ...this.#body(task), deleted_at: task.deletedAt })),
      );
    }
    return notFound;
  }
}

interface Owner {
  readonly ownerId: Id;
  readonly projectId: Id;
  readonly token: string;
  /** One Vikunja instance shared by every owner, as in production. */
  readonly server: DeleteDropsRelationsVikunja;
}

async function setup() {
  const clock = new FakeClock(epochMsToInstant(BASE_MS));
  const ids = createSeededIdGenerator(81, clock);
  const mappings = new InMemoryMappingStore();
  const clients = new Map<Id, VikunjaClient>();
  // The double does not scope listings by user, so each owner's polls also
  // see the other owner's tasks and trash: the adapter must skip them.
  const server = new DeleteDropsRelationsVikunja();

  async function addOwner(externalProject: number, token: string): Promise<Owner> {
    const ownerId = ids.next();
    const projectId = ids.next();
    await mappings.put({
      provider: 'vikunja',
      entityType: 'project',
      entityId: projectId,
      externalId: String(externalProject),
      ownerId,
      localVersion: 1 as Version,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    clients.set(
      ownerId,
      new VikunjaClient({
        baseUrl: 'http://vikunja.test',
        token,
        fetch: server.fetch,
        retries: 0,
        sleep: async () => {},
      }),
    );
    return { ownerId, projectId, token, server };
  }

  const main = await addOwner(7, 'tk_main');
  const other = await addOwner(9, 'tk_other');
  const repo = new VikunjaTaskRepository({
    clients,
    mappings,
    plannerFields: new InMemoryPlannerFieldStore(),
    journal: new InMemoryChangeJournalStore(),
    clock,
    ids,
  });

  async function create(owner: Owner, title: string, dependsOn: readonly Id[] = []) {
    return repo.create(
      owner.ownerId,
      { projectId: owner.projectId, title, dependsOn: [...dependsOn] },
      `create-${title}`,
    );
  }

  async function versionsOf(owner: Owner, taskId: Id): Promise<Version[]> {
    return (await repo.listChangedSince(owner.ownerId, null)).changes
      .filter((change) => change.id === taskId)
      .map((change) => change.version);
  }

  /**
   * Moves the remote watermark of an incremental cursor past every task that
   * exists now: only a later task is in the next `updated >=` scan.
   */
  async function cursorPastExistingTasks(owner: Owner): Promise<string> {
    owner.server.advance(10_000);
    await create(owner, `Watermark ${owner.server.nextId}`);
    const { cursor } = await repo.listChangedSince(owner.ownerId, null);
    // A null cursor would turn the incremental poll into a full resync.
    if (cursor === null) throw new Error('expected an incremental cursor');
    owner.server.resetCalls();
    return cursor;
  }

  return { repo, mappings, main, other, create, versionsOf, cursorPastExistingTasks };
}

function externalIdOf(task: Task): number {
  return Number(task.external?.[0]?.externalId);
}

function summary(changes: readonly TaskChange[]): string[] {
  return changes.map(
    (change) => `${change.id}:v${change.version}${change.deletedAt === undefined ? '' : ':deleted'}`,
  );
}

describe('FU-81: dependents of a deleted task are surfaced once', () => {
  test('own delete: the dependent gets one new version without the dependency', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const otherDependency = await context.create(main, 'Other dependency');
    const otherDependent = await context.create(main, 'Other dependent', [otherDependency.id]);
    const unrelated = await context.create(main, 'Unrelated');
    const cursor = await context.cursorPastExistingTasks(main);
    const watermarkBefore = (await context.mappings.get('task', dependent.id))
      ?.externalUpdatedAt;

    const deletedVersion = await context.repo.softDelete(
      main.ownerId,
      dependency.id,
      dependency.version,
    );
    expect(deletedVersion).toBe(2);
    // Re-read once, eagerly; nothing else is read.
    expect(main.server.readsOf(externalIdOf(dependent))).toBe(1);
    for (const task of [otherDependency, otherDependent, unrelated]) {
      expect(main.server.readsOf(externalIdOf(task))).toBe(0);
    }
    // FU-73: the accounted-for watermark is never lowered.
    expect((await context.mappings.get('task', dependent.id))?.externalUpdatedAt).toBe(
      watermarkBefore,
    );

    const loaded = await context.repo.get(main.ownerId, dependent.id);
    expect(loaded?.version).toBe(2);
    expect(loaded?.dependsOn).toEqual([]);

    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependency.id}:v2:deleted`,
      `${dependent.id}:v2`,
    ]);
    const drained = await context.repo.listChangedSince(main.ownerId, feed.cursor);
    expect(drained.changes).toEqual([]);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
    expect(await context.versionsOf(main, otherDependent.id)).toEqual([1]);
    expect(await context.versionsOf(main, unrelated.id)).toEqual([1]);

    await expect(
      context.repo.update(main.ownerId, dependent.id, { title: 'stale' }, 1 as Version),
    ).rejects.toBeInstanceOf(VersionConflictError);
    const written = await context.repo.update(
      main.ownerId,
      dependent.id,
      { title: 'Dependent 2' },
      2 as Version,
    );
    expect(written.version).toBe(3);
  });

  test('remote delete: the poll that tombstones the dependency also surfaces the dependent', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const unrelated = await context.create(main, 'Unrelated');
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(dependency));
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependency.id}:v2:deleted`,
      `${dependent.id}:v2`,
    ]);
    expect(main.server.readsOf(externalIdOf(dependent))).toBe(1);
    expect(main.server.readsOf(externalIdOf(unrelated))).toBe(0);

    const loaded = await context.repo.get(main.ownerId, dependent.id);
    expect(loaded?.version).toBe(2);
    expect(loaded?.dependsOn).toEqual([]);

    // The dependency stays in the trash; repeated polls do no further work.
    main.server.resetCalls();
    const again = await context.repo.listChangedSince(main.ownerId, feed.cursor);
    const third = await context.repo.listChangedSince(main.ownerId, again.cursor);
    expect(again.changes).toEqual([]);
    expect(third.changes).toEqual([]);
    expect(main.server.readsOf(externalIdOf(dependent))).toBe(0);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
    expect(await context.versionsOf(main, unrelated.id)).toEqual([1]);
  });

  test('two dependencies deleted before one poll bump the dependent once', async () => {
    const context = await setup();
    const { main } = context;
    const first = await context.create(main, 'First');
    const second = await context.create(main, 'Second');
    const dependent = await context.create(main, 'Dependent', [first.id, second.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(first));
    main.server.remoteDelete(externalIdOf(second));
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${first.id}:v2:deleted`,
      `${second.id}:v2:deleted`,
      `${dependent.id}:v2`,
    ]);
    expect((await context.repo.get(main.ownerId, dependent.id))?.dependsOn).toEqual([]);
  });

  test('one remaining dependency is kept when only the other is deleted', async () => {
    const context = await setup();
    const { main } = context;
    const kept = await context.create(main, 'Kept');
    const dropped = await context.create(main, 'Dropped');
    const dependent = await context.create(main, 'Dependent', [kept.id, dropped.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    await context.repo.softDelete(main.ownerId, dropped.id, dropped.version);
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([`${dropped.id}:v2:deleted`, `${dependent.id}:v2`]);
    const loaded = await context.repo.get(main.ownerId, dependent.id);
    expect(loaded?.dependsOn).toEqual([kept.id]);
    expect(await context.versionsOf(main, kept.id)).toEqual([1]);
  });
});

describe('FU-81 negatives: no second bump and no unrelated bump', () => {
  test('a dependent the live scan already reconciled is not bumped again', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(dependency));
    main.server.advance(2_000);
    main.server.externalEdit(externalIdOf(dependent), (task) => {
      task.title = 'Edited in Vikunja';
    });
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependent.id}:v2`,
      `${dependency.id}:v2:deleted`,
    ]);
    // Read by the `updated >=` scan only; the reverse-edge pass skipped it.
    expect(main.server.readsOf(externalIdOf(dependent))).toBe(1);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
  });

  test('a dependent reconciled by a conflicting write is not bumped again by the poll', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(dependency));
    await expect(
      context.repo.update(main.ownerId, dependent.id, { title: 'stale' }, dependent.version),
    ).rejects.toMatchObject({ actual: 2 });
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependent.id}:v2`,
      `${dependency.id}:v2:deleted`,
    ]);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
  });

  test('deleting a task with no dependents reads and bumps nothing else', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const lone = await context.create(main, 'Lone');
    const cursor = await context.cursorPastExistingTasks(main);

    // The dependent itself is deleted: its own dependency has no incoming
    // `blocked` relation, only the server-side inverse, so it is not re-read.
    await context.repo.softDelete(main.ownerId, dependent.id, dependent.version);
    main.server.remoteDelete(externalIdOf(lone));
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependent.id}:v2:deleted`,
      `${lone.id}:v2:deleted`,
    ]);
    expect(main.server.readsOf(externalIdOf(dependency))).toBe(0);
    expect(await context.versionsOf(main, dependency.id)).toEqual([1]);
  });
});

describe('FU-81 durability, bounds and owner scope', () => {
  test('own delete: a failed dependent read keeps the delete and the next poll bumps once', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.failGets.add(externalIdOf(dependent));
    expect(
      await context.repo.softDelete(main.ownerId, dependency.id, dependency.version),
    ).toBe(2);
    expect((await context.mappings.get('task', dependent.id))?.localVersion).toBe(1);

    main.server.failGets.clear();
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependency.id}:v2:deleted`,
      `${dependent.id}:v2`,
    ]);
    const drained = await context.repo.listChangedSince(main.ownerId, feed.cursor);
    expect(drained.changes).toEqual([]);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
  });

  test('remote delete: a failed dependent read fails the poll and the retry tombstones once', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(dependency));
    main.server.failGets.add(externalIdOf(dependent));
    await expect(context.repo.listChangedSince(main.ownerId, cursor)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );

    main.server.failGets.clear();
    const feed = await context.repo.listChangedSince(main.ownerId, cursor);
    expect(summary(feed.changes)).toEqual([
      `${dependency.id}:v2:deleted`,
      `${dependent.id}:v2`,
    ]);
    expect(await context.versionsOf(main, dependency.id)).toEqual([1, 2]);
    expect(await context.versionsOf(main, dependent.id)).toEqual([1, 2]);
  });

  test('a trash emptied before the retry leaves the dependent to the null-cursor scan, once', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependent = await context.create(main, 'Dependent', [dependency.id]);
    await context.cursorPastExistingTasks(main);

    main.server.failGets.add(externalIdOf(dependent));
    await context.repo.softDelete(main.ownerId, dependency.id, dependency.version);
    main.server.failGets.clear();
    main.server.purge(externalIdOf(dependency));

    const full = await context.repo.listChangedSince(main.ownerId, null);
    expect(
      full.changes.filter((change) => change.id === dependent.id).map((change) => change.version),
    ).toEqual([1, 2]);
    expect((await context.repo.get(main.ownerId, dependent.id))?.dependsOn).toEqual([]);
    const drained = await context.repo.listChangedSince(main.ownerId, full.cursor);
    expect(drained.changes).toEqual([]);
  });

  test('dependents beyond the per-call limit follow on the next poll, each once', async () => {
    const context = await setup();
    const { main } = context;
    const dependency = await context.create(main, 'Dependency');
    const dependents: Task[] = [];
    for (let index = 0; index < DELETED_DEPENDENT_RESCAN_LIMIT + 2; index += 1) {
      dependents.push(await context.create(main, `Dependent ${index}`, [dependency.id]));
    }
    const cursor = await context.cursorPastExistingTasks(main);

    main.server.remoteDelete(externalIdOf(dependency));
    const first = await context.repo.listChangedSince(main.ownerId, cursor);
    const reads = (): number =>
      dependents.reduce((total, task) => total + main.server.readsOf(externalIdOf(task)), 0);
    expect(reads()).toBe(DELETED_DEPENDENT_RESCAN_LIMIT);
    expect(first.changes.filter((change) => change.deletedAt === undefined)).toHaveLength(
      DELETED_DEPENDENT_RESCAN_LIMIT,
    );

    const second = await context.repo.listChangedSince(main.ownerId, first.cursor);
    expect(second.changes).toHaveLength(2);
    expect(reads()).toBe(DELETED_DEPENDENT_RESCAN_LIMIT + 2);
    const third = await context.repo.listChangedSince(main.ownerId, second.cursor);
    expect(third.changes).toEqual([]);

    const full = await context.repo.listChangedSince(main.ownerId, null);
    for (const task of dependents) {
      expect(
        full.changes.filter((change) => change.id === task.id).map((change) => change.version),
      ).toEqual([1, 2]);
    }
  });

  test("an owner's delete follow-up never reads or bumps another owner's dependent", async () => {
    const context = await setup();
    const { main, other, server } = { ...context, server: context.main.server };
    const otherDependency = await context.create(other, 'Other dependency');
    const otherDependent = await context.create(other, 'Other dependent', [otherDependency.id]);
    const mainDependency = await context.create(main, 'Main dependency');
    const mainDependent = await context.create(main, 'Main dependent', [mainDependency.id]);
    const otherCursor = await context.cursorPastExistingTasks(other);
    const mainCursor = await context.cursorPastExistingTasks(main);

    // The other owner's poll tombstones its dependency, then fails on the
    // dependent: a stale reverse edge is left in the shared trash.
    server.remoteDelete(externalIdOf(otherDependency));
    server.failGets.add(externalIdOf(otherDependent));
    await expect(
      context.repo.listChangedSince(other.ownerId, otherCursor),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    server.failGets.clear();
    server.resetCalls();

    // The main owner's poll sees both trashed tasks but follows up only its own.
    server.remoteDelete(externalIdOf(mainDependency));
    const mainFeed = await context.repo.listChangedSince(main.ownerId, mainCursor);
    expect(summary(mainFeed.changes)).toEqual([
      `${mainDependency.id}:v2:deleted`,
      `${mainDependent.id}:v2`,
    ]);
    expect(server.readsOf(externalIdOf(otherDependent), main.token)).toBe(0);
    expect((await context.mappings.get('task', otherDependent.id))?.localVersion).toBe(1);

    await context.repo.softDelete(main.ownerId, mainDependent.id, 2 as Version);
    expect(server.readsOf(externalIdOf(otherDependent))).toBe(0);

    const otherFeed = await context.repo.listChangedSince(other.ownerId, otherCursor);
    expect(summary(otherFeed.changes)).toEqual([
      `${otherDependency.id}:v2:deleted`,
      `${otherDependent.id}:v2`,
    ]);
    expect(server.readsOf(externalIdOf(otherDependent), other.token)).toBe(1);
    expect(await context.versionsOf(main, otherDependent.id)).toEqual([]);
  });
});
