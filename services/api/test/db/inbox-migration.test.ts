import { cp, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate, rollbackLatest } from '../../src/db/migrate.js';
import {
  createSchema,
  databaseUrl,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from './helpers.js';

const { Client } = pg;

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

describe.skipIf(!hasDatabase)('0002 inbox project migration', () => {
  let schema: string;
  let workDir: string;
  let migrations: string;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    workDir = await mkdtemp(join(tmpdir(), 'ohmydate-inbox-'));
    migrations = join(workDir, 'migrations');
    await cp(migrationsDir, migrations, { recursive: true });
    await rm(join(migrations, '0002_inbox_project.sql'));
    await rm(join(migrations, '0002_inbox_project.down.sql'));
  });

  afterEach(async () => {
    await dropSchema(schema);
    await rm(workDir, { recursive: true, force: true });
  });

  async function connect(): Promise<InstanceType<typeof Client>> {
    const client = new Client({
      connectionString: requireDatabaseUrl(),
      options: `-c search_path=${schema}`,
    });
    await client.connect();
    return client;
  }

  test('backfills one Inbox per user, attaches orphans, and rolls back cleanly', async () => {
    await migrate({ databaseUrl: databaseUrl as string, schema, migrationsDir: migrations });

    const client = await connect();
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    const normalProject = randomUUID();
    try {
      await client.query('INSERT INTO "user" (id, email, password_hash) VALUES ($1, $2, $3)', [
        ownerA,
        `${ownerA}@example.test`,
        'hash',
      ]);
      await client.query('INSERT INTO "user" (id, email, password_hash) VALUES ($1, $2, $3)', [
        ownerB,
        `${ownerB}@example.test`,
        'hash',
      ]);
      await client.query(
        'INSERT INTO project (id, owner_id, title) VALUES ($1, $2, $3)',
        [normalProject, ownerA, 'Existing project'],
      );
      await client.query(
        'INSERT INTO task (id, owner_id, project_id, title_cache) VALUES ($1, $2, $3, $4)',
        [randomUUID(), ownerA, normalProject, 'Attached task'],
      );
      await client.query(
        'INSERT INTO task (id, owner_id, title_cache) VALUES ($1, $2, $3)',
        [randomUUID(), ownerA, 'Orphan A'],
      );
      await client.query(
        'INSERT INTO task (id, owner_id, title_cache) VALUES ($1, $2, $3)',
        [randomUUID(), ownerB, 'Orphan B'],
      );
    } finally {
      await client.end();
    }

    await cp(
      join(migrationsDir, '0002_inbox_project.sql'),
      join(migrations, '0002_inbox_project.sql'),
    );
    await cp(
      join(migrationsDir, '0002_inbox_project.down.sql'),
      join(migrations, '0002_inbox_project.down.sql'),
    );
    await migrate({ databaseUrl: databaseUrl as string, schema, migrationsDir: migrations });

    const after = await connect();
    try {
      const inboxes = await after.query<{ owner_id: string; id: string; title: string }>(
        `SELECT owner_id, id, title FROM project WHERE kind = 'inbox' ORDER BY owner_id`,
      );
      expect(inboxes.rowCount).toBe(2);
      const byOwner = new Map(inboxes.rows.map((row) => [row.owner_id, row]));
      expect(byOwner.get(ownerA)?.title).toBe('Inbox');
      expect(byOwner.get(ownerB)?.title).toBe('Inbox');

      const tasks = await after.query<{ owner_id: string; project_id: string }>(
        'SELECT owner_id, project_id FROM task ORDER BY owner_id, title_cache',
      );
      expect(tasks.rows).toHaveLength(3);
      expect(tasks.rows.every((row) => typeof row.project_id === 'string')).toBe(true);
      const attached = tasks.rows.find((row) => row.project_id === normalProject);
      expect(attached).toBeDefined();
      for (const row of tasks.rows) {
        if (row.project_id === normalProject) continue;
        expect(row.project_id).toBe(byOwner.get(row.owner_id)?.id);
      }

      const nullable = await after.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'task' AND column_name = 'project_id'`,
        [schema],
      );
      expect(nullable.rows[0]?.is_nullable).toBe('NO');

      const duplicate = await after
        .query('INSERT INTO project (id, owner_id, title, kind) VALUES ($1, $2, $3, $4)', [
          randomUUID(),
          ownerA,
          'Second inbox',
          'inbox',
        ])
        .then(() => null)
        .catch((error: { code?: string }) => error);
      expect(duplicate?.code).toBe('23505');

      const invalidKind = await after
        .query('INSERT INTO project (id, owner_id, title, kind) VALUES ($1, $2, $3, $4)', [
          randomUUID(),
          ownerA,
          'Invalid',
          'archive',
        ])
        .then(() => null)
        .catch((error: { code?: string }) => error);
      expect(invalidKind?.code).toBe('23514');
    } finally {
      await after.end();
    }

    const rolledBack = await rollbackLatest({
      databaseUrl: databaseUrl as string,
      schema,
      migrationsDir: migrations,
    });
    expect(rolledBack).toBe('0002_inbox_project.sql');

    const down = await connect();
    try {
      const kindColumn = await down.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'project' AND column_name = 'kind'`,
        [schema],
      );
      expect(kindColumn.rowCount).toBe(0);
      const taskColumn = await down.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'task' AND column_name = 'project_id'`,
        [schema],
      );
      expect(taskColumn.rows[0]?.is_nullable).toBe('YES');
    } finally {
      await down.end();
    }
  });
});
