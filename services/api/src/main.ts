import { randomBytes } from 'node:crypto';
import { createUuidV7Generator, epochMsToInstant } from '@ohmydate/domain';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildApp } from './app.js';
import { configFromEnv, type AppConfig } from './config.js';
import type { Database } from './db/types.js';

const { Pool } = pg;

function parseTrustProxy(raw: string | undefined): AppConfig['trustProxy'] {
  if (raw === undefined || raw.length === 0) return false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (raw.includes(',')) {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return raw;
}

function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? '3000', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

async function main(): Promise<void> {
  const env = process.env;
  const baseConfig = configFromEnv(env);
  const databaseUrl = baseConfig.databaseUrl;
  if (databaseUrl === null || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL is required');
  }

  const config: AppConfig = {
    ...baseConfig,
    trustProxy: parseTrustProxy(env['TRUST_PROXY']),
    logLevel: env['LOG_LEVEL'] ?? baseConfig.logLevel,
  };
  const host = env['HOST'] ?? '127.0.0.1';
  const port = parsePort(env['PORT']);

  const clock = { now: () => epochMsToInstant(Date.now()) };
  const ids = createUuidV7Generator({ rand: (length) => randomBytes(length), clock });
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl }) }),
  });

  const app = await buildApp({ config, clock, ids, db });

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
    } finally {
      await db.destroy();
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal)
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          app.log.error({ err: error }, 'graceful shutdown failed');
          process.exit(1);
        });
    });
  }

  try {
    await app.listen({ host, port });
  } catch (error) {
    await db.destroy();
    throw error;
  }
  process.stdout.write(`OhMyDate API listening on http://${host}:${port}\n`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`OhMyDate API failed to start: ${message}\n`);
  process.exit(1);
}
