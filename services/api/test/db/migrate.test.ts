import { copyFile, cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MigrationChecksumMismatchError,
  migrate,
  rollbackLatest,
} from '../../src/db/migrate.js';
import {
  connect,
  createSchema,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from './helpers.js';

const migrationsDir = fileURLToPath(new URL('../../migrations/', import.meta.url));

const M1_TABLES = [
  'audit_event',
  'external_provider_mapping',
  'idempotency_record',
  'inbox_event',
  'job',
  'outbox_event',
  'project',
  'task',
  'task_dependency',
  'user',
];

describe.skipIf(!hasDatabase)('migration runner', () => {
  let schema: string;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
  });

  afterEach(async () => {
    await dropSchema(schema);
  });

  function runMigrations(targetSchema = schema, dir = migrationsDir) {
    return migrate({
      databaseUrl: requireDatabaseUrl(),
      schema: targetSchema,
      migrationsDir: dir,
    });
  }

  test('applies every migration on a fresh schema', async () => {
    const result = await runMigrations();

    expect(result.applied).toEqual(['0001_init.sql']);
    expect(result.skipped).toEqual([]);

    const client = await connect(schema);
    try {
      const tables = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
        [schema],
      );
      const names = tables.rows.map((row) => row.table_name).sort();
      expect(names).toEqual([...M1_TABLES, 'schema_migrations'].sort());
    } finally {
      await client.end();
    }
  });

  test('is idempotent on re-run', async () => {
    await runMigrations();
    const second = await runMigrations();

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_init.sql']);
  });

  test('refuses to run when an applied file checksum changed', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await runMigrations(schema, copyDir);

      const migrationFile = join(copyDir, '0001_init.sql');
      const original = await readFile(migrationFile, 'utf8');
      await writeFile(migrationFile, `${original}\n-- tampered after apply\n`, 'utf8');

      await expect(runMigrations(schema, copyDir)).rejects.toBeInstanceOf(
        MigrationChecksumMismatchError,
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('concurrent runners apply each migration exactly once', async () => {
    const results = await Promise.all([runMigrations(), runMigrations()]);

    const appliedCounts = results.map((result) => result.applied.length).sort();
    expect(appliedCounts).toEqual([0, 1]);
    expect(results.flatMap((result) => result.applied)).toEqual(['0001_init.sql']);

    const client = await connect(schema);
    try {
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(count.rows[0]?.count).toBe('1');
    } finally {
      await client.end();
    }
  });

  test('rolls back the latest migration and can apply it again', async () => {
    await runMigrations();

    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBe('0001_init.sql');

    const client = await connect(schema);
    try {
      const gone = await client.query<{ name: string | null }>(
        `SELECT to_regclass('"user"')::text AS name`,
      );
      expect(gone.rows[0]?.name).toBeNull();
    } finally {
      await client.end();
    }

    const reapplied = await runMigrations();
    expect(reapplied.applied).toEqual(['0001_init.sql']);

    const clientAfter = await connect(schema);
    try {
      const present = await clientAfter.query<{ name: string | null }>(
        `SELECT to_regclass('"user"')::text AS name`,
      );
      expect(present.rows[0]?.name).not.toBeNull();
    } finally {
      await clientAfter.end();
    }
  });

  test('rollback is a no-op when nothing has been applied', async () => {
    const rolledBack = await rollbackLatest({
      databaseUrl: requireDatabaseUrl(),
      schema,
      migrationsDir,
    });
    expect(rolledBack).toBeNull();
  });

  test('refuses to run when an applied down file checksum changed', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await runMigrations(schema, copyDir);

      const downFile = join(copyDir, '0001_init.down.sql');
      const original = await readFile(downFile, 'utf8');
      await writeFile(downFile, `${original}\n-- tampered after apply\n`, 'utf8');

      await expect(runMigrations(schema, copyDir)).rejects.toBeInstanceOf(
        MigrationChecksumMismatchError,
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('refuses a new migration numbered below the highest applied', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await rename(join(copyDir, '0001_init.sql'), join(copyDir, '0002_init.sql'));
      await rename(join(copyDir, '0001_init.down.sql'), join(copyDir, '0002_init.down.sql'));

      const first = await runMigrations(schema, copyDir);
      expect(first.applied).toEqual(['0002_init.sql']);

      await copyFile(join(migrationsDir, '0001_init.sql'), join(copyDir, '0001_init.sql'));
      await copyFile(
        join(migrationsDir, '0001_init.down.sql'),
        join(copyDir, '0001_init.down.sql'),
      );

      await expect(runMigrations(schema, copyDir)).rejects.toThrow(/numbered below/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('refuses when an applied migration file is missing', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await runMigrations(schema, copyDir);

      await rm(join(copyDir, '0001_init.sql'));
      await rm(join(copyDir, '0001_init.down.sql'));
      await writeFile(join(copyDir, '0002_other.sql'), 'SELECT 1;', 'utf8');

      await expect(runMigrations(schema, copyDir)).rejects.toThrow(/missing from/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('rollbackLatest refuses after a forward checksum tamper', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await runMigrations(schema, copyDir);

      const migrationFile = join(copyDir, '0001_init.sql');
      const original = await readFile(migrationFile, 'utf8');
      await writeFile(migrationFile, `${original}\n-- tampered after apply\n`, 'utf8');

      await expect(
        rollbackLatest({ databaseUrl: requireDatabaseUrl(), schema, migrationsDir: copyDir }),
      ).rejects.toBeInstanceOf(MigrationChecksumMismatchError);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('rolls back the whole batch when a later migration fails', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await writeFile(join(copyDir, '0002_broken.sql'), 'CREATE TABLE broken (', 'utf8');

      await expect(runMigrations(schema, copyDir)).rejects.toThrow();

      const client = await connect(schema);
      try {
        const result = await client.query<{ user_table: string | null; migrations: string | null }>(
          `SELECT to_regclass('"user"')::text AS user_table,
                  to_regclass('schema_migrations')::text AS migrations`,
        );
        expect(result.rows[0]).toEqual({ user_table: null, migrations: null });
      } finally {
        await client.end();
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
