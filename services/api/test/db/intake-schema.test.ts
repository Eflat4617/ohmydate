import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
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

describe.skipIf(!hasDatabase)('0005 intake/estimation/agent schema', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
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

  async function insertProject(ownerId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      'INSERT INTO project (id, owner_id, title, kind) VALUES ($1, $2, $3, $4)',
      [id, ownerId, 'Project', 'normal'],
    );
    return id;
  }

  async function insertTask(ownerId: string): Promise<string> {
    const id = randomUUID();
    const projectId = await insertProject(ownerId);
    await client.query(
      'INSERT INTO task (id, owner_id, project_id, title_cache) VALUES ($1, $2, $3, $4)',
      [id, ownerId, projectId, 'task'],
    );
    return id;
  }

  async function insertTemplate(ownerId: string): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO task_template (id, owner_id, name, steps, stats, source, confidence)
       VALUES ($1, $2, $3, '[]'::jsonb, '{}'::jsonb, 'system', 0.5)`,
      [id, ownerId, 'Template'],
    );
    return id;
  }

  test('creates the M2 tables with the documented column shapes', async () => {
    const result = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name IN (
            'goal', 'task_template', 'task_type_fingerprint', 'intake_session',
            'intake_answer', 'estimate', 'estimate_evidence', 'agent_run',
            'agent_proposal'
          )
        ORDER BY table_name, column_name`,
      [schema],
    );

    const byTable = new Map<string, string[]>();
    for (const row of result.rows) {
      const columns = byTable.get(row.table_name) ?? [];
      columns.push(row.column_name);
      byTable.set(row.table_name, columns);
    }

    expect([...byTable.keys()].sort()).toEqual([
      'agent_proposal',
      'agent_run',
      'estimate',
      'estimate_evidence',
      'goal',
      'intake_answer',
      'intake_session',
      'task_template',
      'task_type_fingerprint',
    ]);

    for (const required of ['input', 'detected_type', 'template_id', 'round', 'error', 'version']) {
      expect(byTable.get('intake_session')).toContain(required);
    }
    expect(byTable.get('task_type_fingerprint')).toContain('keywords');
    expect(byTable.get('estimate')).toContain('is_current');
    expect(byTable.get('agent_run')).toEqual(
      expect.arrayContaining([
        'purpose',
        'prompt_id_version',
        'model',
        'provider',
        'tokens_in',
        'tokens_out',
        'cost_usd',
        'latency_ms',
        'status',
        'redaction_report',
        'version',
      ]),
    );
    expect(byTable.get('agent_proposal')).toEqual(
      expect.arrayContaining([
        'run_id',
        'kind',
        'payload',
        'schema_ok',
        'policy_ok',
        'constraint_ok',
        'decision',
        'version',
      ]),
    );
  });

  test('agent_run stores metadata only (no prompt or response text columns)', async () => {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'agent_run'`,
      [schema],
    );
    const names = result.rows.map((row) => row.column_name);
    for (const forbidden of [
      'prompt',
      'prompt_text',
      'response',
      'response_text',
      'request',
      'output',
    ]) {
      expect({ forbidden, present: names.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      });
    }
  });

  test('task_type_fingerprint has a GIN index on keywords and estimate has a partial unique current index', async () => {
    const gin = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'task_type_fingerprint_keywords_gin'`,
      [schema],
    );
    expect(gin.rows[0]?.indexdef).toMatch(/USING gin \(keywords\)/);

    const current = await client.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = $1 AND indexname = 'estimate_current_per_task_idx'`,
      [schema],
    );
    expect(current.rows[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(task_id\).*WHERE is_current/);
  });

  test('enforces state, version and estimate invariants', async () => {
    const ownerId = await insertUser();

    const badVersion = await queryFailure(
      client.query(
        `INSERT INTO goal (id, owner_id, title, version) VALUES ($1, $2, 'g', 0)`,
        [randomUUID(), ownerId],
      ),
    );
    expect(badVersion.code).toBe('23514');
    expect(badVersion.constraint).toBe('goal_version_positive');

    const badState = await queryFailure(
      client.query(
        `INSERT INTO intake_session (id, owner_id, state) VALUES ($1, $2, 'paused')`,
        [randomUUID(), ownerId],
      ),
    );
    expect(badState.code).toBe('23514');
    expect(badState.constraint).toBe('intake_session_state_valid');

    const taskId = await insertTask(ownerId);
    const first = randomUUID();
    await client.query(
      `INSERT INTO estimate (id, owner_id, task_id, p50_min, p90_min, method, confidence)
       VALUES ($1, $2, $3, 60, 120, 'template', 0.5)`,
      [first, ownerId, taskId],
    );

    const duplicate = await queryFailure(
      client.query(
        `INSERT INTO estimate (id, owner_id, task_id, p50_min, p90_min, method, confidence)
         VALUES ($1, $2, $3, 90, 180, 'personal', 0.6)`,
        [randomUUID(), ownerId, taskId],
      ),
    );
    expect(duplicate.code).toBe('23505');
    expect(duplicate.constraint).toBe('estimate_current_per_task_idx');

    await client.query('UPDATE estimate SET is_current = false WHERE id = $1', [first]);
    await client.query(
      `INSERT INTO estimate (id, owner_id, task_id, p50_min, p90_min, method, confidence)
       VALUES ($1, $2, $3, 90, 180, 'personal', 0.6)`,
      [randomUUID(), ownerId, taskId],
    );

    const badRange = await queryFailure(
      client.query(
        `INSERT INTO estimate (id, owner_id, task_id, p50_min, p90_min, method, confidence, is_current)
         VALUES ($1, $2, $3, 200, 100, 'llm', 0.2, false)`,
        [randomUUID(), ownerId, taskId],
      ),
    );
    expect(badRange.code).toBe('23514');
    expect(badRange.constraint).toBe('estimate_p90_not_below_p50');
  });

  test('scopes templates, sessions, answers and estimates to one owner', async () => {
    const ownerA = await insertUser();
    const ownerB = await insertUser();
    const templateA = await insertTemplate(ownerA);
    const taskB = await insertTask(ownerB);

    const crossOwnerSession = await queryFailure(
      client.query(
        `INSERT INTO intake_session (id, owner_id, template_id) VALUES ($1, $2, $3)`,
        [randomUUID(), ownerB, templateA],
      ),
    );
    expect(crossOwnerSession.code).toBe('23503');
    expect(crossOwnerSession.constraint).toBe('intake_session_template_fk');

    const crossOwnerEstimate = await queryFailure(
      client.query(
        `INSERT INTO estimate (id, owner_id, task_id, p50_min, p90_min, method, confidence)
         VALUES ($1, $2, $3, 30, 60, 'prior', 0.2)`,
        [randomUUID(), ownerA, taskB],
      ),
    );
    expect(crossOwnerEstimate.code).toBe('23503');
    expect(crossOwnerEstimate.constraint).toBe('estimate_task_fk');
  });

  test('persists intake answers, agent runs and proposals with cascade cleanup', async () => {
    const ownerId = await insertUser();
    const templateId = await insertTemplate(ownerId);
    const sessionId = randomUUID();
    await client.query(
      `INSERT INTO intake_session (id, owner_id, state, input, detected_type, template_id, round)
       VALUES ($1, $2, 'clarification', '{"deliverable":"report"}'::jsonb,
               '{"classification":"similar","confidence":0.8,"reasons":[],"missingRequired":[]}'::jsonb,
               $3, 2)`,
      [sessionId, ownerId, templateId],
    );

    const answerId = randomUUID();
    await client.query(
      `INSERT INTO intake_answer (id, owner_id, session_id, question_key, question_text, answer, skipped)
       VALUES ($1, $2, $3, 'dueAt', 'When is it due?', NULL, true)`,
      [answerId, ownerId, sessionId],
    );

    const fingerprintId = randomUUID();
    await client.query(
      `INSERT INTO task_type_fingerprint (id, owner_id, template_id, tags, keywords, meta)
       VALUES ($1, $2, $3, ARRAY['paper','summary'], to_tsvector('english', 'paper summary'),
               '{"source":"user"}'::jsonb)`,
      [fingerprintId, ownerId, templateId],
    );

    const runId = randomUUID();
    await client.query(
      `INSERT INTO agent_run
         (id, owner_id, purpose, prompt_id_version, model, provider, tokens_in, tokens_out,
          cost_usd, latency_ms, status, redaction_report)
       VALUES ($1, $2, 'detect_type', 'type_detection@v1', 'fake', 'fake-llm', 10, 20,
               0.001234, 42, 'succeeded', '{"masked":["email"]}'::jsonb)`,
      [runId, ownerId],
    );
    await client.query(
      `INSERT INTO agent_proposal
         (id, owner_id, run_id, kind, payload, schema_ok, policy_ok, constraint_ok, decision)
       VALUES ($1, $2, $3, 'type_detection', '{"classification":"new"}'::jsonb, true, true, true, 'pending')`,
      [randomUUID(), ownerId, runId],
    );

    const badDecision = await queryFailure(
      client.query(
        `INSERT INTO agent_proposal (id, owner_id, run_id, kind, payload, decision)
         VALUES ($1, $2, $3, 'type_detection', '{}'::jsonb, 'deferred')`,
        [randomUUID(), ownerId, runId],
      ),
    );
    expect(badDecision.code).toBe('23514');
    expect(badDecision.constraint).toBe('agent_proposal_decision_valid');

    await client.query('DELETE FROM intake_session WHERE id = $1', [sessionId]);
    const answers = await client.query('SELECT 1 FROM intake_answer WHERE session_id = $1', [
      sessionId,
    ]);
    expect(answers.rowCount).toBe(0);

    await client.query('DELETE FROM task_template WHERE id = $1', [templateId]);
    const fingerprints = await client.query(
      'SELECT 1 FROM task_type_fingerprint WHERE id = $1',
      [fingerprintId],
    );
    expect(fingerprints.rowCount).toBe(0);

    await client.query('DELETE FROM agent_run WHERE id = $1', [runId]);
    const proposals = await client.query('SELECT 1 FROM agent_proposal WHERE run_id = $1', [
      runId,
    ]);
    expect(proposals.rowCount).toBe(0);
  });
});
