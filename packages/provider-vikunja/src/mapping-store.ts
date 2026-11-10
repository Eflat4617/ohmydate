import { VersionConflictError, type Id, type Instant, type Version } from '@ohmydate/domain';

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
  /**
   * ADR-018 + FU-29: durable Inbox identity. At most one project mapping per
   * owner may set this (enforced by a partial unique index in PostgreSQL); the
   * adapter moves it atomically with `markInbox`.
   */
  readonly inbox?: boolean;
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

export interface MappingPutOptions {
  /**
   * Optimistic precondition (FU-22): fail with `VersionConflictError` unless the
   * stored `local_version` equals this value. Durable implementations should
   * enforce it in the write itself (conditional UPDATE) so a concurrent writer
   * cannot stage a mapping under a stale version.
   */
  readonly expectedLocalVersion?: Version;
}

export interface MappingStore {
  get(entityType: MappingEntityType, entityId: Id): Promise<ExternalMapping | null>;
  getByExternal(
    provider: 'vikunja',
    entityType: MappingEntityType,
    externalId: string,
  ): Promise<ExternalMapping | null>;
  put(mapping: ExternalMapping, options?: MappingPutOptions): Promise<void>;
  listByOwner(ownerId: Id): Promise<readonly ExternalMapping[]>;
  /**
   * The owner's current Inbox mapping, or null. Includes a row whose remote
   * project was trashed (the adapter checks `deletedAt`), so the marker can be
   * moved atomically to its replacement.
   */
  getInboxMapping(ownerId: Id): Promise<ExternalMapping | null>;
  /**
   * Atomically makes `entityId` the owner's single Inbox mapping and clears the
   * flag from every other project mapping of the same owner. A partial unique
   * index rejects a concurrent writer losing the race; callers re-read.
   */
  markInbox(ownerId: Id, entityId: Id): Promise<void>;
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

  async put(mapping: ExternalMapping, options?: MappingPutOptions): Promise<void> {
    const key = entityKey(mapping.entityType, mapping.entityId);
    const previous = this.#byEntity.get(key);
    if (
      options?.expectedLocalVersion !== undefined &&
      previous?.localVersion !== options.expectedLocalVersion
    ) {
      throw new VersionConflictError(options.expectedLocalVersion, previous?.localVersion);
    }
    this.#replace(mapping, previous);
  }

  async listByOwner(ownerId: Id): Promise<readonly ExternalMapping[]> {
    return [...this.#byEntity.values()].filter((mapping) => mapping.ownerId === ownerId);
  }

  async getInboxMapping(ownerId: Id): Promise<ExternalMapping | null> {
    let found: ExternalMapping | null = null;
    for (const mapping of this.#byEntity.values()) {
      if (
        mapping.ownerId === ownerId &&
        mapping.entityType === 'project' &&
        mapping.inbox === true &&
        (found === null || mapping.updatedAt > found.updatedAt)
      ) {
        found = mapping;
      }
    }
    return found;
  }

  async markInbox(ownerId: Id, entityId: Id): Promise<void> {
    const target = this.#byEntity.get(entityKey('project', entityId));
    if (target === undefined || target.ownerId !== ownerId) {
      throw new Error(`no project mapping ${entityId} for owner ${ownerId}`);
    }
    for (const mapping of [...this.#byEntity.values()]) {
      if (mapping.entityType !== 'project' || mapping.ownerId !== ownerId) continue;
      const shouldBeInbox = mapping.entityId === entityId;
      if ((mapping.inbox === true) === shouldBeInbox) continue;
      if (shouldBeInbox) {
        this.#replace({ ...mapping, inbox: true }, mapping);
      } else {
        const { inbox: _inbox, ...rest } = mapping;
        void _inbox;
        this.#replace(rest, mapping);
      }
    }
  }

  #replace(mapping: ExternalMapping, previous: ExternalMapping | undefined): void {
    if (previous !== undefined) {
      this.#byExternal.delete(
        externalKey(previous.provider, previous.entityType, previous.externalId),
      );
    }
    this.#byEntity.set(entityKey(mapping.entityType, mapping.entityId), mapping);
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
