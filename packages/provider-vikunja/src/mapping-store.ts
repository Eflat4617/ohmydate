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
export interface PendingCompletion {
  readonly expectedVersion: Version;
  readonly at: Instant;
  readonly dueAtBefore?: Instant;
}

export interface ExternalMapping {
  readonly provider: 'vikunja';
  readonly entityType: MappingEntityType;
  readonly entityId: Id;
  readonly externalId: string;
  readonly ownerId: Id;
  readonly externalEtag?: string;
  readonly externalUpdatedAt?: Instant;
  /**
   * Fingerprint of the provider-visible content this mapping was last
   * reconciled against (title, marker-free description, done, due date,
   * project and the mapped dependency relations). Vikunja ETags have second
   * precision, so two writes inside the same second can share an ETag; the
   * fingerprint is the tie-breaker that keeps such a change from being lost
   * (ADR-016 §1, FU-16).
   */
  readonly contentFingerprint?: string;
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
  /**
   * Persisted before a completion PATCH. If the write outcome is unknown, the
   * next reconciliation compares the provider state and emits the planner
   * completion record exactly once, then clears this intent.
   */
  readonly pendingCompletion?: PendingCompletion;
}

export interface MappingStore {
  get(entityType: MappingEntityType, entityId: Id): Promise<ExternalMapping | null>;
  getByExternal(
    provider: 'vikunja',
    entityType: MappingEntityType,
    externalId: string,
  ): Promise<ExternalMapping | null>;
  put(mapping: ExternalMapping): Promise<void>;
  listByOwner(ownerId: Id): Promise<readonly ExternalMapping[]>;
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

  async listByOwner(ownerId: Id): Promise<readonly ExternalMapping[]> {
    return [...this.#byEntity.values()].filter((mapping) => mapping.ownerId === ownerId);
  }

  /** Test/cleanup helper; not part of the store contract used by the adapter. */
  entries(): readonly ExternalMapping[] {
    return [...this.#byEntity.values()];
  }
}
