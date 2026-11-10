import { fileURLToPath } from 'node:url';
import { migrate } from '../../src/db/migrate.js';
import { databaseTables, type ColumnKind, type ColumnSpec } from '../../src/db/types.js';
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
  date: 'date',
  real: 'real',
  numeric: 'numeric',
  tsvector: 'tsvector',
  text_array: 'ARRAY',
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

  test('databaseTables matches every migrated column type, nullability and default', async () => {
    const client = await connect();
    try {
      const result = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: 'YES' | 'NO';
        column_default: string | null;
      }>(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = $1
          ORDER BY table_name, ordinal_position`,
        [schema],
      );

      const actual = new Map<string, Record<string, ColumnSpec>>();
      for (const row of result.rows) {
        if (row.table_name === 'schema_migrations') continue;
        const columns = actual.get(row.table_name) ?? {};
        columns[row.column_name] = {
          kind: informationSchemaKind(row.data_type),
          nullable: row.is_nullable === 'YES',
          hasDefault: row.column_default !== null,
        };
        actual.set(row.table_name, columns);
      }

      expect([...actual.keys()].sort()).toEqual(Object.keys(databaseTables).sort());

      for (const [tableName, columns] of Object.entries(databaseTables)) {
        expect(actual.get(tableName)).toEqual(columns);
      }
    } finally {
      await client.end();
    }
  });
});

function informationSchemaKind(dataType: string): ColumnKind {
  const match = (Object.entries(KIND_TO_INFORMATION_SCHEMA) as Array<[ColumnKind, string]>).find(
    ([, value]) => value === dataType,
  );
  if (match === undefined) {
    throw new Error(`unexpected information_schema data_type: ${dataType}`);
  }
  return match[0];
}
