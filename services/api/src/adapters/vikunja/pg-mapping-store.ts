import {
  epochMsToInstant,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import type {
  ExternalMapping,
  MappingEntityType,
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

  async put(mapping: ExternalMapping): Promise<void> {
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
      needs_reconcile: mapping.needsReconcile === true,
      pending_completion:
        mapping.pendingCompletion === undefined
          ? null
          : jsonb(pendingToJson(mapping.pendingCompletion)),
      created_at: toDate(mapping.createdAt),
      updated_at: toDate(mapping.updatedAt),
      deleted_at: mapping.deletedAt === undefined ? null : toDate(mapping.deletedAt),
    };
    await this.#db
      .insertInto('vikunja_mapping')
      .values(values)
      .onConflict((conflict) =>
        conflict.columns(['entity_type', 'entity_id']).doUpdateSet({
          owner_id: values.owner_id,
          external_id: values.external_id,
          external_etag: values.external_etag,
          external_updated_at: values.external_updated_at,
          local_version: values.local_version,
          content_fingerprint: values.content_fingerprint,
          needs_reconcile: values.needs_reconcile,
          pending_completion: values.pending_completion,
          updated_at: values.updated_at,
          deleted_at: values.deleted_at,
        }),
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
    localVersion: row.local_version as Version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
    ...(row.deleted_at === null ? {} : { deletedAt: toInstant(row.deleted_at) }),
    ...(row.needs_reconcile ? { needsReconcile: true } : {}),
    ...(pending === undefined ? {} : { pendingCompletion: pending }),
  };
}
