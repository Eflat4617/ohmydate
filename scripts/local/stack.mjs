#!/usr/bin/env node
// PostgreSQL / Vikunja health, migration-state and owner-row helpers.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { repoRoot, requirePg, STACK_DOWN_MESSAGE } from './common.mjs';

const MIGRATION_PATTERN = /^\d{4}_[A-Za-z0-9_]+\.sql$/u;

export function migrationsDir() {
  return join(repoRoot, 'services/api/migrations');
}

export function localMigrations() {
  return readdirSync(migrationsDir())
    .filter((entry) => MIGRATION_PATTERN.test(entry) && !entry.endsWith('.down.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(migrationsDir(), filename), 'utf8');
      return { filename, sha256: createHash('sha256').update(sql, 'utf8').digest('hex') };
    });
}

export async function waitForPostgres(databaseUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const { Client } = requirePg();
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no connection';
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString: databaseUrl,
      connectionTimeoutMillis: 1_500,
    });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await client.end().catch(() => undefined);
    }
    await delay(250);
  }
  throw new Error(`${STACK_DOWN_MESSAGE} (PostgreSQL: ${lastError})`);
}

export async function waitForVikunja(vikunjaUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const baseUrl = vikunjaUrl.replace(/\/+$/u, '');
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${baseUrl}/api/v1/info`);
      if (response.status === 200) return;
      lastError = `HTTP ${String(response.status)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(250);
  }
  throw new Error(`${STACK_DOWN_MESSAGE} (Vikunja: ${lastError})`);
}

export async function waitForStack(databaseUrl, vikunjaUrl, options = {}) {
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(process.env.OHMYDATE_LOCAL_HEALTH_TIMEOUT_MS ?? '30000', 10);
  await Promise.all([
    waitForPostgres(databaseUrl, { timeoutMs }),
    waitForVikunja(vikunjaUrl, { timeoutMs }),
  ]);
}

export async function checkStack(databaseUrl, vikunjaUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const { Client } = requirePg();
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: timeoutMs,
  });
  let database;
  try {
    await client.connect();
    await client.query('SELECT 1');
    database = true;
  } catch {
    database = false;
  } finally {
    await client.end().catch(() => undefined);
  }
  const baseUrl = vikunjaUrl.replace(/\/+$/u, '');
  let vikunja;
  try {
    const response = await globalThis.fetch(`${baseUrl}/api/v1/info`, {
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
    vikunja = response.status === 200;
  } catch {
    vikunja = false;
  }
  return { database, vikunja, ok: database && vikunja };
}

export async function checkMigrationsCurrent(databaseUrl) {
  const { Client } = requirePg();
  const files = localMigrations();
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 2_000,
  });
  try {
    await client.connect();
    const table = await client.query("SELECT to_regclass('schema_migrations') AS name");
    const name = table.rows[0]?.name;
    if (name === null || name === undefined) {
      return {
        current: false,
        pending: files.map((file) => file.filename),
        detail: 'schema_migrations 테이블이 없습니다.',
      };
    }
    const applied = await client.query(
      'SELECT filename, sha256 FROM schema_migrations ORDER BY filename',
    );
    const appliedByName = new Map(applied.rows.map((row) => [row.filename, row.sha256]));
    const pending = files
      .filter((file) => !appliedByName.has(file.filename))
      .map((file) => file.filename);
    const missing = [...appliedByName.keys()].filter(
      (filename) => !files.some((file) => file.filename === filename),
    );
    const changed = files
      .filter((file) => appliedByName.has(file.filename))
      .filter((file) => appliedByName.get(file.filename) !== file.sha256)
      .map((file) => file.filename);
    const current = pending.length === 0 && missing.length === 0 && changed.length === 0;
    return {
      current,
      pending,
      missing,
      changed,
      detail: current
        ? '모든 마이그레이션이 적용되어 있습니다.'
        : `pending=${pending.join(',') || '없음'} missing=${missing.join(',') || '없음'} changed=${changed.join(',') || '없음'}`,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** Parse the migrate CLI's `Applied migrations: a.sql, b.sql` line. */
export function appliedMigrationFiles(output) {
  const match = /^Applied migrations: (.+)$/mu.exec(output);
  if (match === null || match[1] === undefined) return [];
  return match[1]
    .split(',')
    .map((filename) => filename.trim())
    .filter((filename) => filename.length > 0);
}

export function ensureMigrations(databaseUrl) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(repoRoot, 'services/api/src/db/migrate.ts'), 'up'],
    {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || '').trim();
    throw new Error(`마이그레이션 실행에 실패했습니다: ${message.split(/\r?\n/u).pop() ?? ''}`);
  }
  return result.stdout.trim();
}

export async function findUserByEmail(databaseUrl, email) {
  const { Client } = requirePg();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query('SELECT id, email FROM "user" WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    return result.rows[0] ?? null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function upsertOwnerAccount(databaseUrl, ownerId, vikunjaUserId) {
  const { Client } = requirePg();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO vikunja_owner_account (owner_id, vikunja_user_id, token_secret_ref)
       VALUES ($1, $2, 'default')
       ON CONFLICT (owner_id) DO UPDATE
         SET vikunja_user_id = EXCLUDED.vikunja_user_id,
             token_secret_ref = EXCLUDED.token_secret_ref,
             updated_at = now()`,
      [ownerId, vikunjaUserId],
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function databaseCounts(databaseUrl, email) {
  const { Client } = requirePg();
  const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const users = await client.query('SELECT count(*)::int AS count FROM "user" WHERE email = $1', [
      email.trim().toLowerCase(),
    ]);
    const owners = await client.query(
      `SELECT count(*)::int AS count FROM vikunja_owner_account o
       JOIN "user" u ON u.id = o.owner_id WHERE u.email = $1`,
      [email.trim().toLowerCase()],
    );
    return { users: users.rows[0].count, owners: owners.rows[0].count };
  } finally {
    await client.end().catch(() => undefined);
  }
}
