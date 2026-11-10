import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import type { Database } from '../../src/db/types.js';
import {
  createSchema,
  databaseUrl,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from '../db/helpers.js';

const { Pool } = pg;

export { databaseUrl, hasDatabase };

export interface PgTestStore {
  readonly db: Kysely<Database>;
  readonly schema: string;
  close(): Promise<void>;
}

/**
 * Creates an isolated schema with every migration applied and a Kysely handle
 * bound to it. `DEFAULT search_path` is avoided by using `.withSchema`, so two
 * test files running in parallel cannot see each other's rows.
 */
export async function createPgTestStore(): Promise<PgTestStore> {
  const schema = makeSchemaName();
  await createSchema(schema);
  await migrate({ databaseUrl: requireDatabaseUrl(), schema });
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema(
    schema,
  ) as Kysely<Database>;
  return {
    db,
    schema,
    async close() {
      await db.destroy();
      await dropSchema(schema);
    },
  };
}
