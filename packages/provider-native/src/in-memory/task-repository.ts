import {
  IdempotencyMismatchError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  assertAcyclic,
  type DependencyEdge,
  type Id,
  type Instant,
  type Page,
  type RepositoryCapabilities,
  type Task,
  type TaskChange,
  type TaskChangePage,
  type TaskCreate,
  type TaskPatch,
  type TaskQuery,
  type TaskRepository,
  type Version,
} from '@ohmydate/domain';
import {
  decodeChangeCursor,
  decodeListCursor,
  encodeChangeCursor,
  encodeListCursor,
} from './cursor.js';
import {
  canonicalJson,
  cloneTask,
  compareCreatedAt,
  type InMemoryTaskRepositoryOptions,
} from './support.js';
import { validateTaskCreate, validateTaskPatch } from './validation.js';

interface ChangeRecord {
  readonly sequence: number;
  readonly id: Id;
  readonly version: Version;
  readonly deletedAt?: Instant;
}

type CreateOutcome =
  | { readonly ok: true; readonly task: Task }
  | { readonly ok: false; readonly error: unknown };

interface PendingIdempotencyRecord {
  readonly status: 'pending';
  readonly requestHash: string;
  readonly promise: Promise<CreateOutcome>;
  readonly settle: (outcome: CreateOutcome) => void;
}

interface CommittedIdempotencyRecord {
  readonly status: 'committed';
  readonly requestHash: string;
  readonly response: Task;
}

type IdempotencyRecord = PendingIdempotencyRecord | CommittedIdempotencyRecord;

