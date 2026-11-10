import type { Id, Instant, Version } from '@ohmydate/domain';

export type MappingEntityType = 'task' | 'project';

/**
 * The planner is the source of truth for `localVersion`. Vikunja only exposes
 * an opaque ETag plus second-precision `updated` timestamps, so both are cached
 * here after every successful write and used for best-effort conflict detection
 * (ADR-016 §1).
 *
 * `ownerId` is an adapter-internal addition: the shared contract suite requires
 * owner-scoped reads/writes, and a mapping row is the cheapest place to enforce
 * that without an extra Vikunja request.
 */
export interface ExternalMapping {
  readonly provider: 'vikunja';
  readonly entityType: MappingEntityType;
  readonly entityId: Id;
  readonly externalId: string;
  readonly ownerId: Id;
  readonly externalEtag?: string;
  readonly externalUpdatedAt?: Instant;
  readonly localVersion: Version;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
  readonly deletedAt?: Instant;
  /**
   * Set after a remote mutation partially succeeded (e.g. task write committed
   * but a relation write or the final ETag read failed). The next read/update
   * must reconcile from Vikunja before serving state so a staged planner field
   * can never become visible under an unchanged version.
   */
  readonly needsReconcile?: boolean;
}

export interface MappingStore {
  get(entityType: MappingEntityType, entityId: Id): Promise<ExternalMapping | null>;
  getByExternal(
    provider: 'vikunja',
    entityType: MappingEntityType,
    externalId: string,
  ): Promise<ExternalMapping | null>;
  put(mapping: ExternalMapping): Promise<void>;
}

function entityKey(entityType: MappingEntityType, entityId: Id): string {
  return `${entityType}:${entityId}`;
}

function externalKey(
  provider: 'vikunja',
  entityType: MappingEntityType,
  externalId: string,
): string {
  return `${provider}:${entityType}:${externalId}`;
}

/**
 * In-memory mapping store for unit tests and the live contract suite. The
 * Postgres-backed store arrives with the API task; the interface deliberately
 * mirrors the columns named by ADR-016.
 */
export class InMemoryMappingStore implements MappingStore {
  readonly #byEntity = new Map<string, ExternalMapping>();
  readonly #byExternal = new Map<string, ExternalMapping>();

  async get(entityType: MappingEntityType, entityId: Id): Promise<ExternalMapping | null> {
    return this.#byEntity.get(entityKey(entityType, entityId)) ?? null;
  }

  async getByExternal(
    provider: 'vikunja',
    entityType: MappingEntityType,
    externalId: string,
  ): Promise<ExternalMapping | null> {
    return this.#byExternal.get(externalKey(provider, entityType, externalId)) ?? null;
  }

  async put(mapping: ExternalMapping): Promise<void> {
    const key = entityKey(mapping.entityType, mapping.entityId);
    const previous = this.#byEntity.get(key);
    if (previous !== undefined) {
      this.#byExternal.delete(
        externalKey(previous.provider, previous.entityType, previous.externalId),
      );
    }
    this.#byEntity.set(key, mapping);
    this.#byExternal.set(
      externalKey(mapping.provider, mapping.entityType, mapping.externalId),
      mapping,
    );
  }

  /** Test/cleanup helper; not part of the store contract used by the adapter. */
  entries(): readonly ExternalMapping[] {
    return [...this.#byEntity.values()];
  }
}
