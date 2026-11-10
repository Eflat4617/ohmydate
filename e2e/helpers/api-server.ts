import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

interface KyselyLike {
  destroy(): Promise<void>;
}

interface KyselyConstructor {
  new (options: unknown): KyselyLike;
}

interface PostgresDialectConstructor {
  new (options: { pool: unknown }): unknown;
}

interface PoolConstructor {
  new (options: { connectionString: string }): unknown;
}

const require = createRequire(new URL('../../services/api/package.json', import.meta.url));
const { Kysely, PostgresDialect } = require('kysely') as {
  Kysely: KyselyConstructor;
  PostgresDialect: PostgresDialectConstructor;
};
const pg = require('pg') as { Pool: PoolConstructor };

const { buildApp, createConfig } = await import('../../services/api/src/index.ts');

const databaseUrl = process.env['DATABASE_URL'];
const vikunjaUrl = process.env['VIKUNJA_URL'];
const port = Number.parseInt(process.env['PORT'] ?? '0', 10);
if (databaseUrl === undefined || databaseUrl === '') {
  throw new Error('DATABASE_URL is required');
}
if (vikunjaUrl === undefined || vikunjaUrl === '') {
  throw new Error('VIKUNJA_URL is required');
}
if (!Number.isInteger(port) || port < 0) {
  throw new Error('PORT must be a non-negative integer');
}


function uuidv7(): string {
  const now = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

const clock = {
  now: () => new Date().toISOString(),
};
const ids = {
  next: () => uuidv7(),
};

const db = new Kysely({
  dialect: new PostgresDialect({
    pool: new pg.Pool({ connectionString: databaseUrl }),
  }),
});

const config = createConfig({
  provider: 'vikunja',
  vikunjaUrl,
  cookieSecure: false,
  reconcileIntervalMs: 0,
  logLevel: process.env['LOG_LEVEL'] ?? 'warn',
});

const app = await buildApp({
  config,
  clock: clock as never,
  ids: ids as never,
  db: db as never,
});

let closing = false;

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
  } finally {
    await db.destroy();
    process.exit(0);
  }
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`OhMyDate API listening on http://127.0.0.1:${port}\n`);
