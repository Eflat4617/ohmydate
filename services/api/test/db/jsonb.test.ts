import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { jsonb, type Database, type JsonValue } from '../../src/db/types.js';
import {
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from './helpers.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

describe.skipIf(!hasDatabase)('JSONB write contract (Kysely + node-pg)', () => {
  let schema: string;
  let pool: pg.Pool;
  let db: Kysely<Database>;
  let ownerId: string;

  beforeAll(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir });

    pool = new pg.Pool({
      connectionString: requireDatabaseUrl(),
      max: 2,
      options: `-c search_path=${schema}`,
    });
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

    ownerId = randomUUID();
    await db
      .insertInto('user')
      .values({ id: ownerId, email: `${ownerId}@example.test`, password_hash: 'placeholder' })
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await dropSchema(schema);
  });

  const roundTrips: ReadonlyArray<readonly [string, JsonValue]> = [
    ['object', { taskId: 'abc', count: 2 }],
    ['empty array', []],
    ['nonempty array', ['a', 'b']],
    ['nested', { list: [{ id: 1 }, { id: 2 }], flags: [true, false, null] }],
    ['scalar string', 'hello'],
    ['number', 123],
    ['boolean', true],
    ['json null', null],
  ];

  test.each(roundTrips)('round-trips %s faithfully', async (_label, value) => {
    const id = randomUUID();
    await db
      .insertInto('outbox_event')
      .values({ id, owner_id: ownerId, topic: 'jsonb.roundtrip', payload: jsonb(value) })
      .execute();

    const row = await db
      .selectFrom('outbox_event')
      .select('payload')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(row.payload).toEqual(value);
  });

  test('stores SQL NULL in a nullable JSONB column', async () => {
    const id = randomUUID();
    await db
      .insertInto('inbox_event')
      .values({
        id,
        owner_id: ownerId,
        provider: 'vikunja',
        event_hash: randomUUID(),
        payload: null,
      })
      .execute();

    const row = await db
      .selectFrom('inbox_event')
      .select('payload')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(row.payload).toBeNull();
  });

  test('updates a JSONB column with jsonb()', async () => {
    const id = randomUUID();
    await db
      .insertInto('outbox_event')
      .values({ id, owner_id: ownerId, topic: 'jsonb.update', payload: jsonb({ step: 1 }) })
      .execute();

    await db
      .updateTable('outbox_event')
      .set({ payload: jsonb({ step: 2, tags: ['x'] }) })
      .where('id', '=', id)
      .execute();

    const row = await db
      .selectFrom('outbox_event')
      .select('payload')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    expect(row.payload).toEqual({ step: 2, tags: ['x'] });
  });
});
