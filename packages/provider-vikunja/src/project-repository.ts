import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  type Clock,
  type Id,
  type IdGenerator,
  type Page,
  type Project,
  type ProjectCreate,
  type ProjectKind,
  type ProjectPatch,
  type ProjectQuery,
  type ProjectRepository,
  type RepositoryCapabilities,
  type Version,
} from '@ohmydate/domain';
import { VikunjaClient, type VikunjaProject } from './client.js';
import {
  compareListPosition,
  decodeListCursor,
  encodeListCursor,
} from './cursor.js';
import type { ExternalMapping, MappingStore } from './mapping-store.js';
import { normalizeRemoteInstant } from './time.js';

const CAPABILITIES: RepositoryCapabilities = {
  strictConcurrency: false,
  idempotentCreate: false,
};

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * ADR-018 inbox marker persisted on the project mapping. Project mappings have
 * no use for the task content fingerprint, so it doubles as the durable inbox
 * identity. This keeps the Inbox stable even when the Vikunja default project
 * cannot be written (PATCH settings is JWT-only; API tokens get 401).
 */
const INBOX_MARKER = 'inbox';

export interface VikunjaProjectRepositoryOptions {
  readonly clients: ReadonlyMap<Id, VikunjaClient>;
  readonly mappings: MappingStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Vikunja project adapter. Vikunja has no ETag-based write preconditions for
 * projects either, so the same best-effort version mapping as tasks applies
 * (ADR-016). `idemKey` is ignored; the API layer compensates.
 */
export class VikunjaProjectRepository implements ProjectRepository {
  readonly capabilities: RepositoryCapabilities = CAPABILITIES;

  readonly #clients: ReadonlyMap<Id, VikunjaClient>;
  readonly #mappings: MappingStore;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #pendingInbox = new Map<Id, Promise<Project>>();

  constructor(options: VikunjaProjectRepositoryOptions) {
    this.#clients = options.clients;
    this.#mappings = options.mappings;
    this.#clock = options.clock;
    this.#ids = options.ids;
  }

