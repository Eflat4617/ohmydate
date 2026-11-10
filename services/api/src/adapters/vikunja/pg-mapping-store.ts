import {
  VersionConflictError,
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import type {
  ExternalMapping,
  MappingEntityType,
  MappingPutOptions,
  MappingStore,
  PendingCompletion,
} from '@ohmydate/provider-vikunja';
import type { Kysely } from 'kysely';
import { jsonb, type Database, type JsonValue } from '../../db/types.js';

function toInstant(value: Date): Instant {
  return epochMsToInstant(value.getTime());
}

function toDate(value: Instant): Date {
  return new Date(Date.parse(value));
}

function pendingToJson(pending: PendingCompletion): JsonValue {
  return {
    expectedVersion: pending.expectedVersion as number,
    at: pending.at,
    ...(pending.dueAtBefore === undefined ? {} : { dueAtBefore: pending.dueAtBefore }),
  };
}

function pendingFromJson(value: JsonValue): PendingCompletion | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const expectedVersion = value['expectedVersion'];
  const at = value['at'];
  const dueAtBefore = value['dueAtBefore'];
  if (typeof expectedVersion !== 'number' || typeof at !== 'string') return undefined;
  return {
    expectedVersion: expectedVersion as Version,
    at: at as Instant,
    ...(typeof dueAtBefore === 'string' ? { dueAtBefore: dueAtBefore as Instant } : {}),
  };
}

/**
 * PostgreSQL-backed `MappingStore`. One row per local entity, with a global
 * unique external id (ADR-016 §1); JSONB is always written through `jsonb()`.
 */
export class PgMappingStore implements MappingStore {
  readonly #db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.#db = db;
  }

  async get(entityType: MappingEntityType, entityId: Id): Promise<ExternalMapping | null> {
    const row = await this.#db
      .selectFrom('vikunja_mapping')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();
    return row === undefined ? null : toMapping(row);
  }

  async getByExternal(
    _provider: 'vikunja',
    entityType: MappingEntityType,
    externalId: string,
  ): Promise<ExternalMapping | null> {
    const row = await this.#db
      .selectFrom('vikunja_mapping')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('external_id', '=', externalId)
      .executeTakeFirst();
    return row === undefined ? null : toMapping(row);
  }

  async put(mapping: ExternalMapping, options?: MappingPutOptions): Promise<void> {
    const values = {
      entity_type: mapping.entityType,
      entity_id: mapping.entityId,
      owner_id: mapping.ownerId,
      external_id: mapping.externalId,
      external_etag: mapping.externalEtag ?? null,
      external_updated_at:
        mapping.externalUpdatedAt === undefined ? null : toDate(mapping.externalUpdatedAt),
      local_version: mapping.localVersion,
      content_fingerprint: mapping.contentFingerprint ?? null,
      is_inbox: mapping.inbox === true,
      needs_reconcile: mapping.needsReconcile === true,
      pending_completion:
        mapping.pendingCompletion === undefined
          ? null
          : jsonb(pendingToJson(mapping.pendingCompletion)),
      created_at: toDate(mapping.createdAt),
      updated_at: toDate(mapping.updatedAt),
      deleted_at: mapping.deletedAt === undefined ? null : toDate(mapping.deletedAt),
    };
    const patch = {
      owner_id: values.owner_id,
      external_id: values.external_id,
      external_etag: values.external_etag,
      external_updated_at: values.external_updated_at,
      local_version: values.local_version,
      content_fingerprint: values.content_fingerprint,
      is_inbox: values.is_inbox,
      needs_reconcile: values.needs_reconcile,
      pending_completion: values.pending_completion,
      updated_at: values.updated_at,
      deleted_at: values.deleted_at,
    };

    const expected = options?.expectedLocalVersion;
    if (expected !== undefined) {
      // FU-22: conditional UPDATE so a concurrent writer cannot pass the check
      // and still overwrite a newer local version.
      const result = await this.#db
        .updateTable('vikunja_mapping')
        .set(patch)
        .where('entity_type', '=', mapping.entityType)
        .where('entity_id', '=', mapping.entityId)
        .where('local_version', '=', expected)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        const current = await this.#db
          .selectFrom('vikunja_mapping')
          .select('local_version')
          .where('entity_type', '=', mapping.entityType)
          .where('entity_id', '=', mapping.entityId)
          .executeTakeFirst();
        throw new VersionConflictError(
          expected,
          current === undefined ? undefined : (current.local_version as Version),
        );
      }
      return;
    }

    await this.#db
      .insertInto('vikunja_mapping')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['entity_type', 'entity_id']).doUpdateSet(patch),
      )
      .execute();
  }

  async listByOwner(ownerId: Id): Promise<readonly ExternalMapping[]> {
    const rows = await this.#db
      .selectFrom('vikunja_mapping')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .orderBy('created_at', 'asc')
      .orderBy('entity_type', 'asc')
      .orderBy('entity_id', 'asc')
      .execute();
    return rows.map(toMapping);
  }

  async getInboxMapping(ownerId: Id): Promise<ExternalMapping | null> {
    const row = await this.#db
      .selectFrom('vikunja_mapping')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('entity_type', '=', 'project')
      .where('is_inbox', '=', true)
      .executeTakeFirst();
    return row === undefined ? null : toMapping(row);
  }

  async markInbox(ownerId: Id, entityId: Id): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      // Clear first so the partial unique index never sees two inbox rows,
      // even inside one transaction.
      await trx
        .updateTable('vikunja_mapping')
        .set({ is_inbox: false })
        .where('owner_id', '=', ownerId)
        .where('entity_type', '=', 'project')
        .where('is_inbox', '=', true)
        .where('entity_id', '<>', entityId)
        .execute();
      const result = await trx
        .updateTable('vikunja_mapping')
        .set({ is_inbox: true })
        .where('owner_id', '=', ownerId)
        .where('entity_type', '=', 'project')
        .where('entity_id', '=', entityId)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw new Error(`no project mapping ${entityId} for owner ${ownerId}`);
      }
    });
  }
}

type MappingRow = {
  readonly entity_type: string;
  readonly entity_id: string;
  readonly owner_id: string;
  readonly external_id: string;
  readonly external_etag: string | null;
  readonly external_updated_at: Date | null;
  readonly local_version: number;
  readonly content_fingerprint: string | null;
  readonly is_inbox: boolean;
  readonly needs_reconcile: boolean;
  readonly pending_completion: JsonValue;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
};

function toMapping(row: MappingRow): ExternalMapping {
  if (row.entity_type !== 'task' && row.entity_type !== 'project') {
    throw new Error(`invalid vikunja mapping entity_type: ${row.entity_type}`);
  }
  const pending =
    row.pending_completion === null ? undefined : pendingFromJson(row.pending_completion);
  return {
    provider: 'vikunja',
    entityType: row.entity_type,
    entityId: row.entity_id as Id,
    externalId: row.external_id,
    ownerId: row.owner_id as Id,
    ...(row.external_etag === null ? {} : { externalEtag: row.external_etag }),
    ...(row.external_updated_at === null
      ? {}
      : { externalUpdatedAt: toInstant(row.external_updated_at) }),
    ...(row.content_fingerprint === null
      ? {}
      : { contentFingerprint: row.content_fingerprint }),
    ...(row.is_inbox ? { inbox: true } : {}),
    localVersion: row.local_version as Version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
    ...(row.deleted_at === null ? {} : { deletedAt: toInstant(row.deleted_at) }),
    ...(row.needs_reconcile ? { needsReconcile: true } : {}),
    ...(pending === undefined ? {} : { pendingCompletion: pending }),
  };
}
