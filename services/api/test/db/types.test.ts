import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { databaseTables, type ColumnKind } from '../../src/db/types.js';
import {
  connect,
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from './helpers.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

const KIND_TO_INFORMATION_SCHEMA: Record<ColumnKind, string> = {
  uuid: 'uuid',
  text: 'text',
  jsonb: 'jsonb',
  timestamptz: 'timestamp with time zone',
  integer: 'integer',
  boolean: 'boolean',
};

describe.skipIf(!hasDatabase)('Kysely types vs information_schema', () => {
  let schema: string;

  beforeAll(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
  });

  afterAll(async () => {
    await dropSchema(schema);
  });

  test('databaseTables matches every migrated column and type', async () => {
    const client = await connect();
    try {
      const result = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
      }>(
        `SELECT table_name, column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = $1
          ORDER BY table_name, ordinal_position`,
        [schema],
      );

      const actual = new Map<string, Record<string, string>>();
      for (const row of result.rows) {
        if (row.table_name === 'schema_migrations') continue;
        const columns = actual.get(row.table_name) ?? {};
        columns[row.column_name] = row.data_type;
        actual.set(row.table_name, columns);
      }

      expect([...actual.keys()].sort()).toEqual(Object.keys(databaseTables).sort());

      for (const [tableName, columns] of Object.entries(databaseTables)) {
        const expected: Record<string, string> = {};
        for (const [columnName, kind] of Object.entries(columns) as Array<[string, ColumnKind]>) {
          expected[columnName] = KIND_TO_INFORMATION_SCHEMA[kind];
        }
        expect(actual.get(tableName)).toEqual(expected);
      }
    } finally {
      await client.end();
    }
  });
});
