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
  create(ownerId: Id, input: TaskCreate, idemKey: string): Promise<Task>;
  get(ownerId: Id, id: Id): Promise<Task | null>;
  list(ownerId: Id, query: TaskQuery): Promise<Page<Task>>;
  update(ownerId: Id, id: Id, patch: TaskPatch, expectedVersion: Version): Promise<Task>;
  complete(ownerId: Id, id: Id, expectedVersion: Version): Promise<Task>;
  softDelete(ownerId: Id, id: Id, expectedVersion: Version): Promise<void>;
  listChangedSince(ownerId: Id, cursor: string | null): Promise<TaskChangePage>;
}

export interface ProjectRepository {
  readonly capabilities: RepositoryCapabilities;
  create(ownerId: Id, input: ProjectCreate, idemKey: string): Promise<Project>;
  get(ownerId: Id, id: Id): Promise<Project | null>;
  list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>>;
  update(ownerId: Id, id: Id, patch: ProjectPatch, expectedVersion: Version): Promise<Project>;
}

export interface Clock {
  now(): Instant;
}

export interface IdGenerator {
  next(): Id;
}