const CAPABILITIES: RepositoryCapabilities = {
  strictConcurrency: true,
  idempotentCreate: true,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class InMemoryTaskRepository implements TaskRepository {
  readonly capabilities: RepositoryCapabilities = CAPABILITIES;

  readonly #clock: InMemoryTaskRepositoryOptions['clock'];
  readonly #ids: InMemoryTaskRepositoryOptions['ids'];
  readonly #projects: InMemoryTaskRepositoryOptions['projects'];
  readonly #tasks = new Map<string, Task>();
  readonly #changes = new Map<string, ChangeRecord[]>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();

  #sequence = 0;

  constructor(options: InMemoryTaskRepositoryOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
    this.#projects = options.projects;
  }

  async create(ownerId: Id, input: TaskCreate, idemKey: string): Promise<Task> {
    const normalized = validateTaskCreate(input);
    const requestHash = canonicalJson(normalized);
    const idempotencyId = `${ownerId}:${idemKey}`;
    const existing = this.#idempotency.get(idempotencyId);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError();
      if (existing.status === 'committed') return cloneTask(existing.response);
      const outcome = await existing.promise;
      if (!outcome.ok) throw outcome.error;
      return cloneTask(outcome.task);
    }

    let settle!: (outcome: CreateOutcome) => void;
    const promise = new Promise<CreateOutcome>((resolve) => {
      settle = resolve;
    });
    const pending: PendingIdempotencyRecord = {
      status: 'pending',
      requestHash,
      promise,
      settle,
    };
    this.#idempotency.set(idempotencyId, pending);

    try {
      const projectId =
        normalized.projectId === undefined
          ? (await this.#projects.getInbox(ownerId)).id
          : await this.#requireProject(ownerId, normalized.projectId);

      const id = this.#ids.next();
      this.#assertDependencies(ownerId, normalized.dependsOn);
      this.#assertAcyclic(ownerId, { id, dependsOn: normalized.dependsOn });

      const now = this.#clock.now();
      const task: Task = {
        id,
        ownerId,
        projectId,
        title: normalized.title,
        ...(normalized.description === undefined ? {} : { description: normalized.description }),
        status: normalized.status,
        ...(normalized.dueAt === undefined ? {} : { dueAt: normalized.dueAt }),
        splittable: normalized.splittable,
        ...(normalized.session === undefined ? {} : { session: { ...normalized.session } }),
        priority: normalized.priority,
        dependsOn: [...normalized.dependsOn],
        version: 1 as Version,
        createdAt: now,
        updatedAt: now,
        external: [],
      };

      const response = cloneTask(task);
      this.#tasks.set(id, task);
      this.#idempotency.set(idempotencyId, {
        status: 'committed',
        requestHash,
        response,
      });
      this.#recordChange(ownerId, task);
      pending.settle({ ok: true, task: response });
      return cloneTask(response);
    } catch (error) {
      if (this.#idempotency.get(idempotencyId) === pending) {
        this.#idempotency.delete(idempotencyId);
      }
      pending.settle({ ok: false, error });
      throw error;
    }
  }

  async get(ownerId: Id, id: Id): Promise<Task | null> {
    const task = this.#tasks.get(id);
    if (task === undefined || task.ownerId !== ownerId || task.deletedAt !== undefined) {
      return null;
    }
    return cloneTask(task);
  }

  async list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodeListCursor(query.cursor);

    let tasks = [...this.#tasks.values()].filter(
      (task) =>
        task.ownerId === ownerId &&
        task.deletedAt === undefined &&
        (query.projectId === undefined || task.projectId === query.projectId) &&
        (query.status === undefined || task.status === query.status),
    );
    if (cursor !== null) {
      tasks = tasks.filter((task) => compareCreatedAt(task, cursor) > 0);
    }
    tasks.sort(compareCreatedAt);

    const items = tasks.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      last === undefined || tasks.length <= items.length
        ? null
        : encodeListCursor({ createdAt: last.createdAt, id: last.id });

    return { items: items.map((task) => cloneTask(task)), nextCursor };
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: TaskPatch,
    expectedVersion: Version,
  ): Promise<Task> {
    const normalized = validateTaskPatch(patch);
    const resolvedProjectId =
      normalized.projectId === undefined
        ? undefined
        : await this.#requireProject(ownerId, normalized.projectId);

    const current = this.#requireForUpdate(ownerId, id, expectedVersion);
    const dependsOn = normalized.dependsOn ?? current.dependsOn;
    this.#assertDependencies(ownerId, dependsOn);
    this.#assertAcyclic(ownerId, { id, dependsOn });

    const description =
      normalized.description === null
        ? undefined
        : (normalized.description ?? current.description);
    const dueAt =
      normalized.dueAt === null ? undefined : (normalized.dueAt ?? current.dueAt);
    const session =
      normalized.session === null ? undefined : (normalized.session ?? current.session);

    const task: Task = {
      id,
      ownerId,
      projectId: resolvedProjectId ?? current.projectId,
      title: normalized.title ?? current.title,
      ...(description === undefined ? {} : { description }),
      status: normalized.status ?? current.status,
      ...(dueAt === undefined ? {} : { dueAt }),
      splittable: normalized.splittable ?? current.splittable,
      ...(session === undefined ? {} : { session: { ...session } }),
      priority: normalized.priority ?? current.priority,
      dependsOn: [...dependsOn],
      version: (current.version + 1) as Version,
      createdAt: current.createdAt,
      updatedAt: this.#clock.now(),
      external: [...current.external],
    };

    this.#tasks.set(id, task);
    this.#recordChange(ownerId, task);
    return cloneTask(task);
  }

  async complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task> {
    const current = this.#requireOwned(ownerId, id);
    this.#assertVersion(current, expectedVersion);
    if (current.status === 'done') return cloneTask(current);

    const now = this.#clock.now();
    const task: Task = {
      ...current,
      status: 'done',
      version: (current.version + 1) as Version,
      updatedAt: now,
    };
    this.#tasks.set(id, task);
    this.#recordChange(ownerId, task);
    return cloneTask(task);
  }

  async softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Version> {
    const current = this.#requireOwned(ownerId, id);
    this.#assertVersion(current, expectedVersion);

    const now = this.#clock.now();
    const task: Task = {
      ...current,
      version: (current.version + 1) as Version,
      updatedAt: now,
      deletedAt: now,
    };
    this.#tasks.set(id, task);
    this.#recordChange(ownerId, task);
    return task.version;
  }

  async listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage> {
    const after = decodeChangeCursor(cursor);
    const log = this.#changes.get(ownerId) ?? [];
    const entries = log.filter((entry) => entry.sequence > after);
    const changes: TaskChange[] = entries.map((entry) => ({
      id: entry.id,
      version: entry.version,
      ...(entry.deletedAt === undefined ? {} : { deletedAt: entry.deletedAt }),
    }));
    const last = entries[entries.length - 1];
    return {
      changes,
      cursor: encodeChangeCursor(last === undefined ? after : last.sequence),
    };
  }

  #requireOwned(ownerId: Id, id: Id): Task {
    const task = this.#tasks.get(id);
    if (task === undefined || task.ownerId !== ownerId || task.deletedAt !== undefined) {
      throw new NotFoundError('task', id);
    }
    return task;
  }

  #requireForUpdate(ownerId: Id, id: Id, expectedVersion: Version): Task {
    const task = this.#tasks.get(id);
    if (task === undefined || task.ownerId !== ownerId) {
      throw new NotFoundError('task', id);
    }
    if (task.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, task.version);
    }
    if (task.deletedAt !== undefined) throw new NotFoundError('task', id);
    return task;
  }

  #assertVersion(task: Task, expectedVersion: Version): void {
    if (task.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, task.version);
    }
  }

  #assertDependencies(ownerId: Id, dependsOn: readonly Id[]): void {
    for (const dependencyId of dependsOn) {
      const dependency = this.#tasks.get(dependencyId);
      if (
        dependency === undefined ||
        dependency.ownerId !== ownerId ||
        dependency.deletedAt !== undefined
      ) {
        throw new NotFoundError('task', dependencyId);
      }
    }
  }

  #assertAcyclic(
    ownerId: Id,
    prospective?: { readonly id: Id; readonly dependsOn: readonly Id[] },
  ): void {
    const edges: DependencyEdge[] = [];
    for (const task of this.#tasks.values()) {
      if (task.ownerId !== ownerId || task.deletedAt !== undefined) continue;
      const dependsOn =
        prospective !== undefined && prospective.id === task.id
          ? prospective.dependsOn
          : task.dependsOn;
      for (const dependencyId of dependsOn) {
        edges.push({ taskId: task.id, dependsOnTaskId: dependencyId });
      }
    }
    if (prospective !== undefined && !this.#tasks.has(prospective.id)) {
      for (const dependencyId of prospective.dependsOn) {
        edges.push({ taskId: prospective.id, dependsOnTaskId: dependencyId });
      }
    }
    assertAcyclic(edges);
  }

  async #requireProject(ownerId: Id, projectId: Id): Promise<Id> {
    const project = await this.#projects.get(ownerId, projectId);
    if (project === null) throw new NotFoundError('project', projectId);
    return project.id;
  }

  #recordChange(ownerId: Id, task: Task): void {
    this.#sequence += 1;
    const log = this.#changes.get(ownerId) ?? [];
    log.push({
      sequence: this.#sequence,
      id: task.id,
      version: task.version,
      ...(task.deletedAt === undefined ? {} : { deletedAt: task.deletedAt }),
    });
    this.#changes.set(ownerId, log);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationFailedError([
      { path: 'limit', message: `expected an integer between 1 and ${MAX_LIMIT}` },
    ]);
  }
  return limit;
}
