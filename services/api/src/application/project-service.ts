import type {
  Id,
  Page,
  Project,
  ProjectCreate,
  ProjectQuery,
  ProjectRepository,
} from '@ohmydate/domain';

export class ProjectService {
  readonly #projects: ProjectRepository;

  constructor(projects: ProjectRepository) {
    this.#projects = projects;
  }

  list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>> {
    return this.#projects.list(ownerId, query);
  }

  create(ownerId: Id, input: ProjectCreate, idempotencyKey: string): Promise<Project> {
    return this.#projects.create(ownerId, input, idempotencyKey);
  }
}
