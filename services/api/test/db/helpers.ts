import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { vi } from 'vitest';

// DB-backed suites migrate schemas and can exceed the 5 s default under load.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const { Client } = pg;

export type PgClient = InstanceType<typeof Client>;

export const databaseUrl = process.env['DATABASE_URL'];

export const hasDatabase = typeof databaseUrl === 'string' && databaseUrl.length > 0;

if (!hasDatabase) {
  console.warn(
    '[db tests] DATABASE_URL is not set; skipping planner schema/migration tests. ' +
      'Run with DATABASE_URL=postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test',
  );
}

export function requireDatabaseUrl(): string {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is not set');
  }
  return databaseUrl;
}

export function makeSchemaName(): string {
  return `t_${randomBytes(8).toString('hex')}`;
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`invalid identifier: ${value}`);
  }
  return `"${value}"`;
}

export async function connect(schema?: string): Promise<PgClient> {
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  if (schema !== undefined) {
    await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  }
  return client;
}

export async function createSchema(schema: string): Promise<void> {
  const client = await connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
  } finally {
    await client.end();
  }
}

export async function dropSchema(schema: string): Promise<void> {
  const client = await connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

export interface PgError extends Error {
  readonly code?: string;
  readonly constraint?: string;
}

export function asPgError(error: unknown): PgError {
  if (!(error instanceof Error)) {
    throw new Error(`expected a PostgreSQL error, got ${String(error)}`);
  }
  return error as PgError;
}

export async function queryFailure(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise;
  } catch (error) {
    return asPgError(error);
  }
  throw new Error('expected the query to fail, but it succeeded');
}
