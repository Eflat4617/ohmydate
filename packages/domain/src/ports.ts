import type { Id, Instant, Version } from './brand.js';
import type {
  Project,
  ProjectCreate,
  ProjectPatch,
  Task,
  TaskCreate,
  TaskPatch,
  TaskStatus,
} from './entities.js';

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export interface TaskQuery {
  readonly projectId?: Id;
  readonly status?: TaskStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ProjectQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface TaskChange {
  readonly id: Id;
  readonly version: Version;
  readonly deletedAt?: Instant;
  /**
   * Planner-owned completion record (ADR-016 §4): set when this change records a completion of
   * an occurrence, including recurring tasks that the provider reopens. Consumers must treat it
   * as the source of truth for "completed" even if the current task status is todo.
   */
  readonly completedOccurrenceAt?: Instant;
}

export interface TaskChangePage {
  readonly changes: readonly TaskChange[];
  readonly cursor: string | null;
}

export interface RepositoryCapabilities {
  readonly strictConcurrency: boolean;
  readonly idempotentCreate: boolean;
}

export interface TaskRepository {
  readonly capabilities: RepositoryCapabilities;
  /**
   * `opts.plannedId` lets the caller supply the planner UUID (UUIDv7) before the
   * provider call so a retried create can be resolved by id/marker instead of
   * duplicating the upstream task. HTTP `POST /tasks` never sets it.
   *
   * Callers must serialize creates for the same `plannedId` (ADR-020 §5); the
   * intake approval path does this with a per-session PostgreSQL advisory lock.
   */
  create(
    ownerId: Id,
    input: TaskCreate,
    idemKey: string,
    opts?: { readonly plannedId?: Id },
  ): Promise<Task>;
  get(ownerId: Id, id: Id): Promise<Task | null>;
  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>>;
  update(ownerId: Id, id: Id, patch: TaskPatch, expectedVersion: Version): Promise<Task>;
  complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task>;
  /** FU-20: resolves with the new Version so callers need no change-feed scan. */
  softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Version>;
  listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage>;
}

export interface ProjectRepository {
  readonly capabilities: RepositoryCapabilities;
  create(ownerId: Id, input: ProjectCreate, idemKey: string): Promise<Project>;
  get(ownerId: Id, id: Id): Promise<Project | null>;
  list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>>;
  update(ownerId: Id, id: Id, patch: ProjectPatch, expectedVersion: Version): Promise<Project>;
  /**
   * ADR-018: returns the owner's Inbox, creating it on first call. Every
   * adapter must implement this; the idempotent implementation is part of the
   * shared contract suite.
   */
  getInbox(ownerId: Id): Promise<Project>;
}

export interface Clock {
  now(): Instant;
}

export interface IdGenerator {
  next(): Id;
}
