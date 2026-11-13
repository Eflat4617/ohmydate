import { createHash, randomUUID } from 'node:crypto';
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

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe.skipIf(!hasDatabase)('0015 auth_session (FU-92)', () => {
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

  function insertSession(userId: string, seed: string = randomUUID()): Promise<unknown> {
    return client.query(
      `INSERT INTO auth_session (id_hash, user_id, csrf_token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '14 days')`,
      [sha256(`sid-${seed}`), userId, sha256(`csrf-${seed}`)],
    );
  }

  test('indexes expires_at and user_id; the user FK cascades on delete', async () => {
    const indexes = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = $1 AND tablename = 'auth_session'
        ORDER BY indexname`,
      [schema],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'auth_session_expires_at_idx',
      'auth_session_pkey',
      'auth_session_user_id_idx',
    ]);
    expect(indexes.rows.find((row) => row.indexname === 'auth_session_pkey')?.indexdef).toMatch(
      /\(id_hash\)/,
    );

    const fk = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint AS c
         JOIN pg_class AS t ON t.oid = c.conrelid
         JOIN pg_namespace AS n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = 'auth_session' AND c.contype = 'f'`,
      [schema],
    );
    expect(fk.rows).toHaveLength(1);
    expect(fk.rows[0]?.definition).toMatch(/REFERENCES .*"user"\(id\) ON DELETE CASCADE/);

    const userId = await insertUser();
    await insertSession(userId);
    await insertSession(userId);
    await client.query('DELETE FROM "user" WHERE id = $1', [userId]);
    const left = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM auth_session',
    );
    expect(left.rows[0]?.count).toBe('0');
  });

  test('rejects raw (non-digest) values, duplicates and unknown users', async () => {
    const userId = await insertUser();
    const raw = await queryFailure(
      client.query(
        `INSERT INTO auth_session (id_hash, user_id, csrf_token_hash, expires_at)
         VALUES ($1, $2, $3, now())`,
        ['Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg', userId, sha256('csrf')],
      ),
    );
    expect(raw.code).toBe('23514');
    expect(raw.constraint).toBe('auth_session_id_hash_sha256');

    await insertSession(userId, 'same');
    const duplicate = await queryFailure(insertSession(userId, 'same'));
    expect(duplicate.code).toBe('23505');

    const orphan = await queryFailure(insertSession(randomUUID()));
    expect(orphan.code).toBe('23503');
  });

  test('rolls back 0015 with seeded rows and can reapply it', async () => {
    const userId = await insertUser();
    await insertSession(userId);

    await client.end();
    client = await connect(schema);

    // 0016 (CAL-03) is newer and is unwound first.
    const rolledBack0016 = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack0016).toBe('0016_google_calendar.sql');

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0015_auth_sessions.sql');
    const gone = await client.query<{ name: string | null }>(
      `SELECT to_regclass('auth_session')::text AS name`,
    );
    expect(gone.rows[0]?.name).toBeNull();
    const users = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM "user"',
    );
    expect(users.rows[0]?.count).toBe('1');

    const reapplied = await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });
    expect(reapplied.applied).toEqual(['0015_auth_sessions.sql', '0016_google_calendar.sql']);
    await insertSession(userId);
    const count = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM auth_session',
    );
    expect(count.rows[0]?.count).toBe('1');
  });
});
