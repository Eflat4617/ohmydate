import { NotFoundError } from '@ohmydate/domain';
import type {
  Id,
  Page,
  Task,
  TaskCreate,
  TaskPatch,
  TaskQuery,
  TaskRepository,
  Version,
} from '@ohmydate/domain';

export interface TaskDependencyResult {
  readonly taskId: Id;
  readonly dependsOnTaskId: Id;
  readonly version: Version;
}

export class TaskService {
  readonly #tasks: TaskRepository;

  constructor(tasks: TaskRepository) {
    this.#tasks = tasks;
  }

  create(ownerId: Id, input: TaskCreate, idempotencyKey: string): Promise<Task> {
    return this.#tasks.create(ownerId, input, idempotencyKey);
  }

  get(ownerId: Id, id: Id): Promise<Task | null> {
    return this.#tasks.get(ownerId, id);
  }

  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>> {
    return this.#tasks.list(ownerId, query);
  }

  update(ownerId: Id, id: Id, patch: TaskPatch, expectedVersion: Version): Promise<Task> {
    return this.#tasks.update(ownerId, id, patch, expectedVersion);
  }

  complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task> {
    return this.#tasks.complete(ownerId, id, expectedVersion);
  }

  async remove(ownerId: Id, id: Id, expectedVersion: Version): Promise<Version> {
    await this.#tasks.softDelete(ownerId, id, expectedVersion);
    return (expectedVersion + 1) as Version;
  }

  /**
   * The repository port models dependencies as part of a task patch; this
   * endpoint appends one edge to the existing set.
   */
  async addDependency(
    ownerId: Id,
    id: Id,
    dependsOnTaskId: Id,
    expectedVersion: Version,
  ): Promise<TaskDependencyResult> {
    const current = await this.#tasks.get(ownerId, id);
    if (current === null) throw new NotFoundError('task', id);
    const dependsOn = current.dependsOn.includes(dependsOnTaskId)
      ? current.dependsOn
      : [...current.dependsOn, dependsOnTaskId];
    const task = await this.#tasks.update(ownerId, id, { dependsOn }, expectedVersion);
    return { taskId: task.id, dependsOnTaskId, version: task.version };
  }
}
