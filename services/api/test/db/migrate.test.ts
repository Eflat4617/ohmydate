import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

function migrationFilenames(dir = migrationsDir): string[] {
  return readdirSync(dir)
    .filter((entry) => /^\d{4}_[A-Za-z0-9_]+\.sql$/.test(entry) && !entry.endsWith('.down.sql'))
    .sort();
}

const MIGRATION_FILES = [
  '0001_init.sql',
  '0002_inbox_project.sql',
  '0003_vikunja_durable_stores.sql',
  '0004_inbox_mapping_column.sql',
  '0005_intake_estimation_agent.sql',
  '0006_intake_approval.sql',
  '0007_planning_core.sql',
  '0008_plan_api_persistence.sql',
  '0009_today_sessions.sql',
  '0010_daily_storage.sql',
  '0011_llm_spend.sql',
] as const;

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

// 0003_vikunja_durable_stores.sql. 0002 (FU-18) only alters existing tables.
const VIKUNJA_TABLES = [
  'vikunja_change_journal',
  'vikunja_journal_epoch',
  'vikunja_mapping',
  'vikunja_owner_account',
  'vikunja_planner_fields',
];

// 0005_intake_estimation_agent.sql.
const APPROVAL_TABLES = ['intake_approval', 'intake_approval_step'];

const M2_TABLES = [
  'agent_proposal',
  'agent_run',
  'estimate',
  'estimate_evidence',
  'goal',
  'intake_answer',
  'intake_session',
  'task_template',
  'task_type_fingerprint',
];

// 0007_planning_core.sql.
const PLANNING_TABLES = [
  'availability_exception',
  'availability_rule',
  'commitment_event',
  'plan',
  'plan_candidate',
  'plan_version',
  'schedule_approval',
  'schedule_block',
  'user_availability_version',
];

// 0011_llm_spend.sql.
const LLM_SPEND_TABLES = ['llm_spend'];

// 0009_today_sessions.sql.
const M4_TABLES = [
  'estimation_feedback',
  'export_job',
  'notification',
  'push_subscription',
  'task_completion_review',
  'work_session',
];

