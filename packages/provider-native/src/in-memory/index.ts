import type { RepositoryDependencies } from './support.js';
import { InMemoryProjectRepository } from './project-repository.js';
import { InMemoryTaskRepository } from './task-repository.js';

export { InMemoryProjectRepository } from './project-repository.js';
export { InMemoryTaskRepository } from './task-repository.js';
export type {
  InMemoryRepositoryOptions,
  InMemoryTaskRepositoryOptions,
  ProjectLookup,
  RepositoryDependencies,
} from './support.js';

export interface InMemoryRepositories {
  readonly tasks: InMemoryTaskRepository;
  readonly projects: InMemoryProjectRepository;
}

export function createInMemoryRepositories(
  options: RepositoryDependencies,
): InMemoryRepositories {
  const projects = new InMemoryProjectRepository(options);
  return {
    tasks: new InMemoryTaskRepository({ ...options, projects }),
    projects,
  };
}
