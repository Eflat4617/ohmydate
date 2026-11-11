import {
  NotFoundError,
  ValidationFailedError,
  VersionConflictError,
  MAX_LINKS_PER_NOTE,
  type Clock,
  type Id,
  type Instant,
  type LinkTargetKind,
  type NoteSensitivity,
  type NoteSource,
  type Version,
} from '@ohmydate/domain';
import type { NoteContextDocument } from '@ohmydate/llm';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { DailyProblemError } from '../application/daily-errors.js';
import type {
  HallucinatedRefEventInput,
  LinkTarget,
  NoteContextSource,
  NoteCreateRecord,
  NoteLinkRecord,
  NoteListQuery,
  NotePatchRecord,
  NoteRecord,
  NoteStore,
  NoteUsageInput,
  NoteUsageRecord,
} from '../application/notes/ports.js';
import { jsonb, type ContextDocumentTable, type Database, type DocumentLinkTable } from '../db/types.js';

type DocumentRow = Selectable<ContextDocumentTable>;
type LinkRow = Selectable<DocumentLinkTable>;

const DOCUMENT_COLUMNS = [
  'id',
  'owner_id',
  'title',
  'body_md',
  'sensitivity',
  'llm_allowed',
  'source',
  'source_task_id',
  'created_at',
  'updated_at',
  'version',
] as const;

type DocumentSelection = Pick<DocumentRow, (typeof DOCUMENT_COLUMNS)[number]>;

function toInstant(value: Date | string): Instant {
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) as Instant;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: string; constraint?: string } | null;
  return candidate?.code === '23505' && candidate.constraint === constraint;
}

function mapLink(row: LinkRow): NoteLinkRecord {
  return {
    id: row.id as Id,
    documentId: row.document_id as Id,
    targetKind: row.target_kind as LinkTargetKind,
    targetId: row.target_id as Id,
    createdAt: toInstant(row.created_at),
  };
}

function mapDocument(row: DocumentSelection, links: readonly NoteLinkRecord[]): NoteRecord {
  return {
    id: row.id as Id,
    ownerId: row.owner_id as Id,
    title: row.title,
    bodyMd: row.body_md,
    sensitivity: row.sensitivity as NoteSensitivity,
    llmAllowed: row.llm_allowed,
    source: row.source as NoteSource,
    ...(row.source_task_id === null ? {} : { sourceTaskId: row.source_task_id as Id }),
    links,
    version: row.version as Version,
    createdAt: toInstant(row.created_at),
    updatedAt: toInstant(row.updated_at),
  };
}

/** `terms` contain only letters/digits, so they can never form tsquery operators. */
function prefixQuery(terms: readonly string[]): string {
  return terms.map((term) => `${term}:*`).join(' & ');
}

export const PROMOTED_TASK_CONFLICT_DETAIL =
  'this task description was already promoted to a note; edit that note instead';

function promotedConflict(): DailyProblemError {
  return new DailyProblemError({
    status: 409,
    code: 'illegal_transition',
    title: 'State conflict',
    detail: PROMOTED_TASK_CONFLICT_DETAIL,
  });
}

export class PgNoteStore implements NoteStore, NoteContextSource {
  readonly #db: Kysely<Database>;
  readonly #clock: Clock;

  constructor(options: { readonly db: Kysely<Database>; readonly clock: Clock }) {
    this.#db = options.db;
    this.#clock = options.clock;
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  async #links(
    executor: Kysely<Database> | Transaction<Database>,
    ownerId: Id,
    documentIds: readonly Id[],
  ): Promise<Map<string, NoteLinkRecord[]>> {
    const byDocument = new Map<string, NoteLinkRecord[]>();
    if (documentIds.length === 0) return byDocument;
    const rows = await executor
      .selectFrom('document_link')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .where('document_id', 'in', [...documentIds])
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();
    for (const row of rows) {
      const list = byDocument.get(row.document_id) ?? [];
      list.push(mapLink(row));
      byDocument.set(row.document_id, list);
    }
    return byDocument;
  }

