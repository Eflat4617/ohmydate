import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createUuidV7Generator, epochMsToInstant } from '@ohmydate/domain';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildApp } from './app.js';
import { configFromEnv, type AppConfig } from './config.js';
import type { Database } from './db/types.js';

const { Pool } = pg;

/**
 * A connection attempt to a black-holed database must fail instead of hanging
 * forever. /readyz has its own shorter deadline; this bound protects the rest
 * of the API's queries (FU-30R finding).
 */
export const POOL_CONNECTION_TIMEOUT_MS = 5_000;

/**
 * An abandoned query (for example /readyz racing its own deadline) must not
 * pin its pooled client forever. Both bounds are configurable because a
 * report export may legitimately run longer than a health probe.
 */
export const DEFAULT_PG_STATEMENT_TIMEOUT_MS = 10_000;
export const DEFAULT_PG_QUERY_TIMEOUT_MS = 10_000;
export const PG_STATEMENT_TIMEOUT_ENV = 'PG_STATEMENT_TIMEOUT_MS';
export const PG_QUERY_TIMEOUT_ENV = 'PG_QUERY_TIMEOUT_MS';

/** Hard stop for graceful shutdown. Exceeding it exits non-zero. */
export const SHUTDOWN_DEADLINE_MS = 15_000;

export function parseTrustProxy(raw: string | undefined): AppConfig['trustProxy'] {
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

export function parsePort(raw: string | undefined): number {
  const port = Number.parseInt(raw ?? '3000', 10);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('PORT must be an integer between 0 and 65535');
  }
  return port;
}

function parsePositiveTimeout(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function pgTimeouts(env: NodeJS.ProcessEnv = process.env): {
  readonly statementTimeoutMs: number;
  readonly queryTimeoutMs: number;
} {
  return {
    statementTimeoutMs: parsePositiveTimeout(
      env[PG_STATEMENT_TIMEOUT_ENV],
      PG_STATEMENT_TIMEOUT_ENV,
      DEFAULT_PG_STATEMENT_TIMEOUT_MS,
    ),
    queryTimeoutMs: parsePositiveTimeout(
      env[PG_QUERY_TIMEOUT_ENV],
      PG_QUERY_TIMEOUT_ENV,
      DEFAULT_PG_QUERY_TIMEOUT_MS,
    ),
  };
}

export function createDatabasePool(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): pg.Pool {
  const { statementTimeoutMs, queryTimeoutMs } = pgTimeouts(env);
  return new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    statement_timeout: statementTimeoutMs,
    query_timeout: queryTimeoutMs,
  });
}

export interface PgClientErrorDetails {
  readonly code: string | undefined;
  readonly message: string;
}

/**
 * Structured logs must never carry SQL text or parameters. pg's errors do not
 * normally include either, but only the code and message are copied so an
 * adapter cannot leak extra context by attaching it to the error object.
 */
export function pgClientErrorDetails(error: Error): PgClientErrorDetails {
  const code = (error as { code?: unknown }).code;
  return {
    code: typeof code === 'string' ? code : undefined,
    message: error.message,
  };
}

/**
 * PostgreSQL emits `error` on the pool when it terminates an idle backend
 * (database restart, failover, idle_session_timeout). Without a listener that
 * event is unhandled and kills the process (FU-30R [MEDIUM]).
 *
 * pg-pool only keeps its own `error` listener on idle clients: `_acquireClient`
 * removes it while a client is checked out. A checked-out socket that dies
 * without a PostgreSQL FATAL (failover, reset, frozen network path) therefore
 * has no listener and crashes the process (FU-35R finding 1). A `connect`
 * listener stays attached for the client's whole life, checkout included.
 */
export function attachPoolErrorHandler(pool: pg.Pool, onError: (error: Error) => void): void {
  pool.on('error', onError);
  pool.on('connect', (client) => {
    client.on('error', onError);
  });
}

