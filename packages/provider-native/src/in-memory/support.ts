import type {
  Clock,
  Id,
  IdGenerator,
  Project,
  Task,
} from '@ohmydate/domain';

export interface RepositoryDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface ProjectLookup {
  get(ownerId: Id, id: Id): Promise<Project | null>;
  getInbox(ownerId: Id): Promise<Project>;
}

export type InMemoryRepositoryOptions = RepositoryDependencies;

export interface InMemoryTaskRepositoryOptions extends RepositoryDependencies {
  readonly projects: ProjectLookup;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function cloneTask(task: Task): Task {
  return {
    ...task,
    dependsOn: [...task.dependsOn],
    external: [...task.external],
    ...(task.session === undefined ? {} : { session: { ...task.session } }),
  };
}

export function cloneProject(project: Project): Project {
  return { ...project };
}

export function compareCreatedAt(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt < right.createdAt ? -1 : 1;
  }
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