// 0010_daily_storage.sql.
const DAILY_STORAGE_TABLES = ['today_proposal'];

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

    expect(result.applied).toEqual(MIGRATION_FILES);
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
      expect(names).toEqual(
        [
          ...M1_TABLES,
          ...VIKUNJA_TABLES,
          ...M2_TABLES,
          ...APPROVAL_TABLES,
          ...PLANNING_TABLES,
          ...M4_TABLES,
          ...DAILY_STORAGE_TABLES,
          ...LLM_SPEND_TABLES,
          'schema_migrations',
        ].sort(),
      );
    } finally {
      await client.end();
    }
  });

  test('0004 adds the dedicated inbox column, check and partial unique index', async () => {
    await runMigrations();

    const client = await connect(schema);
    try {
      const column = await client.query<{
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'vikunja_mapping'
            AND column_name = 'is_inbox'`,
        [schema],
      );
      expect(column.rows[0]).toEqual({
        data_type: 'boolean',
        is_nullable: 'NO',
        column_default: 'false',
      });

      const index = await client.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = $1 AND indexname = 'vikunja_mapping_owner_inbox_unique'`,
        [schema],
      );
      expect(index.rows[0]?.indexdef).toMatch(
        /UNIQUE INDEX .*\(owner_id\).*WHERE is_inbox/,
      );

      const constraint = await client.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition
           FROM pg_constraint AS c
           JOIN pg_class AS t ON t.oid = c.conrelid
           JOIN pg_namespace AS n ON n.oid = t.relnamespace
          WHERE n.nspname = $1 AND t.relname = 'vikunja_mapping'
            AND c.conname = 'vikunja_mapping_inbox_project_only'`,
        [schema],
      );
      expect(constraint.rows[0]?.definition).toMatch(/CHECK/);
      expect(constraint.rows[0]?.definition).toMatch(/is_inbox/);
    } finally {
      await client.end();
    }
  });

  test('0004 backfills one live inbox per owner and clears project fingerprints', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await mkdir(copyDir, { recursive: true });
      const earlier = [
        '0001_init.sql',
        '0001_init.down.sql',
        '0002_inbox_project.sql',
        '0002_inbox_project.down.sql',
        '0003_vikunja_durable_stores.sql',
        '0003_vikunja_durable_stores.down.sql',
      ];
      for (const name of earlier) {
        await copyFile(join(migrationsDir, name), join(copyDir, name));
      }
      expect((await runMigrations(schema, copyDir)).applied).toEqual([
        '0001_init.sql',
        '0002_inbox_project.sql',
        '0003_vikunja_durable_stores.sql',
      ]);

      const owner = randomUUID();
      const client = await connect(schema);
      try {
        const rows: readonly [string, string, string, string | null][] = [
          ['project', '1', 'inbox', null],
          ['project', '2', 'inbox', null],
          ['project', '3', 'inbox', '2026-01-05T00:00:00Z'],
          ['project', '4', 'other-fingerprint', null],
          ['task', '5', 'inbox', null],
        ];
        for (const [entityType, externalId, fingerprint, deletedAt] of rows) {
          const updatedAt =
            externalId === '2'
              ? '2026-01-03T00:00:00Z'
              : externalId === '3'
                ? '2026-01-04T00:00:00Z'
                : '2026-01-01T00:00:00Z';
          await client.query(
            `INSERT INTO vikunja_mapping
               (entity_type, entity_id, owner_id, external_id, local_version,
                content_fingerprint, created_at, updated_at, deleted_at)
             VALUES ($1, $2, $3, $4, 1, $5, $6, $6, $7)`,
            [
              entityType,
              randomUUID(),
              owner,
              externalId,
              fingerprint,
              updatedAt,
              deletedAt,
            ],
          );
        }
      } finally {
        await client.end();
      }

      for (const name of ['0004_inbox_mapping_column.sql', '0004_inbox_mapping_column.down.sql']) {
        await copyFile(join(migrationsDir, name), join(copyDir, name));
      }
      expect((await runMigrations(schema, copyDir)).applied).toEqual([
        '0004_inbox_mapping_column.sql',
      ]);

      const check = await connect(schema);
      try {
        const applied = await check.query<{
          external_id: string;
          is_inbox: boolean;
          content_fingerprint: string | null;
        }>(
          `SELECT external_id, is_inbox, content_fingerprint
             FROM vikunja_mapping
            ORDER BY external_id`,
        );
        expect(applied.rows).toEqual([
          { external_id: '1', is_inbox: false, content_fingerprint: null },
          { external_id: '2', is_inbox: true, content_fingerprint: null },
          { external_id: '3', is_inbox: false, content_fingerprint: null },
          { external_id: '4', is_inbox: false, content_fingerprint: null },
          { external_id: '5', is_inbox: false, content_fingerprint: 'inbox' },
        ]);
      } finally {
        await check.end();
      }

      const rolledBack = await rollbackLatest({
        databaseUrl: requireDatabaseUrl(),
        schema,
        migrationsDir: copyDir,
      });
      expect(rolledBack).toBe('0004_inbox_mapping_column.sql');

      const after = await connect(schema);
      try {
        const column = await after.query<{ name: string | null }>(
          `SELECT column_name AS name
             FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = 'vikunja_mapping'
              AND column_name = 'is_inbox'`,
          [schema],
        );
        expect(column.rows[0]?.name).toBeUndefined();
        const restored = await after.query<{
          external_id: string;
          content_fingerprint: string | null;
        }>(
          `SELECT external_id, content_fingerprint
             FROM vikunja_mapping
            WHERE external_id IN ('2', '4')
            ORDER BY external_id`,
        );
        expect(restored.rows).toEqual([
          { external_id: '2', content_fingerprint: 'inbox' },
          { external_id: '4', content_fingerprint: null },
        ]);
      } finally {
        await after.end();
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  test('is idempotent on re-run', async () => {
    await runMigrations();
    const second = await runMigrations();

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATION_FILES);
  });

  test('refuses to run when an applied file checksum changed', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'ohmydate-migrations-'));
    const copyDir = join(tmpRoot, 'migrations');
    try {
      await cp(migrationsDir, copyDir, { recursive: true });
      await runMigrations(schema, copyDir);

      const latest = migrationFilenames(copyDir).at(-1);
      if (latest === undefined) throw new Error('expected at least one migration');
      const migrationFile = join(copyDir, latest);
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
    expect(appliedCounts).toEqual([0, MIGRATION_FILES.length]);
    expect([...new Set(results.flatMap((result) => result.applied))].sort()).toEqual(
      MIGRATION_FILES,
    );

    const client = await connect(schema);
    try {
      const count = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM schema_migrations',
      );
      expect(count.rows[0]?.count).toBe(String(MIGRATION_FILES.length));
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
    const latest = MIGRATION_FILES[MIGRATION_FILES.length - 1];
    if (latest === undefined) throw new Error('expected at least one migration');
    expect(rolledBack).toBe(latest);

    const assertRollbackEffect = async (migration: string) => {
      const client = await connect(schema);
      try {
        if (migration === '0002_inbox_project.sql') {
          const column = await client.query<{ name: string | null }>(
            `SELECT column_name AS name
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'project' AND column_name = 'kind'`,
            [schema],
          );
          expect(column.rows[0]?.name).toBeUndefined();
          const taskColumn = await client.query<{ is_nullable: string }>(
            `SELECT is_nullable
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'task' AND column_name = 'project_id'`,
            [schema],
          );
          expect(taskColumn.rows[0]?.is_nullable).toBe('YES');
          const index = await client.query<{ name: string | null }>(
            `SELECT indexname AS name FROM pg_indexes
              WHERE schemaname = $1 AND indexname = 'project_owner_inbox_unique'`,
            [schema],
          );
          expect(index.rowCount).toBe(0);
        } else if (migration === '0004_inbox_mapping_column.sql') {
          const column = await client.query<{ name: string | null }>(
            `SELECT column_name AS name
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'vikunja_mapping' AND column_name = 'is_inbox'`,
            [schema],
          );
          expect(column.rows[0]?.name).toBeUndefined();
          const index = await client.query<{ name: string | null }>(
            `SELECT indexname AS name FROM pg_indexes
              WHERE schemaname = $1 AND indexname = 'vikunja_mapping_owner_inbox_unique'`,
            [schema],
          );
          expect(index.rowCount).toBe(0);
          const constraint = await client.query<{ name: string | null }>(
            `SELECT c.conname AS name
               FROM pg_constraint AS c
               JOIN pg_class AS t ON t.oid = c.conrelid
               JOIN pg_namespace AS n ON n.oid = t.relnamespace
              WHERE n.nspname = $1 AND t.relname = 'vikunja_mapping'
                AND c.conname = 'vikunja_mapping_inbox_project_only'`,
            [schema],
          );
          expect(constraint.rowCount).toBe(0);
        } else if (migration === '0008_plan_api_persistence.sql') {
          const availabilityColumns = await client.query<{ column_name: string }>(
            `SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'user_availability_version'
                AND column_name IN ('time_zone', 'prefs')
              ORDER BY column_name`,
            [schema],
          );
          expect(availabilityColumns.rows.map((row) => row.column_name)).toEqual([]);
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('user_availability_version')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0011_llm_spend.sql') {
          for (const table of LLM_SPEND_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('agent_run')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0009_today_sessions.sql') {
          for (const table of M4_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('schedule_block')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0010_daily_storage.sql') {
          for (const table of DAILY_STORAGE_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          const columns = await client.query<{ column_name: string }>(
            `SELECT column_name
               FROM information_schema.columns
              WHERE table_schema = $1 AND table_name = 'export_job'
                AND column_name IN ('artifact', 'content_type')
              ORDER BY column_name`,
            [schema],
          );
          expect(columns.rows.map((row) => row.column_name)).toEqual([]);
        } else if (migration === '0007_planning_core.sql') {
          for (const table of PLANNING_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('"user"')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0005_intake_estimation_agent.sql') {
          for (const table of M2_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          // Rolling back only the latest keeps M1 tables applied.
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('"user"')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0006_intake_approval.sql') {
          for (const table of APPROVAL_TABLES) {
            const gone = await client.query<{ name: string | null }>(
              `SELECT to_regclass($1)::text AS name`,
              [table],
            );
            expect({ table, name: gone.rows[0]?.name }).toEqual({ table, name: null });
          }
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('intake_session')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0003_vikunja_durable_stores.sql') {
          const gone = await client.query<{ name: string | null }>(
            `SELECT to_regclass('vikunja_mapping')::text AS name`,
          );
          expect(gone.rows[0]?.name).toBeNull();
          // Rolling back only the latest keeps everything below it applied.
          const stillThere = await client.query<{ name: string | null }>(
            `SELECT to_regclass('"user"')::text AS name`,
          );
          expect(stillThere.rows[0]?.name).not.toBeNull();
        } else if (migration === '0001_init.sql') {
          const gone = await client.query<{ name: string | null }>(
            `SELECT to_regclass('"user"')::text AS name`,
          );
          expect(gone.rows[0]?.name).toBeNull();
        }
      } finally {
        await client.end();
      }
    };

    await assertRollbackEffect(latest);

    for (let index = MIGRATION_FILES.length - 2; index >= 0; index -= 1) {
      const migration = MIGRATION_FILES[index];
      if (migration === undefined) throw new Error('expected migration filename');
      const rolledBackAgain = await rollbackLatest({
        databaseUrl: requireDatabaseUrl(),
        schema,
        migrationsDir,
      });
      expect(rolledBackAgain).toBe(migration);
      await assertRollbackEffect(migration);
    }

    const clientAfterRollback = await connect(schema);
    try {
      const gone = await clientAfterRollback.query<{ name: string | null }>(
        `SELECT to_regclass('"user"')::text AS name`,
      );
      expect(gone.rows[0]?.name).toBeNull();
    } finally {
      await clientAfterRollback.end();
    }

    const reapplied = await runMigrations();
    expect(reapplied.applied).toEqual(MIGRATION_FILES);

    const clientAfter = await connect(schema);
    try {
      const present = await clientAfter.query<{ name: string | null }>(
        `SELECT to_regclass('vikunja_mapping')::text AS name`,
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
      await mkdir(copyDir, { recursive: true });
      await copyFile(join(migrationsDir, '0001_init.sql'), join(copyDir, '0001_init.sql'));
      await copyFile(
        join(migrationsDir, '0001_init.down.sql'),
        join(copyDir, '0001_init.down.sql'),
      );
      await rename(join(copyDir, '0001_init.sql'), join(copyDir, '0002_init.sql'));
      await rename(join(copyDir, '0001_init.down.sql'), join(copyDir, '0002_init.down.sql'));

      const first = await runMigrations(schema, copyDir);
      expect(first.applied).toEqual(migrationFilenames(copyDir));

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
      await writeFile(join(copyDir, '9999_other.sql'), 'SELECT 1;', 'utf8');

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

      const latestFile = MIGRATION_FILES[MIGRATION_FILES.length - 1];
      if (latestFile === undefined) throw new Error('no migrations found');
      const migrationFile = join(copyDir, latestFile);
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
      await writeFile(join(copyDir, '9999_broken.sql'), 'CREATE TABLE broken (', 'utf8');

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
