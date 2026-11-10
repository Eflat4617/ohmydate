import { randomUUID } from 'node:crypto';
import '../../src/db/types.js';
import { migrate } from '../../src/db/migrate.js';
import {
  connect,
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
  type PgClient,
} from './helpers.js';

describe.skipIf(!hasDatabase)('pg date parser (OID 1082)', () => {
  let schema: string;
  let client: PgClient;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: requireDatabaseUrl(), schema });
    client = await connect(schema);
  });

  afterEach(async () => {
    await client.end();
    await dropSchema(schema);
  });

  test('goal.target_date round-trips as YYYY-MM-DD text', async () => {
    const ownerId = randomUUID();
    const goalId = randomUUID();
    await client.query('INSERT INTO "user" (id, email, password_hash) VALUES ($1, $2, $3)', [
      ownerId,
      `${ownerId}@example.test`,
      'argon2id-placeholder',
    ]);
    await client.query(
      'INSERT INTO goal (id, owner_id, title, target_date) VALUES ($1, $2, $3, $4)',
      [goalId, ownerId, 'Date round trip', '2026-11-20'],
    );

    const result = await client.query<{ target_date: unknown }>(
      'SELECT target_date FROM goal WHERE id = $1',
      [goalId],
    );
    expect(result.rows[0]?.target_date).toBe('2026-11-20');
  });
});