  async create(ownerId: Id, input: ProjectCreate, _idemKey: string): Promise<Project> {
    void _idemKey;
    assertNoInboxKind(input);
    const client = this.#requireClient(ownerId);
    const title = validateTitle(input.title);
    const remote = await client.createProject(title);
    const now = this.#clock.now();
    const id = this.#ids.next();
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'project',
      entityId: id,
      externalId: String(remote.id),
      ownerId,
      localVersion: 1 as Version,
      createdAt: now,
      updatedAt: now,
    };
    await this.#mappings.put(mapping);
    return {
      id,
      ownerId,
      title: remote.title,
      kind: 'normal',
      archived: remote.is_archived === true,
      version: mapping.localVersion,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(ownerId: Id, id: Id): Promise<Project | null> {
    const client = this.#clientFor(ownerId);
    if (client === undefined) return null;
    const mapping = await this.#mappings.get('project', id);
    if (mapping === null || mapping.ownerId !== ownerId || mapping.deletedAt !== undefined) {
      return null;
    }
    try {
      const { data } = await client.getProject(mapping.externalId);
      const inboxExternalId = await this.#resolveInboxExternalId(ownerId, client);
      return this.#toProject(
        ownerId,
        mapping,
        data,
        this.#kindFor(mapping, inboxExternalId),
      );
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /**
   * ADR-018: the Vikunja user's default project *is* the planner Inbox. The
   * settings write is best effort only (PATCH /user/settings/general is
   * JWT-only and returns 401 for API tokens), so the resolved project also gets
   * a durable inbox marker on its mapping. When the default is 0, missing or
   * trashed the same deterministic adoption rule (marker, then title 'Inbox',
   * then create) keeps get/list/update consistent and never proliferates
   * Inboxes. Concurrent first calls are coalesced per owner.
   */
  async getInbox(ownerId: Id): Promise<Project> {
    const pending = this.#pendingInbox.get(ownerId);
    if (pending !== undefined) return pending;
    const client = this.#requireClient(ownerId);
    const creating = this.#ensureInbox(ownerId, client);
    this.#pendingInbox.set(ownerId, creating);
    try {
      return await creating;
    } finally {
      if (this.#pendingInbox.get(ownerId) === creating) this.#pendingInbox.delete(ownerId);
    }
  }

  async #ensureInbox(ownerId: Id, client: VikunjaClient): Promise<Project> {
    const resolved = await this.#resolveInboxRemote(ownerId, client, true);
    if (resolved === undefined) throw new Error('inbox resolution failed unexpectedly');
    const { project: remote, needsDefault } = resolved;
    if (needsDefault) {
      try {
        await client.updateGeneralSettings({ default_project_id: remote.id });
      } catch {
        // Tokens cannot PATCH user settings. The marker below is authoritative.
      }
    }

    const externalId = String(remote.id);
    let mapping = await this.#mappings.getByExternal('vikunja', 'project', externalId);
    if (mapping === null) {
      const now = this.#clock.now();
      const candidate: ExternalMapping = {
        provider: 'vikunja',
        entityType: 'project',
        entityId: this.#ids.next(),
        externalId,
        ownerId,
        contentFingerprint: INBOX_MARKER,
        localVersion: 1 as Version,
        createdAt: now,
        updatedAt: now,
      };
      try {
        await this.#mappings.put(candidate);
        mapping = candidate;
      } catch (error) {
        // Another instance mapped the same default project first.
        const existing = await this.#mappings.getByExternal(
          'vikunja',
          'project',
          externalId,
        );
        if (existing === null) throw error;
        mapping = existing;
      }
    } else if (mapping.contentFingerprint !== INBOX_MARKER) {
      const marked: ExternalMapping = {
        ...mapping,
        contentFingerprint: INBOX_MARKER,
      };
      try {
        await this.#mappings.put(marked, {
          expectedLocalVersion: mapping.localVersion,
        });
        mapping = marked;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
        const current = await this.#mappings.getByExternal(
          'vikunja',
          'project',
          externalId,
        );
        if (current !== null) mapping = current;
      }
    }
    if (mapping.ownerId !== ownerId) throw new NotFoundError('project', externalId);
    return this.#toProject(ownerId, mapping, remote, 'inbox');
  }

  async #resolveInboxRemote(
    ownerId: Id,
    client: VikunjaClient,
    create: boolean,
  ): Promise<{ readonly project: VikunjaProject; readonly needsDefault: boolean } | undefined> {
    let defaultId: number | undefined;
    try {
      defaultId = (await client.getGeneralSettings()).default_project_id;
    } catch {
      // A token without `other:user` cannot read settings. Fall through to the
      // persisted marker and title adoption.
    }
    if (defaultId !== undefined && defaultId > 0) {
      try {
        const { data } = await client.getProject(String(defaultId));
        if (data.deleted_at === undefined) {
          return { project: data, needsDefault: false };
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }

    const marked = (await this.#mappings.listByOwner(ownerId)).find(
      (candidate) =>
        candidate.entityType === 'project' &&
        candidate.contentFingerprint === INBOX_MARKER &&
        candidate.deletedAt === undefined,
    );
    if (marked !== undefined) {
      try {
        const { data } = await client.getProject(marked.externalId);
        if (data.deleted_at === undefined) {
          return { project: data, needsDefault: defaultId !== data.id };
        }
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
    }

    const projects = await client.listAllProjects();
    const existing = projects.find(
      (candidate) =>
        candidate.id > 0 &&
        candidate.deleted_at === undefined &&
        candidate.title.trim().toLowerCase() === 'inbox',
    );
    if (existing !== undefined) {
      return { project: existing, needsDefault: defaultId !== existing.id };
    }
    if (!create) return undefined;
    const created = await client.createProject('Inbox');
    return { project: created, needsDefault: true };
  }

  async #resolveInboxExternalId(
    ownerId: Id,
    client: VikunjaClient,
  ): Promise<string | undefined> {
    const resolved = await this.#resolveInboxRemote(ownerId, client, false);
    return resolved === undefined ? undefined : String(resolved.project.id);
  }

  async list(ownerId: Id, query: ProjectQuery): Promise<Page<Project>> {
    const client = this.#clientFor(ownerId);
    if (client === undefined) return { items: [], nextCursor: null };
    const limit = normalizeLimit(query.limit);
    const inboxExternalId = await this.#resolveInboxExternalId(ownerId, client);
    const candidates: Project[] = [];
    for (const remote of await client.listAllProjects()) {
      const mapping = await this.#mappings.getByExternal(
        'vikunja',
        'project',
        String(remote.id),
      );
      if (
        mapping === null ||
        mapping.ownerId !== ownerId ||
        mapping.deletedAt !== undefined
      ) {
        continue;
      }
      candidates.push(
        this.#toProject(
          ownerId,
          mapping,
          remote,
          this.#kindFor(mapping, inboxExternalId),
        ),
      );
    }
    candidates.sort((left, right) =>
      compareListPosition(
        { createdAt: left.createdAt, id: left.id },
        { createdAt: right.createdAt, id: right.id },
      ),
    );

    let filtered = candidates;
    if (query.cursor !== undefined) {
      const cursor = decodeListCursor(query.cursor);
      filtered = candidates.filter(
        (project) =>
          compareListPosition(
            { createdAt: project.createdAt, id: project.id },
            { createdAt: cursor.createdAt, id: cursor.id },
          ) > 0,
      );
    }

    const items = filtered.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor =
      last === undefined || filtered.length <= items.length
        ? null
        : encodeListCursor({ createdAt: last.createdAt, id: last.id });
    return { items, nextCursor };
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: ProjectPatch,
    expectedVersion: Version,
  ): Promise<Project> {
    const client = this.#requireClient(ownerId);
    const mapping = await this.#mappings.get('project', id);
    if (mapping === null || mapping.ownerId !== ownerId || mapping.deletedAt !== undefined) {
      throw new NotFoundError('project', id);
    }
    if (mapping.localVersion !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, mapping.localVersion);
    }

    const inboxExternalId = await this.#resolveInboxExternalId(ownerId, client);
    const kind = this.#kindFor(mapping, inboxExternalId);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = validateTitle(patch.title);
    if (patch.archived !== undefined) {
      if (typeof patch.archived !== 'boolean') {
        throw new ValidationFailedError([
          { path: 'archived', message: 'expected a boolean' },
        ]);
      }
      if (kind === 'inbox' && patch.archived === true) {
        throw new ValidationFailedError([
          { path: 'archived', message: 'the inbox project cannot be archived or deleted' },
        ]);
      }
      body.is_archived = patch.archived;
    }
    if (Object.keys(body).length > 0) {
      await client.updateProject(mapping.externalId, body);
    }

    const { data } = await client.getProject(mapping.externalId);
    const now = this.#clock.now();
    const remoteUpdatedAt = normalizeRemoteInstant(data.updated);
    const build = (base: ExternalMapping): ExternalMapping => ({
      ...base,
      ...(remoteUpdatedAt === undefined ? {} : { externalUpdatedAt: remoteUpdatedAt }),
      localVersion: (base.localVersion + 1) as Version,
      updatedAt: now,
    });
    let updated = build(mapping);
    try {
      await this.#mappings.put(updated, { expectedLocalVersion: mapping.localVersion });
    } catch (error) {
      if (!(error instanceof VersionConflictError)) throw error;
      const current = await this.#mappings.get('project', id);
      if (current === null || current.ownerId !== ownerId) throw error;
      updated = build(current);
      await this.#mappings.put(updated, { expectedLocalVersion: current.localVersion });
    }
    return this.#toProject(ownerId, updated, data, kind);
  }

  #kindFor(mapping: ExternalMapping, inboxExternalId: string | undefined): ProjectKind {
    if (inboxExternalId !== undefined) {
      // The resolved default wins, so moving the Vikunja default moves the
      // single Inbox identity and the old one becomes normal.
      return mapping.externalId === inboxExternalId ? 'inbox' : 'normal';
    }
    return mapping.contentFingerprint === INBOX_MARKER ? 'inbox' : 'normal';
  }

  #clientFor(ownerId: Id): VikunjaClient | undefined {
    return this.#clients.get(ownerId);
  }

  #requireClient(ownerId: Id): VikunjaClient {
    const client = this.#clients.get(ownerId);
    if (client === undefined) throw new NotFoundError('owner', ownerId);
    return client;
  }

  #toProject(
    ownerId: Id,
    mapping: ExternalMapping,
    remote: VikunjaProject,
    kind: ProjectKind,
  ): Project {
    return {
      id: mapping.entityId,
      ownerId,
      title: remote.title,
      kind,
      archived: remote.is_archived === true,
      version: mapping.localVersion,
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
    };
  }
}

function assertNoInboxKind(input: ProjectCreate): void {
  if ((input as { readonly kind?: unknown }).kind !== undefined) {
    throw new ValidationFailedError([
      { path: 'kind', message: 'the inbox is created by getInbox, not by create' },
    ]);
  }
}

function validateTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationFailedError([
      { path: 'title', message: 'title must not be empty' },
    ]);
  }
  if (value.length > 250) {
    throw new ValidationFailedError([
      { path: 'title', message: 'title must be at most 250 characters' },
    ]);
  }
  return value;
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
