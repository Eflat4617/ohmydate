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

describe.skipIf(!hasDatabase)('0014 agent_run cancelled status (FU-76)', () => {
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

  function insertRun(ownerId: string, status: string, costUsd = '0.001234'): Promise<unknown> {
    return client.query(
      `INSERT INTO agent_run
         (id, owner_id, purpose, prompt_id_version, model, provider, status, tokens_in, tokens_out, cost_usd)
       VALUES ($1, $2, 'decomposition', 'decomposition@v1', 'unknown', 'deepseek', $3, 0, 0, $4)`,
      [randomUUID(), ownerId, status, costUsd],
    );
  }

  test('accepts cancelled alongside the existing statuses and still rejects unknown ones', async () => {
    const ownerId = await insertUser();
    for (const status of ['pending', 'succeeded', 'failed', 'budget_exceeded', 'cancelled']) {
      await insertRun(ownerId, status);
    }
    const failure = await queryFailure(insertRun(ownerId, 'running'));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('agent_run_status_valid');
  });

  test('rolls back 0014 with seeded rows (cancelled -> failed, cost kept) and can reapply it', async () => {
    const ownerId = await insertUser();
    await insertRun(ownerId, 'cancelled', '0.004321');
    await insertRun(ownerId, 'succeeded', '0.000100');
    await insertRun(ownerId, 'pending', '0');

    await client.end();
    client = await connect(schema);

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0014_agent_run_cancelled.sql');

    const rows = await client.query<{ status: string; cost_usd: string; version: number }>(
      'SELECT status, cost_usd::text AS cost_usd, version FROM agent_run ORDER BY cost_usd DESC',
    );
    expect(rows.rows).toEqual([
      { status: 'failed', cost_usd: '0.004321', version: 2 },
      { status: 'succeeded', cost_usd: '0.000100', version: 1 },
      { status: 'pending', cost_usd: '0.000000', version: 1 },
    ]);
    const rejected = await queryFailure(insertRun(ownerId, 'cancelled'));
    expect(rejected.code).toBe('23514');

    const reapplied = await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    expect(reapplied.applied).toEqual(['0014_agent_run_cancelled.sql']);
    await insertRun(ownerId, 'cancelled');
    const count = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_run WHERE status = 'cancelled'`,
    );
    expect(count.rows[0]?.count).toBe('1');
  });
});