export interface ShutdownLogger {
  info(details: Readonly<Record<string, unknown>>, message: string): void;
  error(details: Readonly<Record<string, unknown>>, message: string): void;
}

export interface ShutdownControllerOptions {
  readonly logger: ShutdownLogger;
  readonly close: () => Promise<void>;
  readonly destroy: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly deadlineMs?: number;
}

export type ShutdownController = (signal: NodeJS.Signals) => void;

/**
 * Builds the signal handler used by the production entry point.
 *
 * - The first SIGTERM/SIGINT starts a single graceful close.
 * - Repeated signals during close are ignored; they must not abort in-flight
 *   requests (FU-30R [LOW]).
 * - If close does not settle before the deadline the process exits 1.
 * - Close/destroy failures also exit 1.
 */
export function createShutdownController(options: ShutdownControllerOptions): ShutdownController {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let closing = false;

  return (signal) => {
    if (closing) {
      options.logger.info({ signal }, 'shutdown already in progress; ignoring signal');
      return;
    }
    closing = true;
    options.logger.info({ signal, deadlineMs }, 'shutting down');

    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.exit(code);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      options.logger.error({ signal, deadlineMs }, 'graceful shutdown timed out');
      finish(1);
    }, deadlineMs);

    void (async () => {
      let failed = false;
      try {
        await options.close();
      } catch (error) {
        failed = true;
        options.logger.error({ err: error }, 'graceful shutdown failed');
      }
      try {
        await options.destroy();
      } catch (error) {
        failed = true;
        options.logger.error({ err: error }, 'database shutdown failed');
      }
      finish(failed ? 1 : 0);
    })();
  };
}

/**
 * `node dist/main` and a symlinked release directory (`/app/current`) must
 * boot too, not exit 0 silently. Node sets argv[1] to the literal path given,
 * so resolve both it (plus Node's implicit `.js` extension) and this module
 * through realpath before comparing (FU-35R finding 2).
 */
export function isDirectEntrypoint(
  entry: string | undefined = process.argv[1],
  moduleUrl: string = import.meta.url,
  realpath: (path: string) => string = realpathSync,
): boolean {
  if (entry === undefined) return false;
  const modulePath = realpathIdentity(realpath, fileURLToPath(moduleUrl));
  if (modulePath === null) return false;
  for (const candidate of [entry, `${entry}.js`]) {
    const resolved = realpathIdentity(realpath, candidate);
    if (resolved !== null && resolved === modulePath) return true;
  }
  return false;
}

function realpathIdentity(realpath: (path: string) => string, path: string): string | null {
  try {
    return realpath(path);
  } catch {
    return null;
  }
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
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
  const pool = createDatabasePool(databaseUrl);
  const db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  const poolErrorReport: { report: (error: Error) => void } = {
    report: (error) => {
      const { code, message } = pgClientErrorDetails(error);
      process.stderr.write(`pg client error: ${code ?? 'no-code'} ${message}\n`);
    },
  };
  attachPoolErrorHandler(pool, (error) => poolErrorReport.report(error));

  const app: FastifyInstance = await buildApp({ config, clock, ids, db });
  poolErrorReport.report = (error) =>
    app.log.warn(pgClientErrorDetails(error), 'pg client error');

  const shutdown = createShutdownController({
    logger: {
      info: (details, message) => app.log.info(details, message),
      error: (details, message) => app.log.error(details, message),
    },
    close: () => app.close(),
    destroy: () => db.destroy(),
    exit: (code) => process.exit(code),
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => shutdown(signal));
  }

  try {
    await app.listen({ host, port });
  } catch (error) {
    await db.destroy();
    throw error;
  }
  process.stdout.write(`OhMyDate API listening on http://${host}:${port}\n`);
}

if (isDirectEntrypoint()) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`OhMyDate API failed to start: ${message}\n`);
    process.exit(1);
  }
}