  async #load(
    executor: Kysely<Database> | Transaction<Database>,
    ownerId: Id,
    id: Id,
  ): Promise<NoteRecord | null> {
    const row = await executor
      .selectFrom('context_document')
      .select(DOCUMENT_COLUMNS)
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) return null;
    const links = await this.#links(executor, ownerId, [id]);
    return mapDocument(row, links.get(id) ?? []);
  }

  async create(input: NoteCreateRecord): Promise<NoteRecord> {
    const now = this.#now();
    try {
      return await this.#db.transaction().execute(async (trx) => {
        await trx
          .insertInto('context_document')
          .values({
            id: input.id,
            owner_id: input.ownerId,
            title: input.title,
            body_md: input.bodyMd,
            sensitivity: input.sensitivity,
            llm_allowed: input.llmAllowed,
            source: input.source,
            source_task_id: input.sourceTaskId ?? null,
            created_at: now,
            updated_at: now,
          })
          .execute();
        for (const link of input.links) {
          await trx
            .insertInto('document_link')
            .values({
              id: link.id,
              owner_id: input.ownerId,
              document_id: input.id,
              target_kind: link.targetKind,
              target_id: link.targetId,
              created_at: now,
              updated_at: now,
            })
            .execute();
        }
        const created = await this.#load(trx, input.ownerId, input.id);
        if (created === null) throw new NotFoundError('document', input.id);
        return created;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'context_document_promoted_task_unique')) throw promotedConflict();
      if (isUniqueViolation(error, 'document_link_unique')) {
        throw new ValidationFailedError([{ path: '/links', message: 'duplicate link target' }]);
      }
      throw error;
    }
  }

  async get(ownerId: Id, id: Id): Promise<NoteRecord | null> {
    return this.#load(this.#db, ownerId, id);
  }

  async list(
    ownerId: Id,
    query: NoteListQuery,
  ): Promise<{ readonly items: readonly NoteRecord[]; readonly hasMore: boolean }> {
    const tsquery =
      query.terms === undefined || query.terms.length === 0
        ? undefined
        : sql`to_tsquery('simple'::regconfig, ${prefixQuery(query.terms)})`;
    let builder = this.#db
      .selectFrom('context_document')
      .select(DOCUMENT_COLUMNS)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null);
    if (query.target !== undefined) {
      const target = query.target;
      builder = builder.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('document_link')
            .select(sql`1`.as('one'))
            .whereRef('document_link.document_id', '=', 'context_document.id')
            .where('document_link.owner_id', '=', ownerId)
            .where('document_link.target_kind', '=', target.kind)
            .where('document_link.target_id', '=', target.id),
        ),
      );
    }
    if (tsquery !== undefined) {
      builder = builder
        .where(sql<boolean>`body_tsv @@ ${tsquery}`)
        .orderBy(sql`ts_rank(body_tsv, ${tsquery})`, 'desc');
    }
    const rows = await builder
      .orderBy('updated_at', 'desc')
      .orderBy('id', 'desc')
      .offset(query.offset)
      .limit(query.limit + 1)
      .execute();
    const page = rows.slice(0, query.limit);
    const links = await this.#links(
      this.#db,
      ownerId,
      page.map((row) => row.id as Id),
    );
    return {
      items: page.map((row) => mapDocument(row, links.get(row.id) ?? [])),
      hasMore: rows.length > query.limit,
    };
  }

  async #lockForUpdate(
    trx: Transaction<Database>,
    ownerId: Id,
    id: Id,
    expectedVersion: number,
  ): Promise<void> {
    const row = await trx
      .selectFrom('context_document')
      .select(['version'])
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new NotFoundError('document', id);
    if (row.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion as Version, row.version as Version);
    }
  }

  async #bump(trx: Transaction<Database>, ownerId: Id, id: Id): Promise<void> {
    await trx
      .updateTable('context_document')
      .set({ version: sql<number>`version + 1`, updated_at: this.#now() })
      .where('id', '=', id)
      .where('owner_id', '=', ownerId)
      .execute();
  }

  async update(
    ownerId: Id,
    id: Id,
    patch: NotePatchRecord,
    expectedVersion: number,
  ): Promise<NoteRecord> {
    return this.#db.transaction().execute(async (trx) => {
      await this.#lockForUpdate(trx, ownerId, id, expectedVersion);
      await trx
        .updateTable('context_document')
        .set({
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.bodyMd === undefined ? {} : { body_md: patch.bodyMd }),
          ...(patch.sensitivity === undefined ? {} : { sensitivity: patch.sensitivity }),
          ...(patch.llmAllowed === undefined ? {} : { llm_allowed: patch.llmAllowed }),
          version: sql<number>`version + 1`,
          updated_at: this.#now(),
        })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .execute();
      const updated = await this.#load(trx, ownerId, id);
      if (updated === null) throw new NotFoundError('document', id);
      return updated;
    });
  }

  async softDelete(ownerId: Id, id: Id, expectedVersion: number): Promise<void> {
    await this.#db.transaction().execute(async (trx) => {
      await this.#lockForUpdate(trx, ownerId, id, expectedVersion);
      await trx
        .updateTable('context_document')
        .set({
          deleted_at: this.#now(),
          version: sql<number>`version + 1`,
          updated_at: this.#now(),
        })
        .where('id', '=', id)
        .where('owner_id', '=', ownerId)
        .execute();
    });
  }

  async addLink(
    ownerId: Id,
    id: Id,
    link: { readonly id: Id; readonly targetKind: LinkTargetKind; readonly targetId: Id },
    expectedVersion: number,
  ): Promise<NoteRecord> {
    try {
      return await this.#db.transaction().execute(async (trx) => {
        await this.#lockForUpdate(trx, ownerId, id, expectedVersion);
        const count = await trx
          .selectFrom('document_link')
          .select(sql<string>`count(*)`.as('count'))
          .where('owner_id', '=', ownerId)
          .where('document_id', '=', id)
          .executeTakeFirst();
        if (Number(count?.count ?? 0) >= MAX_LINKS_PER_NOTE) {
          throw new ValidationFailedError([
            { path: '/targetId', message: `a note can have at most ${MAX_LINKS_PER_NOTE} links` },
          ]);
        }
        const now = this.#now();
        await trx
          .insertInto('document_link')
          .values({
            id: link.id,
            owner_id: ownerId,
            document_id: id,
            target_kind: link.targetKind,
            target_id: link.targetId,
            created_at: now,
            updated_at: now,
          })
          .execute();
        await this.#bump(trx, ownerId, id);
        const updated = await this.#load(trx, ownerId, id);
        if (updated === null) throw new NotFoundError('document', id);
        return updated;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'document_link_unique')) {
        throw new ValidationFailedError([
          { path: '/targetId', message: 'the note is already linked to this target' },
        ]);
      }
      throw error;
    }
  }

  async removeLink(ownerId: Id, id: Id, linkId: Id, expectedVersion: number): Promise<NoteRecord> {
    return this.#db.transaction().execute(async (trx) => {
      await this.#lockForUpdate(trx, ownerId, id, expectedVersion);
      const deleted = await trx
        .deleteFrom('document_link')
        .where('id', '=', linkId)
        .where('document_id', '=', id)
        .where('owner_id', '=', ownerId)
        .executeTakeFirst();
      if (Number(deleted.numDeletedRows) === 0) throw new NotFoundError('document link', linkId);
      await this.#bump(trx, ownerId, id);
      const updated = await this.#load(trx, ownerId, id);
      if (updated === null) throw new NotFoundError('document', id);
      return updated;
    });
  }

  async findLivePromoted(ownerId: Id, taskId: Id): Promise<NoteRecord | null> {
    const row = await this.#db
      .selectFrom('context_document')
      .select('id')
      .where('owner_id', '=', ownerId)
      .where('source', '=', 'task_description')
      .where('source_task_id', '=', taskId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row === undefined ? null : this.#load(this.#db, ownerId, row.id as Id);
  }

  async goalExists(ownerId: Id, goalId: Id): Promise<boolean> {
    const row = await this.#db
      .selectFrom('goal')
      .select('id')
      .where('id', '=', goalId)
      .where('owner_id', '=', ownerId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listUsage(
    ownerId: Id,
    documentId: Id,
    offset: number,
    limit: number,
  ): Promise<{ readonly items: readonly NoteUsageRecord[]; readonly hasMore: boolean }> {
    const rows = await this.#db
      .selectFrom('note_ai_usage as u')
      .innerJoin('agent_run as r', (join) =>
        join.onRef('r.id', '=', 'u.agent_run_id').onRef('r.owner_id', '=', 'u.owner_id'),
      )
      .innerJoin('context_document as d', (join) =>
        join.onRef('d.id', '=', 'u.document_id').onRef('d.owner_id', '=', 'u.owner_id'),
      )
      .select([
        'u.id',
        'u.document_id',
        'u.agent_run_id',
        'u.purpose',
        'u.document_version',
        'u.body_hash',
        'u.section_hashes',
        'u.sent_bytes',
        'u.created_at',
        'r.prompt_id_version',
        'r.status',
        'r.provider',
        'r.model',
        'd.version as current_version',
      ])
      .where('u.owner_id', '=', ownerId)
      .where('u.document_id', '=', documentId)
      .orderBy('u.created_at', 'desc')
      .orderBy('u.id', 'desc')
      .offset(offset)
      .limit(limit + 1)
      .execute();
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id as Id,
        documentId: row.document_id as Id,
        agentRunId: row.agent_run_id as Id,
        purpose: row.purpose,
        promptIdVersion: row.prompt_id_version,
        status: row.status as NoteUsageRecord['status'],
        provider: row.provider,
        model: row.model,
        documentVersion: row.document_version,
        bodyHash: row.body_hash,
        sectionHashes: [...row.section_hashes],
        sentBytes: row.sent_bytes,
        currentVersion: row.current_version,
        createdAt: toInstant(row.created_at),
      })),
      hasMore: rows.length > limit,
    };
  }

  async linkedForContext(
    ownerId: Id,
    targets: readonly LinkTarget[],
    limit: number,
  ): Promise<readonly NoteContextDocument[]> {
    if (targets.length === 0 || limit <= 0) return [];
    const rows = await this.#db
      .selectFrom('context_document as d')
      .select([
        'd.id',
        'd.owner_id',
        'd.title',
        'd.body_md',
        'd.llm_allowed',
        'd.version',
        'd.updated_at',
      ])
      .where('d.owner_id', '=', ownerId)
      .where('d.deleted_at', 'is', null)
      .where('d.llm_allowed', '=', true)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom('document_link as l')
            .select(sql`1`.as('one'))
            .whereRef('l.document_id', '=', 'd.id')
            .where('l.owner_id', '=', ownerId)
            .where((inner) =>
              inner.or(
                targets.map((target) =>
                  inner.and([
                    inner('l.target_kind', '=', target.kind),
                    inner('l.target_id', '=', target.id),
                  ]),
                ),
              ),
            ),
        ),
      )
      .orderBy('d.updated_at', 'desc')
      .orderBy('d.id', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      title: row.title,
      bodyMd: row.body_md,
      llmAllowed: row.llm_allowed,
      version: row.version,
      updatedAt: toInstant(row.updated_at),
    }));
  }

  async recordUsage(input: NoteUsageInput, ids: () => Id): Promise<void> {
    if (input.entries.length === 0) return;
    const now = this.#now();
    await this.#db
      .insertInto('note_ai_usage')
      .values(
        input.entries.map((entry) => ({
          id: ids(),
          owner_id: input.ownerId,
          document_id: entry.docId as Id,
          agent_run_id: input.agentRunId,
          purpose: input.purpose,
          document_version: entry.version,
          body_hash: entry.bodyHash,
          section_hashes: [...entry.sectionHashes],
          sent_bytes: entry.sentBytes,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
  }

  async recordHallucinatedRefs(input: HallucinatedRefEventInput): Promise<void> {
    await this.#db
      .insertInto('audit_event')
      .values({
        id: input.id,
        owner_id: input.ownerId,
        actor: 'agent',
        action: 'hallucinated_ref',
        entity: 'agent_run',
        entity_id: input.agentRunId,
        diff_summary: jsonb({ counts: { ...input.counts } }),
        created_at: this.#now(),
        updated_at: this.#now(),
      })
      .execute();
  }
}
