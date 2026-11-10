import type { InMemoryRepositoryOptions } from './support.js';
import { InMemoryProjectRepository } from './project-repository.js';
import { InMemoryTaskRepository } from './task-repository.js';

export { InMemoryProjectRepository } from './project-repository.js';
export { InMemoryTaskRepository } from './task-repository.js';
export type { InMemoryRepositoryOptions } from './support.js';

export interface InMemoryRepositories {
  readonly tasks: InMemoryTaskRepository;
  readonly projects: InMemoryProjectRepository;
}

export function createInMemoryRepositories(
  options: InMemoryRepositoryOptions,
): InMemoryRepositories {
  return {
    tasks: new InMemoryTaskRepository(options),
    projects: new InMemoryProjectRepository(options),
  };
}
