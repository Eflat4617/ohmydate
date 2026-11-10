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

  async list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>> {
    await this.ensureInbox(ownerId);
    return this.#projects.list(ownerId, query);
  }

  create(ownerId: Id, input: ProjectCreate, idempotencyKey: string): Promise<Project> {
    return this.#projects.create(ownerId, input, idempotencyKey);
  }

  /** ADR-018: the served repository owns the Inbox and creates it on demand. */
  ensureInbox(ownerId: Id): Promise<Project> {
    return this.#projects.getInbox(ownerId);
  }
}
