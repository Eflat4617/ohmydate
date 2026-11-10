import type { Id, Instant, Version } from './brand.js';

export type TaskStatus = 'todo' | 'in_progress' | 'done';

export type TaskPriority = 1 | 2 | 3 | 4;

export interface SessionWindow {
  readonly minMinutes: number;
  readonly maxMinutes: number;
}

export interface ExternalProviderRef {
  readonly provider: 'vikunja';
  readonly externalId: string;
}

export interface Project {
  readonly id: Id;
  readonly ownerId: Id;
  readonly title: string;
  readonly archived: boolean;
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface Task {
  readonly id: Id;
  readonly ownerId: Id;
  readonly projectId: Id;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly dueAt?: Instant;
  readonly splittable: boolean;
  readonly session?: SessionWindow;
  readonly priority: TaskPriority;
  readonly dependsOn: readonly Id[];
  readonly version: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt?: Instant;
  readonly external: readonly ExternalProviderRef[];
}

export interface ProjectCreate {
  readonly title: string;
}

export interface ProjectPatch {
  readonly title?: string;
  readonly archived?: boolean;
}

export interface TaskCreate {
  readonly projectId?: Id;
  readonly title: string;
  readonly description?: string;
  readonly status?: TaskStatus;
  readonly dueAt?: Instant;
  readonly splittable?: boolean;
  readonly session?: SessionWindow;
  readonly priority?: TaskPriority;
  readonly dependsOn?: readonly Id[];
}

export interface TaskPatch {
  readonly projectId?: Id;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly dueAt?: Instant | null;
  readonly splittable?: boolean;
  readonly session?: SessionWindow | null;
  readonly priority?: TaskPriority;
  readonly dependsOn?: readonly Id[];
}
