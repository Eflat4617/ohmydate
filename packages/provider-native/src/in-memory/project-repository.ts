import {
  IdempotencyMismatchError,
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Id,
  type Page,
  type Project,
  type ProjectCreate,
  type ProjectPatch,
  type ProjectQuery,
  type ProjectRepository,
  type RepositoryCapabilities,
  type Version,
} from '@ohmydate/domain';
import { decodeListCursor, encodeListCursor } from './cursor.js';
import {
  canonicalJson,
  cloneProject,
  compareCreatedAt,
  type InMemoryRepositoryOptions,
} from './support.js';
import { validateTitle } from './validation.js';

interface IdempotencyRecord {
  readonly requestHash: string;
  readonly response: Project;
}

const CAPABILITIES: RepositoryCapabilities = {
  strictConcurrency: true,
  idempotentCreate: true,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class InMemoryProjectRepository implements ProjectRepository {
  readonly capabilities: RepositoryCapabilities = CAPABILITIES;

  readonly #clock: InMemoryRepositoryOptions['clock'];
  readonly #ids: InMemoryRepositoryOptions['ids'];
  readonly #projects = new Map<string, Project>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #inboxProjects = new Map<string, Id>();
  readonly #pendingInbox = new Map<string, Promise<Project>>();

  constructor(options: InMemoryRepositoryOptions) {
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async create(ownerId: Id, input: ProjectCreate, idemKey: string): Promise<Project> {
    assertNoInboxKind(input);
    const title = validateTitle(input.title);
    const requestHash = canonicalJson({ title });
    const idempotencyId = `${ownerId}:${idemKey}`;
    const existing = this.#idempotency.get(idempotencyId);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) throw new IdempotencyMismatchError();
      return cloneProject(existing.response);
    }

    const now = this.#clock.now();
    const project: Project = {
      id: this.#ids.next(),
      ownerId,
      title,
      kind: 'normal',
      archived: false,
      version: 1 as Version,
      createdAt: now,
      updatedAt: now,
    };
    this.#projects.set(project.id, project);
    this.#idempotency.set(idempotencyId, {
      requestHash,
      response: cloneProject(project),
    });
    return cloneProject(project);
  }

  async get(ownerId: Id, id: Id): Promise<Project | null> {
    const project = this.#projects.get(id);
    if (project === undefined || project.ownerId !== ownerId) return null;
    return cloneProject(project);
  }

  async getInbox(ownerId: Id): Promise<Project> {
    const existingId = this.#inboxProjects.get(ownerId);
    if (existingId !== undefined) {
      const existing = this.#projects.get(existingId);
      if (existing !== undefined) return cloneProject(existing);
    }

    const pending = this.#pendingInbox.get(ownerId);
    if (pending !== undefined) return cloneProject(await pending);

    const creating = this.#createInbox(ownerId);
    this.#pendingInbox.set(ownerId, creating);
    try {
      return cloneProject(await creating);
    } finally {
      if (this.#pendingInbox.get(ownerId) === creating) this.#pendingInbox.delete(ownerId);
    }
  }

  async #createInbox(ownerId: Id): Promise<Project> {
    const now = this.#clock.now();
    const project: Project = {
      id: this.#ids.next(),
      ownerId,
      title: 'Inbox',
      kind: 'inbox',
      archived: false,
      version: 1 as Version,
      createdAt: now,
      updatedAt: now,
    };
    this.#projects.set(project.id, project);
    this.#inboxProjects.set(ownerId, project.id);
    return project;
  }

  async list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>> {
    const limit = normalizeLimit(query.limit);
    const cursor = query.cursor === undefined ? null : decodeListCursor(query.cursor);

    let projects = [...this.#projects.values()].filter(
      (project) => project.ownerId === ownerId,
    );
    if (cursor !== null) {
      projects = projects.filter((project) => compareCreatedAt(project, cursor) > 0);
    }
    projects.sort(compareCreatedAt);

    const items = projects.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      last === undefined || projects.length <= items.length
        ? null
        : encodeListCursor({ createdAt: last.createdAt, id: last.id });

    return { items: items.map((project) => cloneProject(project)), nextCursor };
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: ProjectPatch,
    expectedVersion: Version,
  ): Promise<Project> {
    const current = this.#projects.get(id);
    if (current === undefined || current.ownerId !== ownerId) {
      throw new NotFoundError('project', id);
    }
    if (current.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current.version);
    }

    const title = patch.title === undefined ? current.title : validateTitle(patch.title);
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean') {
      throw new ValidationFailedError([
        { path: 'archived', message: 'expected a boolean' },
      ]);
    }
    if (current.kind === 'inbox' && patch.archived === true) {
      throw new ValidationFailedError([
        { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
      ]);
    }

    const project: Project = {
      ...current,
      title,
      archived: patch.archived ?? current.archived,
      version: (current.version + 1) as Version,
      updatedAt: this.#clock.now(),
    };
    this.#projects.set(id, project);
    return cloneProject(project);
  }
}

/**
 * ADR-018: the Inbox is created only by `getInbox`. A project create request
 * carries no kind in the domain port; reject an undeclared one at the adapter
 * boundary so an untyped caller cannot fabricate a second Inbox.
 */
function assertNoInboxKind(input: ProjectCreate): void {
  if ((input as { readonly kind?: unknown }).kind !== undefined) {
    throw new ValidationFailedError([
      { path: 'kind', message: 'the inbox is created by getInbox, not by create' },
    ]);
  }
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationFailedError([
      { path: 'limit', message: `expected an integer between 1 and ${MAX_LIMIT}` },
    ]);
  }
  return limit;
}
