import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate, rollbackLatest } from '../../src/db/migrate.js';
import {
  connect,
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  queryFailure,
  requireDatabaseUrl,
  type PgClient,
} from './helpers.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

const NOTES_TABLES = ['context_document', 'document_link', 'note_ai_usage'] as const;
const HASH16 = '0123456789abcdef';
const HASH64 = 'a'.repeat(64);

describe.skipIf(!hasDatabase)('0013 context documents schema', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    client = await connect(schema);
  });

  afterEach(async () => {
    await client.end();
    await dropSchema(schema);
  });

  async function insertUser(): Promise<string> {
    const id = randomUUID();
    await client.query('INSERT INTO "user" (id, email, password_hash) VALUES ($1, $2, $3)', [
      id,
      `${id}@example.test`,
      'argon2id-placeholder',
    ]);
    return id;
  }

  async function insertDocument(
    ownerId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    const row: Record<string, unknown> = {
      id,
      owner_id: ownerId,
      title: '논문 메모',
      body_md: '논문을 요약하고 paper summaries 발표',
      ...overrides,
    };
    const columns = Object.keys(row);
    await client.query(
      `INSERT INTO context_document (${columns.join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column]),
    );
    return id;
  }

  async function insertRun(ownerId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO agent_run (id, owner_id, purpose, prompt_id_version, model, provider, status)
       VALUES ($1, $2, 'decomposition', 'decomposition@v2', 'fake-llm', 'fake', 'succeeded')`,
      [id, ownerId],
    );
    return id;
  }

  async function insertUsage(input: {
    ownerId: string;
    documentId: string;
    runId: string;
    hashes?: unknown;
    bodyHash?: string;
  }): Promise<void> {
    await client.query(
      `INSERT INTO note_ai_usage
         (id, owner_id, document_id, agent_run_id, purpose, document_version, body_hash,
          section_hashes, sent_bytes)
       VALUES ($1, $2, $3, $4, 'decomposition', 1, $5, $6, 42)`,
      [
        randomUUID(),
        input.ownerId,
        input.documentId,
        input.runId,
        input.bodyHash ?? HASH64,
        input.hashes ?? [HASH16],
      ],
    );
  }

  test('creates the notes tables with their documented columns and defaults', async () => {
    const columns = await client.query<{
      table_name: string;
      column_name: string;
      column_default: string | null;
      is_generated: string;
    }>(
      `SELECT table_name, column_name, column_default, is_generated
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = ANY($2)
        ORDER BY table_name, ordinal_position`,
      [schema, [...NOTES_TABLES]],
    );
    const byTable = new Map<string, string[]>();
    for (const row of columns.rows) {
      byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row.column_name]);
    }
    expect(byTable.get('context_document')).toEqual([
      'id',
      'owner_id',
      'title',
      'body_md',
      'body_tsv',
      'sensitivity',
      'llm_allowed',
      'source',
      'source_task_id',
      'created_at',
      'updated_at',
      'deleted_at',
      'version',
    ]);
    expect(byTable.get('document_link')).toEqual([
      'id',
      'owner_id',
      'document_id',
      'target_kind',
      'target_id',
      'created_at',
      'updated_at',
      'version',
    ]);
    // 05 §12: the usage audit stores ids, hashes and counts, never note text.
    expect(byTable.get('note_ai_usage')).toEqual([
      'id',
      'owner_id',
      'document_id',
      'agent_run_id',
      'purpose',
      'document_version',
      'body_hash',
      'section_hashes',
      'sent_bytes',
      'created_at',
      'updated_at',
      'version',
    ]);
    const find = (table: string, column: string) =>
      columns.rows.find((row) => row.table_name === table && row.column_name === column);
    expect(find('context_document', 'llm_allowed')?.column_default).toBe('false');
    expect(find('context_document', 'sensitivity')?.column_default).toBe("'P2'::text");
    expect(find('context_document', 'body_tsv')?.is_generated).toBe('ALWAYS');

    const index = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'context_document_body_tsv_idx'`,
      [schema],
    );
    expect(index.rows[0]?.indexdef).toMatch(/USING gin \(body_tsv\)/);
  });

  test('body_tsv is generated with the simple configuration and supports Korean prefix search', async () => {
    const ownerId = await insertUser();
    const id = await insertDocument(ownerId);
    const vector = await client.query<{ body_tsv: string }>(
      'SELECT body_tsv::text FROM context_document WHERE id = $1',
      [id],
    );
    expect(vector.rows[0]?.body_tsv).toContain("'논문을'");
    expect(vector.rows[0]?.body_tsv).toContain("'summaries'");
    const hit = await client.query<{ id: string }>(
      `SELECT id FROM context_document WHERE body_tsv @@ to_tsquery('simple', '논문:* & paper:*')`,
    );
    expect(hit.rows.map((row) => row.id)).toEqual([id]);
    const miss = await client.query<{ id: string }>(
      `SELECT id FROM context_document WHERE body_tsv @@ to_tsquery('simple', '문을:*')`,
    );
    expect(miss.rows).toEqual([]);

    await client.query(`UPDATE context_document SET body_md = 'replaced body' WHERE id = $1`, [id]);
    const updated = await client.query<{ body_tsv: string }>(
      'SELECT body_tsv::text FROM context_document WHERE id = $1',
      [id],
    );
    expect(updated.rows[0]?.body_tsv).toContain("'replaced'");
    expect(updated.rows[0]?.body_tsv).not.toContain("'summaries'");

    const write = await queryFailure(
      client.query(`UPDATE context_document SET body_tsv = to_tsvector('simple', 'x') WHERE id = $1`, [id]),
    );
    expect(write.code).toBe('428C9');
  });

  test('title, body size, sensitivity and source constraints are enforced', async () => {
    const ownerId = await insertUser();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ title: '' }, 'context_document_title_length'],
      [{ title: '   ' }, 'context_document_title_length'],
      [{ title: 'x'.repeat(201) }, 'context_document_title_length'],
      [{ body_md: 'x'.repeat(262_145) }, 'context_document_body_size'],
      [{ sensitivity: 'P0' }, 'context_document_sensitivity_valid'],
      [{ source: 'vikunja' }, 'context_document_source_valid'],
      [{ source: 'task_description' }, 'context_document_source_task_consistent'],
      [{ source_task_id: randomUUID() }, 'context_document_source_task_consistent'],
      [{ version: 0 }, 'context_document_version_positive'],
    ];
    for (const [overrides, constraint] of cases) {
      const failure = await queryFailure(insertDocument(ownerId, overrides));
      expect({ constraint, actual: failure.constraint }).toEqual({ constraint, actual: constraint });
    }
    await expect(insertDocument(ownerId, { body_md: '가'.repeat(65_536) })).resolves.toBeDefined();
  });

  test('a task description is promoted at most once while the copy is live', async () => {
    const ownerId = await insertUser();
    const taskId = randomUUID();
    const first = await insertDocument(ownerId, { source: 'task_description', source_task_id: taskId });
    const duplicate = await queryFailure(
      insertDocument(ownerId, { source: 'task_description', source_task_id: taskId }),
    );
    expect(duplicate.constraint).toBe('context_document_promoted_task_unique');
    await client.query('UPDATE context_document SET deleted_at = now() WHERE id = $1', [first]);
    await expect(
      insertDocument(ownerId, { source: 'task_description', source_task_id: taskId }),
    ).resolves.toBeDefined();
  });

  test('links are unique, kind-checked and owner-scoped through the document', async () => {
    const ownerId = await insertUser();
    const otherOwner = await insertUser();
    const documentId = await insertDocument(ownerId);
    const targetId = randomUUID();
    const insertLink = (owner: string, kind = 'goal', target = targetId) =>
      client.query(
        `INSERT INTO document_link (id, owner_id, document_id, target_kind, target_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), owner, documentId, kind, target],
      );
    await insertLink(ownerId);
    expect((await queryFailure(insertLink(ownerId))).constraint).toBe('document_link_unique');
    expect((await queryFailure(insertLink(ownerId, 'note', randomUUID()))).constraint).toBe(
      'document_link_target_kind_valid',
    );
    // Another owner cannot attach a link row to this owner's document.
    expect((await queryFailure(insertLink(otherOwner, 'task', randomUUID()))).constraint).toBe(
      'document_link_document_fk',
    );
  });

  test('usage rows store hashes only and are owner-scoped to the document and the run', async () => {
    const ownerId = await insertUser();
    const otherOwner = await insertUser();
    const documentId = await insertDocument(ownerId);
    const runId = await insertRun(ownerId);
    const otherRun = await insertRun(otherOwner);
    await insertUsage({ ownerId, documentId, runId, hashes: [HASH16, 'fedcba9876543210'] });
    expect(
      (await queryFailure(insertUsage({ ownerId, documentId, runId }))).constraint,
    ).toBe('note_ai_usage_run_document_unique');
    const secondRun = await insertRun(ownerId);
    for (const hashes of [
      [],
      ['not-a-hash'],
      ['0123456789ABCDEF'],
      [`${HASH16},${HASH16}`],
      [`${HASH16},${HASH16}`, ''],
      [HASH16, null],
    ]) {
      const failure = await queryFailure(insertUsage({ ownerId, documentId, runId: secondRun, hashes }));
      expect({ hashes, constraint: failure.constraint }).toEqual({
        hashes,
        constraint: 'note_ai_usage_section_hashes_format',
      });
    }
    expect(
      (await queryFailure(insertUsage({ ownerId, documentId, runId: secondRun, bodyHash: 'short' })))
        .constraint,
    ).toBe('note_ai_usage_body_hash_format');
    expect(
      (await queryFailure(insertUsage({ ownerId, documentId, runId: otherRun }))).constraint,
    ).toBe('note_ai_usage_run_fk');

    // Hard-deleting a document cascades its links and usage rows.
    await client.query('DELETE FROM context_document WHERE id = $1', [documentId]);
    const left = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM note_ai_usage');
    expect(left.rows[0]?.count).toBe('0');
  });

  test('rolls back 0013 with seeded rows and can reapply it', async () => {
    const ownerId = await insertUser();
    const documentId = await insertDocument(ownerId, { llm_allowed: true });
    await client.query(
      `INSERT INTO document_link (id, owner_id, document_id, target_kind, target_id)
       VALUES ($1, $2, $3, 'task', $4)`,
      [randomUUID(), ownerId, documentId, randomUUID()],
    );
    const runId = await insertRun(ownerId);
    await insertUsage({ ownerId, documentId, runId });

    await client.end();
    client = await connect(schema);

    // 0014 (FU-76) is newer and is unwound first.
    const rolledBack0014 = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack0014).toBe('0014_agent_run_cancelled.sql');

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0013_context_documents.sql');

    for (const table of NOTES_TABLES) {
      const gone = await client.query<{ name: string | null }>(
        'SELECT to_regclass($1)::text AS name',
        [table],
      );
      expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
    }
    // The referenced agent run belongs to 0005 and survives the rollback.
    const run = await client.query<{ id: string }>('SELECT id FROM agent_run WHERE id = $1', [runId]);
    expect(run.rows).toEqual([{ id: runId }]);

    const reapplied = await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(reapplied.applied).toEqual([
      '0013_context_documents.sql',
      '0014_agent_run_cancelled.sql',
    ]);
    const restored = await client.query<{ name: string | null }>(
      `SELECT to_regclass('context_document')::text AS name`,
    );
    expect(restored.rows[0]?.name).not.toBeNull();
  });
});
