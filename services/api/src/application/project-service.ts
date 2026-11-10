import {
  supportsInbox,
  type Id,
  type Page,
  type Project,
  type ProjectCreate,
  type ProjectQuery,
  type ProjectRepository,
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

  /**
   * ADR-018: the served repository owns the Inbox. Adapters that have not
   * adopted getInbox yet (Vikunja) are a no-op until their own task lands.
   */
  async ensureInbox(ownerId: Id): Promise<Project | undefined> {
    if (!supportsInbox(this.#projects)) return undefined;
    return this.#projects.getInbox(ownerId);
  }
}
