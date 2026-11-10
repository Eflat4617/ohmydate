import type { TestContext } from 'vitest';
import {
  DependencyCycleError,
  IdempotencyMismatchError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  isInstant,
  isUuidV7,
  type Id,
  type IdGenerator,
  type Instant,
  type Project,
  type ProjectRepository,
  type Task,
  type TaskCreate,
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

      await context.repo.softDelete(context.ownerA, created.id, created.version);

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

    it('rejects invalid input with ValidationFailedError', async () => {
      const project = await createProject(context, context.ownerA, 'project-validation');

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
  });
}
