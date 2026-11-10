import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

/**
 * Advisory lock key for the migration runner. It is intentionally global per
 * database so that two concurrent runners never apply the same migration twice.
 */
const MIGRATION_LOCK_CLASS = 5_196_100;
const MIGRATION_LOCK_OBJECT = 1;

const MIGRATION_FILE_PATTERN = /^\d{4}_[A-Za-z0-9_]+\.sql$/;

export interface MigrateOptions {
  readonly databaseUrl: string;
  /** Directory containing NNNN_name.sql files. Defaults to services/api/migrations. */
  readonly migrationsDir?: string | undefined;
  /** Optional PostgreSQL schema; used by tests to isolate each run (t_<random>). */
  readonly schema?: string | undefined;
}

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

interface MigrationFile {
  readonly filename: string;
  readonly sql: string;
  readonly sha256: string;
  readonly downFilename: string;
  readonly downSql: string | null;
  readonly downSha256: string | null;
}

interface AppliedMigration {
  readonly filename: string;
  readonly sha256: string;
  readonly down_sha256: string | null;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export class MigrationChecksumMismatchError extends MigrationError {
  readonly filename: string;
  readonly recordedSha256: string;
  readonly actualSha256: string;

  constructor(filename: string, recordedSha256: string, actualSha256: string) {
    super(
      `migration ${filename} checksum mismatch: applied ${recordedSha256}, file ${actualSha256}. ` +
        'Applied migrations are immutable; add a new migration instead.',
    );
    this.name = 'MigrationChecksumMismatchError';
    this.filename = filename;
    this.recordedSha256 = recordedSha256;
    this.actualSha256 = actualSha256;
  }
}

export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new MigrationError(`invalid PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

async function loadMigrations(migrationsDir: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const filenames = entries
    .filter((entry) => MIGRATION_FILE_PATTERN.test(entry) && !entry.endsWith('.down.sql'))
    .sort();

  if (filenames.length === 0) {
    throw new MigrationError(`no migration files found in ${migrationsDir}`);
  }

  return Promise.all(
    filenames.map(async (filename) => {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex');
      const downFilename = filename.replace(/\.sql$/, '.down.sql');
      let downSql: string | null;
      try {
        downSql = await readFile(join(migrationsDir, downFilename), 'utf8');
      } catch {
        downSql = null;
      }
      const downSha256 =
        downSql === null ? null : createHash('sha256').update(downSql, 'utf8').digest('hex');
      return { filename, sql, sha256, downFilename, downSql, downSha256 };
    }),
  );
}

function migrationNumber(filename: string): number {
  return Number.parseInt(filename.slice(0, 4), 10);
}

async function prepareSession(
  client: InstanceType<typeof Client>,
  schema: string | undefined,
): Promise<void> {
  if (schema === undefined) return;
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
}

async function ensureSchemaMigrations(client: InstanceType<typeof Client>): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       sha256 text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS down_sha256 text');
}

/**
 * Applies every pending migration exactly once inside a single transaction
 * guarded by pg_advisory_xact_lock. Refuses to run when an already applied
 * file's sha256 no longer matches the recorded checksum.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const files = await loadMigrations(migrationsDir);
  const client = new Client({ connectionString: options.databaseUrl });

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MIGRATION_LOCK_CLASS,
        MIGRATION_LOCK_OBJECT,
      ]);
      await prepareSession(client, options.schema);
      await ensureSchemaMigrations(client);

      const appliedResult = await client.query<AppliedMigration>(
        'SELECT filename, sha256, down_sha256 FROM schema_migrations ORDER BY filename',
      );
      const applied = new Map(appliedResult.rows.map((row) => [row.filename, row]));
      const filesByName = new Map(files.map((file) => [file.filename, file]));

      for (const row of appliedResult.rows) {
        const file = filesByName.get(row.filename);
        if (file === undefined) {
          throw new MigrationError(
            `applied migration ${row.filename} is missing from ${migrationsDir}; ` +
              'restore the file or add a new forward migration.',
          );
        }
        if (file.sha256 !== row.sha256) {
          throw new MigrationChecksumMismatchError(row.filename, row.sha256, file.sha256);
        }
        if (file.downSha256 !== row.down_sha256) {
          throw new MigrationChecksumMismatchError(
            file.downFilename,
            row.down_sha256 ?? '<missing>',
            file.downSha256 ?? '<missing>',
          );
        }
      }

      const highestApplied = Math.max(0, ...appliedResult.rows.map((row) => migrationNumber(row.filename)));
      for (const file of files) {
        if (!applied.has(file.filename) && migrationNumber(file.filename) < highestApplied) {
          throw new MigrationError(
            `migration ${file.filename} is numbered below already applied ${highestApplied}; ` +
              'migrations must be appended, not inserted.',
          );
        }
      }

      const appliedNow: string[] = [];
      const skipped: string[] = [];

      for (const file of files) {
        if (applied.has(file.filename)) {
          skipped.push(file.filename);
          continue;
        }
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, sha256, down_sha256) VALUES ($1, $2, $3)',
          [file.filename, file.sha256, file.downSha256],
        );
        appliedNow.push(file.filename);
      }

      await client.query('COMMIT');
      return { applied: appliedNow, skipped };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

/**
 * Rolls back the most recently applied migration using its sibling
 * NNNN_name.down.sql file, then removes its schema_migrations row.
 * Returns the rolled-back filename, or null when nothing was applied.
 */
export async function rollbackLatest(options: MigrateOptions): Promise<string | null> {
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const files = await loadMigrations(migrationsDir);
  const filesByName = new Map(files.map((file) => [file.filename, file]));
  const client = new Client({ connectionString: options.databaseUrl });

  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT pg_advisory_xact_lock($1, $2)', [
        MIGRATION_LOCK_CLASS,
        MIGRATION_LOCK_OBJECT,
      ]);
      await prepareSession(client, options.schema);
      await ensureSchemaMigrations(client);

      const latestResult = await client.query<AppliedMigration>(
        'SELECT filename, sha256, down_sha256 FROM schema_migrations ORDER BY filename DESC LIMIT 1',
      );
      const latest = latestResult.rows[0];
      if (latest === undefined) {
        await client.query('COMMIT');
        return null;
      }

      const file = filesByName.get(latest.filename);
      if (file === undefined) {
        throw new MigrationError(
          `applied migration ${latest.filename} is missing from ${migrationsDir}`,
        );
      }
      if (file.sha256 !== latest.sha256) {
        throw new MigrationChecksumMismatchError(latest.filename, latest.sha256, file.sha256);
      }
      if (file.downSha256 !== latest.down_sha256) {
        throw new MigrationChecksumMismatchError(
          file.downFilename,
          latest.down_sha256 ?? '<missing>',
          file.downSha256 ?? '<missing>',
        );
      }
      if (file.downSql === null) {
        throw new MigrationError(
          `rollback file ${file.downFilename} is missing for applied migration ${latest.filename}`,
        );
      }

      await client.query(file.downSql);
      await client.query('DELETE FROM schema_migrations WHERE filename = $1', [latest.filename]);
      await client.query('COMMIT');
      return latest.filename;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === fileURLToPath(import.meta.url);
}

async function runCli(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new MigrationError('DATABASE_URL is required to run migrations');
  }

  const options: MigrateOptions = { databaseUrl };
  const command = process.argv[2] ?? 'up';

  if (command === 'up') {
    const result = await migrate(options);
    if (result.applied.length === 0) {
      console.log(`No pending migrations (${result.skipped.length} already applied).`);
    } else {
      console.log(`Applied migrations: ${result.applied.join(', ')}`);
    }
    return;
  }

  if (command === 'down') {
    const rolledBack = await rollbackLatest(options);
    console.log(rolledBack === null ? 'Nothing to roll back.' : `Rolled back ${rolledBack}`);
    return;
  }

  throw new MigrationError(`unknown command ${command}; expected "up" or "down"`);
}

if (isEntryPoint()) {
  try {
    await runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
