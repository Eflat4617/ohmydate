import { NotFoundError, ValidationFailedError, VersionConflictError } from '@ohmydate/domain';
import type {
  Id,
  Page,
  Project,
  ProjectCreate,
  ProjectPatch,
  ProjectQuery,
  ProjectRepository,
  Version,
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
   * FOLD-01: renames and/or archives a project (a folder).
   *
   * The checks run in the same order on every repository: the project must
   * be the caller's (`NotFoundError`, also for another owner's id), the
   * version must be current (`VersionConflictError`), and only then the
   * rules below. The repository checks owner and version again when it
   * writes, so a change between the read and the write is still refused.
   *
   * - The Inbox cannot be archived. It can be renamed: it is found by
   *   `kind`, never by title (ADR-018).
   * - An archived project is renamed only by a patch that also brings it
   *   back (`archived: false`). The Vikunja provider refuses any other write
   *   to an archived project, and reports it as an outage.
   * - A patch without fields changes nothing: the repositories would give
   *   the project a new version for it, so it never reaches them.
   *
   * Tasks are never touched: archiving neither deletes nor moves them.
   */
  async update(
    ownerId: Id,
    id: Id,
    patch: ProjectPatch,
    expectedVersion: Version,
  ): Promise<Project> {
    const current = await this.#projects.get(ownerId, id);
    if (current === null) throw new NotFoundError('project', id);
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current.version);
    }
    if (current.kind === 'inbox' && patch.archived === true) {
      throw new ValidationFailedError([
        { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
      ]);
    }
    if (current.archived && patch.title !== undefined && patch.archived !== false) {
      throw new ValidationFailedError([
        { path: 'title', message: 'an archived project cannot be renamed; bring it back first' },
      ]);
    }
    if (patch.title === undefined && patch.archived === undefined) return current;
    return this.#projects.update(ownerId, id, patch, expectedVersion);
  }

  /** ADR-018: the served repository owns the Inbox and creates it on demand. */
  ensureInbox(ownerId: Id): Promise<Project> {
    return this.#projects.getInbox(ownerId);
  }
}
