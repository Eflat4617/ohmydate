import type { Id, SessionWindow, TaskPriority, TaskStatus } from '@ohmydate/domain';

/**
 * Fields that have no Vikunja representation and therefore live in the planner
 * database (ADR-004 / ADR-016).
 *
 * - `splittable` and `session` are planner-only concepts.
 * - `priority` is intentionally planner-only even though Vikunja exposes a
 *   numeric priority column; the planner scale (1..4) must not be conflated
 *   with the upstream field (the provider task later owns that column).
 * - `status` is split: `done` comes from Vikunja's boolean, while
 *   `in_progress` can only be restored from this store. `todo` is the fallback.
 * - `dependsOn` mirrors the Vikunja `blocked` relations so list/get responses
 *   stay stable without an extra relation walk; remote relations remain the
 *   authority when building a single task.
 */
export interface PlannerTaskFields {
  readonly splittable: boolean;
  readonly session?: SessionWindow;
  readonly priority: TaskPriority;
  readonly status: TaskStatus;
  readonly dependsOn: readonly Id[];
}

/**
 * Storage port for planner-only fields. Reads/writes are asynchronous because a
 * durable implementation (PostgreSQL in `services/api`) may need I/O; the
 * in-memory implementation resolves immediately.
 */
export interface PlannerFieldStore {
  getTask(entityId: Id): Promise<PlannerTaskFields | null>;
  putTask(entityId: Id, fields: PlannerTaskFields): Promise<void>;
}

export class InMemoryPlannerFieldStore implements PlannerFieldStore {
  readonly #tasks = new Map<string, PlannerTaskFields>();

  async getTask(entityId: Id): Promise<PlannerTaskFields | null> {
    return this.#tasks.get(entityId) ?? null;
  }

  async putTask(entityId: Id, fields: PlannerTaskFields): Promise<void> {
    this.#tasks.set(entityId, fields);
  }
}

export function defaultPlannerTaskFields(): PlannerTaskFields {
  return {
    splittable: false,
    priority: 2,
    status: 'todo',
    dependsOn: [],
  };
}
