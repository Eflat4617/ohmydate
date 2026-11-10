import type { TestContext } from 'vitest';
import {
  DependencyCycleError,
  IdempotencyMismatchError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  isInstant,
  isUuidV7,
  supportsInbox,
  type Id,
  type IdGenerator,
  type Instant,
  type Project,
  type ProjectRepository,
  type Task,
  type TaskCreate,
  type TaskQuery,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import type { FakeClock } from './fake-clock.js';

export interface TaskRepositoryContractContext {
  readonly repo: TaskRepository;
  readonly projects: ProjectRepository;
  readonly clock: FakeClock;
  readonly ids: IdGenerator;
  readonly ownerA: Id;
  readonly ownerB: Id;
  cleanup(): Promise<void>;
}

export type TaskRepositoryContractFactory = () => Promise<TaskRepositoryContractContext>;

const DEFAULT_PROJECT_TITLE = 'Contract project';

function createProject(
  context: TaskRepositoryContractContext,
  ownerId: Id,
  idemKey: string,
): Promise<Project> {
  return context.projects.create(ownerId, { title: DEFAULT_PROJECT_TITLE }, idemKey);
}

function createTask(
  repo: TaskRepository,
  ownerId: Id,
  projectId: Id,
  title: string,
  idemKey: string,
  extra: Partial<TaskCreate> = {},
): Promise<Task> {
  return repo.create(ownerId, { projectId, title, ...extra }, idemKey);
}

async function listAll(
  repo: TaskRepository,
  ownerId: Id,
  query: TaskQuery = {},
): Promise<Task[]> {
  const items: Task[] = [];
  let cursor: string | null = null;
  for (let pageCount = 0; pageCount < 1_000; pageCount += 1) {
    const page = await repo.list(
      ownerId,
      cursor === null ? query : { ...query, cursor },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error('pagination did not terminate');
}

function sortedIds(tasks: readonly Task[]): string[] {
  return tasks.map((task) => task.id).sort();
}

function skipWithReason(context: TestContext, reason: string): never {
  return context.skip(reason);
}

export function describeTaskRepositoryContract(
  name: string,
  factory: TaskRepositoryContractFactory,
): void {
  describe(name, () => {
    let context: TaskRepositoryContractContext;

    beforeEach(async () => {
      context = await factory();
    });

    afterEach(async () => {
      await context.cleanup();
    });

    it('creates and reads a task, preserving the dueAt instant across offsets', async () => {
      const project = await createProject(context, context.ownerA, 'project-roundtrip');
      const dueAt = '2026-11-20T23:59:00+09:00' as Instant;

      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Write the plan',
        'task-roundtrip',
        { dueAt },
      );

      expect(isUuidV7(created.id)).toBe(true);
      expect(created.ownerId).toBe(context.ownerA);
      expect(created.projectId).toBe(project.id);
      expect(created.title).toBe('Write the plan');
      expect(created.status).toBe('todo');
      expect(created.version).toBe(1);
      expect(created.dependsOn).toEqual([]);
      expect(created.dueAt).toBeDefined();
      expect(isInstant(created.dueAt)).toBe(true);
      expect(Date.parse(created.dueAt as string)).toBe(Date.parse(dueAt));

      const fetched = await context.repo.get(context.ownerA, created.id);
      expect(fetched).toEqual(created);
    });

    it('paginates lists with a stable cursor while new tasks are inserted', async () => {
      const project = await createProject(context, context.ownerA, 'project-paging');
      const original: Task[] = [];
      for (let index = 0; index < 7; index += 1) {
        context.clock.advance(1_000);
        original.push(
          await createTask(
            context.repo,
            context.ownerA,
            project.id,
            `Original ${index}`,
            `task-page-${index}`,
          ),
        );
      }

      const inserted: Task[] = [];
      const seen: Task[] = [];
      let cursor: string | null = null;
      let firstPage = true;

      for (;;) {
        const page = await context.repo.list(
          context.ownerA,
          cursor === null
            ? { projectId: project.id, limit: 3 }
            : { projectId: project.id, limit: 3, cursor },
        );
        expect(page.items.length).toBeLessThanOrEqual(3);
        seen.push(...page.items);
        cursor = page.nextCursor;

        if (firstPage) {
          firstPage = false;
          for (let index = 0; index < 3; index += 1) {
            context.clock.advance(1_000);
            inserted.push(
              await createTask(
                context.repo,
                context.ownerA,
                project.id,
                `Inserted ${index}`,
                `task-insert-${index}`,
              ),
            );
          }
        }

        if (cursor === null) break;
      }

      const seenIds = seen.map((task) => task.id);
      expect(new Set(seenIds).size).toBe(seenIds.length);
      const expected = [...original, ...inserted].map((task) => task.id).sort();
      expect([...seenIds].sort()).toEqual(expected);
    });

    it('paginates tasks that share the same millisecond', async () => {
      const project = await createProject(context, context.ownerA, 'project-same-ms-page');
      const created: Task[] = [];
      for (let index = 0; index < 6; index += 1) {
        created.push(
          await createTask(
            context.repo,
            context.ownerA,
            project.id,
            `Same millisecond ${index}`,
            `task-same-ms-page-${index}`,
          ),
        );
      }

      const all = await listAll(context.repo, context.ownerA, {
        projectId: project.id,
        limit: 2,
      });
      expect(all).toHaveLength(6);
      expect(new Set(all.map((task) => task.id)).size).toBe(6);
      expect(sortedIds(all)).toEqual(sortedIds(created));

      const firstPage = await context.repo.list(context.ownerA, {
        projectId: project.id,
        limit: 2,
      });
      expect(firstPage.nextCursor).not.toBeNull();
      if (firstPage.nextCursor === null) throw new Error('expected a continuation cursor');
      const secondPage = await context.repo.list(context.ownerA, {
        projectId: project.id,
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.nextCursor).not.toBeNull();
    });

    it('lists exactly the owner-local tasks for unfiltered, filtered and cursor-continued queries', async () => {
      const projectA1 = await createProject(context, context.ownerA, 'owner-list-a1');
      const projectA2 = await createProject(context, context.ownerA, 'owner-list-a2');
      const projectB1 = await createProject(context, context.ownerB, 'owner-list-b1');

      context.clock.advance(1_000);
      const a1 = await createTask(
        context.repo,
        context.ownerA,
        projectA1.id,
        'A1',
        'owner-list-task-a1',
      );
      context.clock.advance(1_000);
      const a2 = await createTask(
        context.repo,
        context.ownerA,
        projectA2.id,
        'A2',
        'owner-list-task-a2',
      );
      context.clock.advance(1_000);
      const a3 = await createTask(
        context.repo,
        context.ownerA,
        projectA1.id,
        'A3',
        'owner-list-task-a3',
        { status: 'in_progress' },
      );
      context.clock.advance(1_000);
      const b1 = await createTask(
        context.repo,
        context.ownerB,
        projectB1.id,
        'B1',
        'owner-list-task-b1',
      );
      context.clock.advance(1_000);
      const b2 = await createTask(
        context.repo,
        context.ownerB,
        projectB1.id,
        'B2',
        'owner-list-task-b2',
        { status: 'in_progress' },
      );

      const allA = await listAll(context.repo, context.ownerA, { limit: 100 });
      expect(sortedIds(allA)).toEqual(sortedIds([a1, a2, a3]));
      expect(allA.every((task) => task.ownerId === context.ownerA)).toBe(true);

      const allB = await listAll(context.repo, context.ownerB, { limit: 100 });
      expect(sortedIds(allB)).toEqual(sortedIds([b1, b2]));
      expect(allB.every((task) => task.ownerId === context.ownerB)).toBe(true);

      const filteredProjectA = await listAll(context.repo, context.ownerA, {
        projectId: projectA1.id,
        limit: 100,
      });
      expect(sortedIds(filteredProjectA)).toEqual(sortedIds([a1, a3]));

      const filteredStatusA = await listAll(context.repo, context.ownerA, {
        status: 'in_progress',
        limit: 100,
      });
      expect(sortedIds(filteredStatusA)).toEqual(sortedIds([a3]));

      const filteredStatusB = await listAll(context.repo, context.ownerB, {
        status: 'in_progress',
        limit: 100,
      });
      expect(sortedIds(filteredStatusB)).toEqual(sortedIds([b2]));

      const crossed = await context.repo.list(context.ownerA, {
        projectId: projectB1.id,
        limit: 100,
      });
      expect(crossed.items).toEqual([]);
      expect(crossed.nextCursor).toBeNull();

      const firstPage = await context.repo.list(context.ownerA, { limit: 2 });
      expect(firstPage.items).toHaveLength(2);
      expect(firstPage.items.every((task) => task.ownerId === context.ownerA)).toBe(true);
      expect(firstPage.nextCursor).not.toBeNull();
      if (firstPage.nextCursor === null) throw new Error('expected a continuation cursor');
      const secondPage = await context.repo.list(context.ownerA, {
        limit: 2,
        cursor: firstPage.nextCursor,
      });
      expect(secondPage.items.every((task) => task.ownerId === context.ownerA)).toBe(true);

      const continued = await listAll(context.repo, context.ownerA, { limit: 2 });
      expect(continued).toHaveLength(3);
      expect(sortedIds(continued)).toEqual(sortedIds([a1, a2, a3]));
    });

    it('updates a task and increments the version by one', async () => {
      const project = await createProject(context, context.ownerA, 'project-update');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Draft',
        'task-update',
      );
      context.clock.advance(1_000);

      const updated = await context.repo.update(
        context.ownerA,
        created.id,
        { title: 'Draft revised' },
        created.version,
      );

      expect(updated.version).toBe(created.version + 1);
      expect(updated.title).toBe('Draft revised');
      expect(updated.updatedAt).not.toBe(created.updatedAt);
      const fetched = await context.repo.get(context.ownerA, created.id);
      expect(fetched?.title).toBe('Draft revised');
    });

    it('clears optional fields with null and rejects invalid updates atomically', async () => {
      const project = await createProject(context, context.ownerA, 'project-update-null');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Clear me',
        'task-update-null',
        {
          description: 'description',
          dueAt: '2026-11-20T14:59:00.000Z' as Instant,
          session: { minMinutes: 10, maxMinutes: 20 },
        },
      );

      const cleared = await context.repo.update(
        context.ownerA,
        created.id,
        { description: null, dueAt: null, session: null },
        created.version,
      );
      expect(cleared.description).toBeUndefined();
      expect(cleared.dueAt).toBeUndefined();
      expect(cleared.session).toBeUndefined();
      expect(cleared.version).toBe(created.version + 1);

      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      await expect(
        context.repo.update(context.ownerA, created.id, { title: '' }, cleared.version),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      await expect(
        context.repo.update(
          context.ownerA,
          created.id,
          { dueAt: '2026-11-20T14:59:00' as Instant },
          cleared.version,
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);

      expect(await context.repo.get(context.ownerA, created.id)).toEqual(cleared);
      expect((await context.repo.listChangedSince(context.ownerA, cursor)).changes).toEqual([]);
    });

    it('rejects a sequential update with a stale version', async () => {
      const project = await createProject(context, context.ownerA, 'project-stale');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Stale',
        'task-stale',
      );
      await context.repo.update(
        context.ownerA,
        created.id,
        { title: 'First update' },
        created.version,
      );

      await expect(
        context.repo.update(
          context.ownerA,
          created.id,
          { title: 'Second update' },
          created.version,
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
    });

    it('rejects concurrent stale updates when the repository declares strict concurrency', async (
      testContext,
    ) => {
      const project = await createProject(context, context.ownerA, 'project-concurrent');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Concurrent',
        'task-concurrent',
      );

      if (!context.repo.capabilities.strictConcurrency) {
        skipWithReason(
          testContext,
          'adapter declares strictConcurrency=false; only the sequential stale-version conflict is asserted (ADR-016).',
        );
        return;
      }

      const results = await Promise.allSettled([
        context.repo.update(context.ownerA, created.id, { title: 'Left' }, created.version),
        context.repo.update(context.ownerA, created.id, { title: 'Right' }, created.version),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
      expect(reason).toBeInstanceOf(VersionConflictError);

      const fetched = await context.repo.get(context.ownerA, created.id);
      expect(fetched?.version).toBe(created.version + 1);
    });

    it('rejects one of two concurrent project-bearing stale updates with exactly one VersionConflictError', async (
      testContext,
    ) => {
      const project = await createProject(context, context.ownerA, 'project-concurrent-ref');
      const target = await createProject(context, context.ownerA, 'project-concurrent-target');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Concurrent project',
        'task-concurrent-project',
      );

      if (!context.repo.capabilities.strictConcurrency) {
        skipWithReason(
          testContext,
          'adapter declares strictConcurrency=false; concurrent stale project-bearing updates are not guaranteed (ADR-016).',
        );
        return;
      }

      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      const results = await Promise.allSettled([
        context.repo.update(
          context.ownerA,
          created.id,
          { projectId: target.id, title: 'Left' },
          created.version,
        ),
        context.repo.update(
          context.ownerA,
          created.id,
          { projectId: target.id, title: 'Right' },
          created.version,
        ),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
      expect(reason).toBeInstanceOf(VersionConflictError);

      const fetched = await context.repo.get(context.ownerA, created.id);
      expect(fetched?.version).toBe(created.version + 1);
      expect(fetched?.projectId).toBe(target.id);

      const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.id).toBe(created.id);
      expect(changes[0]?.version).toBe(created.version + 1);
    });

    it('does not resurrect a task when a project-bearing update races softDelete', async (
      testContext,
    ) => {
      const project = await createProject(context, context.ownerA, 'project-race-delete');
      const target = await createProject(context, context.ownerA, 'project-race-delete-target');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Delete race',
        'task-race-delete',
      );

      if (!context.repo.capabilities.strictConcurrency) {
        skipWithReason(
          testContext,
          'adapter declares strictConcurrency=false; update versus delete serialization is not guaranteed (ADR-016).',
        );
        return;
      }

      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      const pendingUpdate = context.repo.update(
        context.ownerA,
        created.id,
        { projectId: target.id, title: 'Resurrected' },
        created.version,
      );
      const pendingDelete = context.repo.softDelete(
        context.ownerA,
        created.id,
        created.version,
      );
      const results = await Promise.allSettled([pendingUpdate, pendingDelete]);

      expect(results[0]?.status).toBe('rejected');
      const reason = results[0]?.status === 'rejected' ? results[0].reason : undefined;
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect(results[1]?.status).toBe('fulfilled');

      expect(await context.repo.get(context.ownerA, created.id)).toBeNull();
      const listed = await listAll(context.repo, context.ownerA, { limit: 100 });
      expect(listed.some((task) => task.id === created.id)).toBe(false);

      const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.id).toBe(created.id);
      expect(changes[0]?.version).toBe(created.version + 1);
      expect(changes[0]?.deletedAt).toBeDefined();
    });

    it('does not overwrite a completion when a project-bearing update races complete', async (
      testContext,
    ) => {
      const project = await createProject(context, context.ownerA, 'project-race-complete');
      const target = await createProject(context, context.ownerA, 'project-race-complete-target');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Complete race',
        'task-race-complete',
      );

      if (!context.repo.capabilities.strictConcurrency) {
        skipWithReason(
          testContext,
          'adapter declares strictConcurrency=false; update versus complete serialization is not guaranteed (ADR-016).',
        );
        return;
      }

      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      const pendingUpdate = context.repo.update(
        context.ownerA,
        created.id,
        { projectId: target.id, title: 'Resurrected' },
        created.version,
      );
      const pendingComplete = context.repo.complete(
        context.ownerA,
        created.id,
        created.version,
      );
      const results = await Promise.allSettled([pendingUpdate, pendingComplete]);

      expect(results[0]?.status).toBe('rejected');
      const reason = results[0]?.status === 'rejected' ? results[0].reason : undefined;
      expect(reason).toBeInstanceOf(VersionConflictError);
      expect(results[1]?.status).toBe('fulfilled');

      const fetched = await context.repo.get(context.ownerA, created.id);
      expect(fetched?.status).toBe('done');
      expect(fetched?.title).toBe(created.title);
      expect(fetched?.version).toBe(created.version + 1);

      const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]?.id).toBe(created.id);
      expect(changes[0]?.version).toBe(created.version + 1);
    });

    it('allows only one of two simultaneous dependency patches that would form a cycle', async (
      testContext,
    ) => {
      const project = await createProject(context, context.ownerA, 'project-race-deps');
      const target = await createProject(context, context.ownerA, 'project-race-deps-target');
      const first = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Dependency A',
        'task-race-deps-a',
      );
      const second = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Dependency B',
        'task-race-deps-b',
      );

      if (!context.repo.capabilities.strictConcurrency) {
        skipWithReason(
          testContext,
          'adapter declares strictConcurrency=false; simultaneous dependency graph validation is not guaranteed (ADR-016).',
        );
        return;
      }

      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      const results = await Promise.allSettled([
        context.repo.update(
          context.ownerA,
          first.id,
          { projectId: target.id, dependsOn: [second.id] },
          first.version,
        ),
        context.repo.update(
          context.ownerA,
          second.id,
          { projectId: target.id, dependsOn: [first.id] },
          second.version,
        ),
      ]);
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
      expect(reason).toBeInstanceOf(DependencyCycleError);

      const currentFirst = await context.repo.get(context.ownerA, first.id);
      const currentSecond = await context.repo.get(context.ownerA, second.id);
      const firstDependsOnSecond = currentFirst?.dependsOn.includes(second.id) ?? false;
      const secondDependsOnFirst = currentSecond?.dependsOn.includes(first.id) ?? false;
      expect(firstDependsOnSecond && secondDependsOnFirst).toBe(false);
      expect([firstDependsOnSecond, secondDependsOnFirst].filter(Boolean)).toHaveLength(1);

      const winner = firstDependsOnSecond ? currentFirst : currentSecond;
      const loser = firstDependsOnSecond ? currentSecond : currentFirst;
      expect(winner?.version).toBe(2);
      expect(loser?.version).toBe(1);
      expect(loser?.dependsOn).toEqual([]);

      const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
      expect(changes).toHaveLength(1);
      expect([first.id, second.id]).toContain(changes[0]?.id);
      expect(changes[0]?.version).toBe(2);
    });

    it('serves concurrent equal-body creates from one immutable stored response and one change record', async (
      testContext,
    ) => {
      if (!context.repo.capabilities.idempotentCreate) {
        skipWithReason(
          testContext,
          'adapter declares idempotentCreate=false; concurrent idempotent create replay is handled by the API layer per ADR-016.',
        );
        return;
      }

      const project = await createProject(context, context.ownerA, 'project-concurrent-idem');
      const scenarios: ReadonlyArray<{ key: string; input: TaskCreate }> = [
        {
          key: 'concurrent-idem-explicit',
          input: { projectId: project.id, title: 'Concurrent explicit' },
        },
        {
          key: 'concurrent-idem-inbox',
          input: { title: 'Concurrent inbox' },
        },
      ];

      for (const scenario of scenarios) {
        const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
        const [first, second] = await Promise.all([
          context.repo.create(context.ownerA, scenario.input, scenario.key),
          context.repo.create(context.ownerA, scenario.input, scenario.key),
        ]);

        expect(second).toEqual(first);
        expect(second).not.toBe(first);
        expect(second.id).toBe(first.id);
        expect(second.version).toBe(1);

        const mutable = first as unknown as { title: string; dependsOn: Id[] };
        mutable.title = 'mutated';
        mutable.dependsOn.push(second.id);
        expect(second.title).toBe(scenario.input.title);
        expect(second.dependsOn).toEqual([]);
        const fetched = await context.repo.get(context.ownerA, first.id);
        expect(fetched?.title).toBe(scenario.input.title);
        expect(fetched?.dependsOn).toEqual([]);

        if (scenario.input.projectId === undefined) {
          expect(second.projectId).toBe(first.projectId);
          const inbox = await context.projects.get(context.ownerA, first.projectId);
          expect(inbox?.title).toBe('Inbox');
        }

        const listed = await listAll(context.repo, context.ownerA, { limit: 100 });
        expect(listed.filter((task) => task.id === first.id)).toHaveLength(1);
        const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
        expect(changes).toHaveLength(1);
        expect(changes[0]?.id).toBe(first.id);
        expect(changes[0]?.version).toBe(1);
      }
    });

    it('rejects concurrent same-key creates with different bodies without extra writes', async (
      testContext,
    ) => {
      if (!context.repo.capabilities.idempotentCreate) {
        skipWithReason(
          testContext,
          'adapter declares idempotentCreate=false; concurrent idempotency mismatch is handled by the API layer per ADR-016.',
        );
        return;
      }

      const project = await createProject(context, context.ownerA, 'project-concurrent-mismatch');
      const scenarios: ReadonlyArray<{
        key: string;
        firstInput: TaskCreate;
        secondInput: TaskCreate;
      }> = [
        {
          key: 'concurrent-mismatch-explicit',
          firstInput: { projectId: project.id, title: 'Explicit first' },
          secondInput: { projectId: project.id, title: 'Explicit second' },
        },
        {
          key: 'concurrent-mismatch-inbox',
          firstInput: { title: 'Inbox first' },
          secondInput: { title: 'Inbox second' },
        },
      ];

      for (const scenario of scenarios) {
        const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
        const results = await Promise.allSettled([
          context.repo.create(context.ownerA, scenario.firstInput, scenario.key),
          context.repo.create(context.ownerA, scenario.secondInput, scenario.key),
        ]);
        const fulfilled = results.filter((result) => result.status === 'fulfilled');
        const rejected = results.filter((result) => result.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const reason = rejected[0]?.status === 'rejected' ? rejected[0].reason : undefined;
        expect(reason).toBeInstanceOf(IdempotencyMismatchError);

        const changes = (await context.repo.listChangedSince(context.ownerA, cursor)).changes;
        expect(changes).toHaveLength(1);
        const createdId = changes[0]?.id;
        if (createdId === undefined) throw new Error('expected a created task change');
        const created = await context.repo.get(context.ownerA, createdId);
        expect(created?.title).toBe(scenario.firstInput.title);
        if (scenario.firstInput.projectId === undefined) {
          const inbox = await context.projects.get(context.ownerA, created?.projectId as Id);
          expect(inbox?.title).toBe('Inbox');
        }

        const listed = await listAll(context.repo, context.ownerA, { limit: 100 });
        expect(listed.filter((task) => task.id === createdId)).toHaveLength(1);
      }
    });

    it('completes a task once and treats completing a done task as a version-stable no-op', async () => {
      const project = await createProject(context, context.ownerA, 'project-complete');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Finish me',
        'task-complete',
      );

      const completed = await context.repo.complete(
        context.ownerA,
        created.id,
        created.version,
      );
      expect(completed.status).toBe('done');
      expect(completed.version).toBe(created.version + 1);

      const repeated = await context.repo.complete(
        context.ownerA,
        created.id,
        completed.version,
      );
      expect(repeated.status).toBe('done');
      expect(repeated.version).toBe(completed.version);
    });

    it('rejects stale, foreign, and post-completion complete calls without changing state', async () => {
      const project = await createProject(context, context.ownerA, 'project-complete-negative');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Complete guards',
        'task-complete-negative',
      );
      const cursorBeforeDone = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;

      await expect(
        context.repo.complete(
          context.ownerA,
          created.id,
          (created.version + 1) as Version,
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await context.repo.get(context.ownerA, created.id)).toEqual(created);
      expect(
        (await context.repo.listChangedSince(context.ownerA, cursorBeforeDone)).changes,
      ).toEqual([]);

      const completed = await context.repo.complete(
        context.ownerA,
        created.id,
        created.version,
      );
      const cursorAfterDone = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;

      await expect(
        context.repo.complete(context.ownerA, created.id, created.version),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await context.repo.get(context.ownerA, created.id)).toEqual(completed);
      expect(
        (await context.repo.listChangedSince(context.ownerA, cursorAfterDone)).changes,
      ).toEqual([]);

      await expect(
        context.repo.complete(context.ownerB, created.id, completed.version),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await context.repo.get(context.ownerA, created.id)).toEqual(completed);
    });

    it('soft deletes tasks, hides them from get and list, and rejects stale versions', async () => {
      const project = await createProject(context, context.ownerA, 'project-delete');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Delete me',
        'task-delete',
      );

      await expect(
        context.repo.softDelete(
          context.ownerA,
          created.id,
          (created.version + 1) as Version,
        ),
      ).rejects.toBeInstanceOf(VersionConflictError);
      expect(await context.repo.get(context.ownerA, created.id)).not.toBeNull();

      const recorded = await context.repo.softDelete(
        context.ownerA,
        created.id,
        created.version,
      );
      if (context.repo.capabilities.softDeleteReturnsVersion === true) {
        expect(recorded).toBe(created.version + 1);
      } else {
        expect(recorded).toBeUndefined();
      }

      expect(await context.repo.get(context.ownerA, created.id)).toBeNull();
      const page = await context.repo.list(context.ownerA, {
        projectId: project.id,
        limit: 100,
      });
      expect(page.items.some((task) => task.id === created.id)).toBe(false);
    });

    it('rejects dependency cycles with DependencyCycleError', async () => {
      const project = await createProject(context, context.ownerA, 'project-cycle');
      const first = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'First',
        'task-cycle-a',
      );
      const second = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Second',
        'task-cycle-b',
        { dependsOn: [first.id] },
      );

      await expect(
        context.repo.update(
          context.ownerA,
          first.id,
          { dependsOn: [second.id] },
          first.version,
        ),
      ).rejects.toBeInstanceOf(DependencyCycleError);
    });

    it("rejects a dependency on another owner's task with NotFoundError", async () => {
      const projectA = await createProject(context, context.ownerA, 'project-dep-a');
      const projectB = await createProject(context, context.ownerB, 'project-dep-b');
      const owned = await createTask(
        context.repo,
        context.ownerA,
        projectA.id,
        'Private',
        'task-dep-owned',
      );

      await expect(
        createTask(
          context.repo,
          context.ownerB,
          projectB.id,
          'Depends on foreign',
          'task-dep-foreign',
          { dependsOn: [owned.id] },
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('isolates owners by returning NotFound instead of Forbidden', async () => {
      const project = await createProject(context, context.ownerA, 'project-owner');
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Owner A only',
        'task-owner',
      );

      expect(await context.repo.get(context.ownerB, created.id)).toBeNull();
      await expect(
        context.repo.update(context.ownerB, created.id, { title: 'Hijacked' }, created.version),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        context.repo.softDelete(context.ownerB, created.id, created.version),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await context.repo.get(context.ownerA, created.id)).not.toBeNull();
    });

    it('creates a real owner-local Inbox project when projectId is omitted', async () => {
      const first = await context.repo.create(
        context.ownerA,
        { title: 'Without project' },
        'task-inbox-first',
      );
      const second = await context.repo.create(
        context.ownerA,
        { title: 'Without project again' },
        'task-inbox-second',
      );

      expect(first.projectId).toBe(second.projectId);
      const inbox = await context.projects.get(context.ownerA, first.projectId);
      expect(inbox).not.toBeNull();
      expect(inbox?.ownerId).toBe(context.ownerA);
      expect(inbox?.kind).toBe('inbox');
      expect(inbox?.title).toBe('Inbox');
      expect(await context.projects.get(context.ownerB, first.projectId)).toBeNull();

      const projects = await context.projects.list(context.ownerA, { limit: 100 });
      expect(projects.items.some((project) => project.id === first.projectId)).toBe(true);
    });

    it('returns exactly one Inbox per owner, including concurrent first calls', async (testContext) => {
      if (!supportsInbox(context.projects)) {
        skipWithReason(testContext, 'adapter does not implement ADR-018 getInbox yet.');
        return;
      }

      const [first, second] = await Promise.all([
        context.projects.getInbox(context.ownerA),
        context.projects.getInbox(context.ownerA),
      ]);
      expect(second.id).toBe(first.id);
      expect(first.ownerId).toBe(context.ownerA);
      expect(first.kind).toBe('inbox');
      expect(first.title).toBe('Inbox');

      const again = await context.projects.getInbox(context.ownerA);
      expect(again).toEqual(first);

      const otherOwner = await context.projects.getInbox(context.ownerB);
      expect(otherOwner.id).not.toBe(first.id);
      expect(otherOwner.ownerId).toBe(context.ownerB);
      expect(otherOwner.kind).toBe('inbox');

      const projects = await context.projects.list(context.ownerA, { limit: 100 });
      expect(projects.items.filter((project) => project.kind === 'inbox')).toHaveLength(1);
    });

    it('rejects archiving (deleting) the Inbox with ValidationFailedError', async (testContext) => {
      if (!supportsInbox(context.projects)) {
        skipWithReason(testContext, 'adapter does not implement ADR-018 getInbox yet.');
        return;
      }

      const inbox = await context.projects.getInbox(context.ownerA);
      await expect(
        context.projects.update(context.ownerA, inbox.id, { archived: true }, inbox.version),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(await context.projects.get(context.ownerA, inbox.id)).toEqual(inbox);

      const renamed = await context.projects.update(
        context.ownerA,
        inbox.id,
        { title: 'Capture' },
        inbox.version,
      );
      expect(renamed.kind).toBe('inbox');
      expect(renamed.title).toBe('Capture');
    });

    it('rejects foreign and nonexistent project references on create and update', async () => {
      const projectA = await createProject(context, context.ownerA, 'project-ref-a');
      const projectB = await createProject(context, context.ownerB, 'project-ref-b');
      const missingProjectId = context.ids.next();
      const cursorBeforeCreates = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;

      const beforeForeignCreate = await listAll(context.repo, context.ownerB, { limit: 100 });
      await expect(
        context.repo.create(
          context.ownerB,
          { projectId: projectA.id, title: 'Foreign project' },
          'task-foreign-project',
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        context.repo.create(
          context.ownerA,
          { projectId: missingProjectId, title: 'Missing project' },
          'task-missing-project',
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(await listAll(context.repo, context.ownerB, { limit: 100 })).toEqual(
        beforeForeignCreate,
      );
      expect(
        (await context.repo.listChangedSince(context.ownerA, cursorBeforeCreates)).changes,
      ).toEqual([]);

      const created = await createTask(
        context.repo,
        context.ownerA,
        projectA.id,
        'Owned',
        'task-project-ref',
      );
      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;
      await expect(
        context.repo.update(
          context.ownerA,
          created.id,
          { projectId: projectB.id },
          created.version,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        context.repo.update(
          context.ownerA,
          created.id,
          { projectId: missingProjectId },
          created.version,
        ),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(await context.repo.get(context.ownerA, created.id)).toEqual(created);
      expect((await context.repo.listChangedSince(context.ownerA, cursor)).changes).toEqual([]);
    });

    it('streams only owner-local changes for creates, updates and deletes', async () => {
      const projectA = await createProject(context, context.ownerA, 'changes-owner-a');
      const projectB = await createProject(context, context.ownerB, 'changes-owner-b');

      context.clock.advance(1_000);
      const ownedA = await createTask(
        context.repo,
        context.ownerA,
        projectA.id,
        'A change',
        'changes-owner-task-a',
      );
      const ownedB = await createTask(
        context.repo,
        context.ownerB,
        projectB.id,
        'B change',
        'changes-owner-task-b',
      );
      context.clock.advance(1_000);
      const updatedA = await context.repo.update(
        context.ownerA,
        ownedA.id,
        { title: 'A updated' },
        ownedA.version,
      );
      const updatedB = await context.repo.update(
        context.ownerB,
        ownedB.id,
        { title: 'B updated' },
        ownedB.version,
      );
      context.clock.advance(1_000);
      await context.repo.softDelete(context.ownerA, ownedA.id, updatedA.version);
      await context.repo.softDelete(context.ownerB, ownedB.id, updatedB.version);

      const changesA = await context.repo.listChangedSince(context.ownerA, null);
      expect(changesA.changes.map((change) => change.id)).toEqual([
        ownedA.id,
        ownedA.id,
        ownedA.id,
      ]);
      expect(changesA.changes.map((change) => change.version)).toEqual([
        ownedA.version,
        updatedA.version,
        updatedA.version + 1,
      ]);
      expect(changesA.changes[2]?.deletedAt).toBeDefined();
      expect(changesA.changes.some((change) => change.id === ownedB.id)).toBe(false);

      const changesB = await context.repo.listChangedSince(context.ownerB, null);
      expect(changesB.changes.map((change) => change.id)).toEqual([
        ownedB.id,
        ownedB.id,
        ownedB.id,
      ]);
      expect(changesB.changes.map((change) => change.version)).toEqual([
        ownedB.version,
        updatedB.version,
        updatedB.version + 1,
      ]);
      expect(changesB.changes[2]?.deletedAt).toBeDefined();
      expect(changesB.changes.some((change) => change.id === ownedA.id)).toBe(false);

      const newA = await createTask(
        context.repo,
        context.ownerA,
        projectA.id,
        'A after cursor',
        'changes-owner-task-a2',
      );
      const newB = await createTask(
        context.repo,
        context.ownerB,
        projectB.id,
        'B after cursor',
        'changes-owner-task-b2',
      );
      const incrementalA = await context.repo.listChangedSince(
        context.ownerA,
        changesA.cursor,
      );
      expect(incrementalA.changes.map((change) => change.id)).toEqual([newA.id]);
      expect(incrementalA.changes.map((change) => change.version)).toEqual([newA.version]);
      const incrementalB = await context.repo.listChangedSince(
        context.ownerB,
        changesB.cursor,
      );
      expect(incrementalB.changes.map((change) => change.id)).toEqual([newB.id]);
      expect(incrementalB.changes.map((change) => change.version)).toEqual([newB.version]);
    });

    it('streams creates, updates and deletes after a cursor exactly once in order, including same-millisecond changes', async () => {
      const project = await createProject(context, context.ownerA, 'project-changes');
      const initial = await context.repo.listChangedSince(context.ownerA, null);
      expect(initial.changes).toEqual([]);

      context.clock.advance(1_000);
      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Changed',
        'task-changes',
      );
      context.clock.advance(1_000);
      const firstUpdate = await context.repo.update(
        context.ownerA,
        created.id,
        { title: 'Changed once' },
        created.version,
      );
      const secondUpdate = await context.repo.update(
        context.ownerA,
        created.id,
        { description: 'same millisecond' },
        firstUpdate.version,
      );
      await context.repo.softDelete(
        context.ownerA,
        created.id,
        secondUpdate.version,
      );
      const other = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Other',
        'task-changes-other',
      );

      const page = await context.repo.listChangedSince(context.ownerA, initial.cursor);
      expect(page.changes).toHaveLength(5);
      expect(page.changes.map((change) => change.id)).toEqual([
        created.id,
        created.id,
        created.id,
        created.id,
        other.id,
      ]);
      expect(page.changes.map((change) => change.version)).toEqual([
        created.version,
        firstUpdate.version,
        secondUpdate.version,
        secondUpdate.version + 1,
        other.version,
      ]);
      expect(page.changes[0]?.deletedAt).toBeUndefined();
      expect(page.changes[1]?.deletedAt).toBeUndefined();
      expect(page.changes[2]?.deletedAt).toBeUndefined();
      expect(page.changes[3]?.deletedAt).toBeDefined();

      const drained = await context.repo.listChangedSince(context.ownerA, page.cursor);
      expect(drained.changes).toEqual([]);

      const replay = await context.repo.listChangedSince(context.ownerA, initial.cursor);
      expect(replay.changes.map((change) => change.version)).toEqual(
        page.changes.map((change) => change.version),
      );
    });

    it('continues the change feed incrementally after a consumed nonempty cursor, same-millisecond writes, and an empty drain', async () => {
      const project = await createProject(context, context.ownerA, 'project-changes-incremental');
      const initial = await context.repo.listChangedSince(context.ownerA, null);

      context.clock.advance(1_000);
      const first = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'First change',
        'changes-incremental-first',
      );
      const batch = await context.repo.listChangedSince(context.ownerA, initial.cursor);
      expect(batch.changes.map((change) => change.id)).toEqual([first.id]);
      expect(batch.changes.map((change) => change.version)).toEqual([first.version]);

      const updated = await context.repo.update(
        context.ownerA,
        first.id,
        { title: 'First updated' },
        first.version,
      );
      const second = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Second change',
        'changes-incremental-second',
      );
      await context.repo.softDelete(context.ownerA, second.id, second.version);

      const incremental = await context.repo.listChangedSince(
        context.ownerA,
        batch.cursor,
      );
      expect(incremental.changes.map((change) => change.id)).toEqual([
        first.id,
        second.id,
        second.id,
      ]);
      expect(incremental.changes.map((change) => change.version)).toEqual([
        updated.version,
        second.version,
        second.version + 1,
      ]);
      expect(incremental.changes[0]?.deletedAt).toBeUndefined();
      expect(incremental.changes[1]?.deletedAt).toBeUndefined();
      expect(incremental.changes[2]?.deletedAt).toBeDefined();

      const keys = incremental.changes.map(
        (change) => `${change.id}:${change.version}:${change.deletedAt ?? ''}`,
      );
      expect(new Set(keys).size).toBe(keys.length);

      const drained = await context.repo.listChangedSince(
        context.ownerA,
        incremental.cursor,
      );
      expect(drained.changes).toEqual([]);

      const third = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'After drain',
        'changes-incremental-third',
      );
      const afterDrain = await context.repo.listChangedSince(
        context.ownerA,
        drained.cursor,
      );
      expect(afterDrain.changes.map((change) => change.id)).toEqual([third.id]);
      expect(afterDrain.changes.map((change) => change.version)).toEqual([third.version]);
    });

    it('rejects invalid create input with ValidationFailedError without writing', async () => {
      const project = await createProject(context, context.ownerA, 'project-validation');
      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;

      await expect(
        context.repo.create(
          context.ownerA,
          { projectId: project.id, title: '' },
          'task-invalid-title',
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);

      await expect(
        context.repo.create(
          context.ownerA,
          {
            projectId: project.id,
            title: 'Timezone-less date',
            dueAt: '2026-11-20T14:59:00' as Instant,
          },
          'task-invalid-instant',
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);

      expect(await listAll(context.repo, context.ownerA, { limit: 100 })).toEqual([]);
      expect((await context.repo.listChangedSince(context.ownerA, cursor)).changes).toEqual([]);
    });

    it('rejects impossible calendar dates before UTC normalization without writing', async () => {
      const project = await createProject(context, context.ownerA, 'project-calendar');
      const impossibleDate = '2026-02-30T12:00:00+09:00' as Instant;
      const cursor = (await context.repo.listChangedSince(context.ownerA, null)).cursor;

      await expect(
        context.repo.create(
          context.ownerA,
          { projectId: project.id, title: 'Impossible calendar date', dueAt: impossibleDate },
          'task-impossible-calendar',
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(await listAll(context.repo, context.ownerA, { limit: 100 })).toEqual([]);
      expect((await context.repo.listChangedSince(context.ownerA, cursor)).changes).toEqual([]);

      const created = await createTask(
        context.repo,
        context.ownerA,
        project.id,
        'Valid calendar date',
        'task-valid-calendar',
      );
      const cursorAfterCreate = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;

      await expect(
        context.repo.update(
          context.ownerA,
          created.id,
          { dueAt: impossibleDate },
          created.version,
        ),
      ).rejects.toBeInstanceOf(ValidationFailedError);
      expect(await context.repo.get(context.ownerA, created.id)).toEqual(created);
      expect(
        (await context.repo.listChangedSince(context.ownerA, cursorAfterCreate)).changes,
      ).toEqual([]);
    });

    it('replays idempotent creates and rejects key reuse with a different body', async (
      testContext,
    ) => {
      if (!context.repo.capabilities.idempotentCreate) {
        skipWithReason(
          testContext,
          'adapter declares idempotentCreate=false; the API layer compensates per ADR-016.',
        );
        return;
      }

      const project = await createProject(context, context.ownerA, 'project-idem');
      const input: TaskCreate = { projectId: project.id, title: 'Idempotent task' };

      const first = await context.repo.create(context.ownerA, input, 'idem-key');
      const replay = await context.repo.create(context.ownerA, input, 'idem-key');
      expect(replay).toEqual(first);

      await expect(
        context.repo.create(context.ownerA, { ...input, title: 'Different body' }, 'idem-key'),
      ).rejects.toBeInstanceOf(IdempotencyMismatchError);

      const projectB = await createProject(context, context.ownerB, 'project-idem-b');
      const otherOwner = await context.repo.create(
        context.ownerB,
        { projectId: projectB.id, title: 'Idempotent task' },
        'idem-key',
      );
      expect(otherOwner.id).not.toBe(first.id);
    });

    it('replays the original create response after later update, complete and delete without duplicate changes', async (
      testContext,
    ) => {
      if (!context.repo.capabilities.idempotentCreate) {
        skipWithReason(
          testContext,
          'adapter declares idempotentCreate=false; response replay belongs to the API layer per ADR-016.',
        );
        return;
      }

      const project = await createProject(context, context.ownerA, 'project-idem-replay');
      const input: TaskCreate = { projectId: project.id, title: 'Original response' };
      const first = await context.repo.create(context.ownerA, input, 'idem-replay-key');
      const cursorAfterCreate = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;

      const updated = await context.repo.update(
        context.ownerA,
        first.id,
        { title: 'Changed later' },
        first.version,
      );
      const completed = await context.repo.complete(
        context.ownerA,
        first.id,
        updated.version,
      );
      const replayAfterMutations = await context.repo.create(
        context.ownerA,
        input,
        'idem-replay-key',
      );
      expect(replayAfterMutations).toEqual(first);
      expect(replayAfterMutations.version).toBe(first.version);
      expect(replayAfterMutations.status).toBe(first.status);

      const changesAfterReplay = await context.repo.listChangedSince(
        context.ownerA,
        cursorAfterCreate,
      );
      expect(changesAfterReplay.changes.map((change) => change.version)).toEqual([
        updated.version,
        completed.version,
      ]);

      const cursorBeforeDelete = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;
      await context.repo.softDelete(context.ownerA, first.id, completed.version);
      const replayAfterDelete = await context.repo.create(
        context.ownerA,
        input,
        'idem-replay-key',
      );
      expect(replayAfterDelete).toEqual(first);
      expect(replayAfterDelete.deletedAt).toBeUndefined();

      const changesAfterDelete = await context.repo.listChangedSince(
        context.ownerA,
        cursorBeforeDelete,
      );
      expect(changesAfterDelete.changes).toHaveLength(1);
      expect(changesAfterDelete.changes[0]?.version).toBe(completed.version + 1);
      expect(changesAfterDelete.changes[0]?.deletedAt).toBeDefined();

      const cursorAfterDelete = (
        await context.repo.listChangedSince(context.ownerA, null)
      ).cursor;
      await context.repo.create(context.ownerA, input, 'idem-replay-key');
      expect(
        (await context.repo.listChangedSince(context.ownerA, cursorAfterDelete)).changes,
      ).toEqual([]);
    });
  });
}
