import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createUuidV7Generator, epochMsToInstant } from '@ohmydate/domain';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildApp } from './app.js';
import {
  UNMATCHED_ROUTE,
  shutdownControllerFor,
  shutdownRequestMeta,
  waitForRequestSettlement,
} from './http/shutdown-context.js';
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

/**
 * Valid in-flight handlers get this long to finish after the first signal.
 * It is above the 11 s regression floor and below SHUTDOWN_DEADLINE_MS, so a
 * trickling or idle socket can be force-closed while the process still exits
 * 0 (FU-37R finding 2). Providers must still bound their own retries; the
 * drain budget is not the provider timeout budget.
 */
export const SHUTDOWN_DRAIN_BUDGET_MS = 12_000;

/**
 * After the drain budget expires and the application signal aborts provider
 * work, handlers get this long to finish bounded recovery (needs_reconcile
 * marking, idempotency release) before the database is destroyed. The
 * drain + cleanup budgets stay below SHUTDOWN_DEADLINE_MS.
 */
export const DEFAULT_SHUTDOWN_CLEANUP_BUDGET_MS = 2_000;
export const SHUTDOWN_CLEANUP_BUDGET_ENV = 'SHUTDOWN_CLEANUP_BUDGET_MS';

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

export function shutdownCleanupBudgetMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveTimeout(
    env[SHUTDOWN_CLEANUP_BUDGET_ENV],
    SHUTDOWN_CLEANUP_BUDGET_ENV,
    DEFAULT_SHUTDOWN_CLEANUP_BUDGET_MS,
  );
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

const TIMED_OUT_QUERY = Symbol('ohmydate.timedOutQuery');
const QUERY_WRAPPED = Symbol('ohmydate.queryWrapped');

type QueryCallback = (error: Error | null | undefined, result: unknown) => void;
type QueryFunction = (...args: unknown[]) => unknown;
type PoolConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

interface TrackedClient extends pg.PoolClient {
  [TIMED_OUT_QUERY]?: boolean;
  [QUERY_WRAPPED]?: boolean;
}

function isQueryReadTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'Query read timeout';
}

/**
 * pg's client-side `query_timeout` rejects the pending callback but leaves the
 * non-pipelined query on the wire: `readyForQuery` stays false and the active
 * query is still set (pg/lib/client.js). Kysely then releases the client with
 * `release(false)`, so pg-pool returns the blocked connection to the idle list
 * and every later query reuses it (FU-37R finding 1).
 *
 * Mark the client when its own deadline expires. The release wrapper below
 * then discards it instead of returning it to the pool.
 */
function instrumentClientQueryTimeout(client: pg.PoolClient): pg.PoolClient {
  const tracked = client as TrackedClient;
  if (tracked[QUERY_WRAPPED] !== true) {
    tracked[QUERY_WRAPPED] = true;
    const originalQuery = client.query.bind(client) as unknown as QueryFunction;
    client.query = ((...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === 'function') {
        const callback = last as QueryCallback;
        args[args.length - 1] = (error: Error | null | undefined, result: unknown) => {
          if (isQueryReadTimeout(error)) tracked[TIMED_OUT_QUERY] = true;
          callback(error, result);
        };
        return originalQuery(...args);
      }
      return new Promise((resolve, reject) => {
        originalQuery(...args, (error: Error | null | undefined, result: unknown) => {
          if (isQueryReadTimeout(error)) tracked[TIMED_OUT_QUERY] = true;
          if (error !== undefined && error !== null) reject(error);
          else resolve(result);
        });
      });
    }) as unknown as pg.PoolClient['query'];
  }

  // pg-pool assigns a fresh `release` on every acquire; wrap that one so a
  // timed-out checkout is removed. Passing a truthy error makes pg-pool call
  // client.end(), which destroys the socket while a hung query is active.
  const originalRelease = client.release.bind(client);
  client.release = (err?: Error | boolean) => {
    if (tracked[TIMED_OUT_QUERY] === true) {
      originalRelease(
        err === true
          ? true
          : new Error('discarding client after a client-side query timeout'),
      );
      return;
    }
    originalRelease(err);
  };
  return client;
}

/**
 * pg.Pool that instruments every checkout. The wrapper is what Kysely sees, so
 * `connect()` returns a client whose `release(false)` still destroys a client
 * whose client-side query deadline expired.
 */
class ManagedPool extends Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: PoolConnectCallback): void;
  override connect(callback?: PoolConnectCallback): Promise<pg.PoolClient> | void {
    if (callback === undefined) {
      return super.connect().then((client) => instrumentClientQueryTimeout(client));
    }
    super.connect((error, client, done) => {
      if (error !== undefined || client === undefined) {
        callback(error, client, done);
        return;
      }
      const instrumented = instrumentClientQueryTimeout(client);
      callback(undefined, instrumented, (release?: unknown) =>
        instrumented.release(release as Error | boolean | undefined),
      );
    });
  }
}

export function createDatabasePool(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): pg.Pool {
  const { statementTimeoutMs, queryTimeoutMs } = pgTimeouts(env);
  return new ManagedPool({
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
 * Graceful close that decides per socket, not per request:
 * - connections that never became a request (incomplete headers) and idle
 *   keep-alive sockets are dropped immediately;
 * - a socket that only carries incomplete requests is dropped immediately,
 *   because no handler can start without a complete body;
 * - a socket that still carries a complete request whose response is pending
 *   is preserved until that response finishes, then closed so later incomplete
 *   pipelined requests are dropped;
 * - at the drain budget the app signal is aborted (provider retries stop) and
 *   any still-pending request is force-closed and logged once with its
 *   registered route template, request id and method, never its body or raw
 *   target;
 * - the database is released only after aborted handlers settle, bounded by
 *   the cleanup budget.
 *
 * `server.close()` disables Node's periodic requestTimeout check, so an
 * incomplete request would otherwise keep the server open forever
 * (FU-37R finding 2). The old per-request sweep also destroyed a valid
 * handler's socket when a later pipelined request was incomplete (FU-37R2).
 */
export function createApplicationClose(
  app: FastifyInstance,
  drainMs: number = SHUTDOWN_DRAIN_BUDGET_MS,
  cleanupMs: number = shutdownCleanupBudgetMs(),
): () => Promise<void> {
  const sockets = new Set<Socket>();
  const pending = new Map<IncomingMessage, ServerResponse>();
  let closing = false;

  const hasCompletePending = (socket: Socket): boolean => {
    for (const request of pending.keys()) {
      if (request.socket === socket && request.complete === true) return true;
    }
    return false;
  };

  const destroyWhenDrained = (socket: Socket): void => {
    if (!closing || !sockets.has(socket)) return;
    if (hasCompletePending(socket)) return;
    destroySocket(socket);
  };

  app.server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  app.server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    pending.set(request, response);
    const settled = (): void => {
      if (pending.get(request) !== response) return;
      pending.delete(request);
      destroyWhenDrained(request.socket);
    };
    // `finish` means the response bytes reached the socket even on a keep-alive
    // connection; `close` is the fallback for an aborted response.
    response.once('finish', settled);
    response.once('close', settled);
  });

  return async () => {
    closing = true;
    app.server.closeIdleConnections();
    // Drop only sockets with no complete request left to answer.
    for (const socket of [...sockets]) {
      if (!hasCompletePending(socket)) destroySocket(socket);
    }

    const force = setTimeout(() => {
      // Drain budget expired: stop provider retries and in-flight fetches.
      shutdownControllerFor(app)?.abort();
      for (const request of [...pending.keys()]) {
        const meta = shutdownRequestMeta(request);
        app.log.warn(
          {
            route: meta?.route ?? UNMATCHED_ROUTE,
            reqId: meta?.reqId ?? '',
            method: meta?.method ?? request.method ?? '',
          },
          'forced shutdown closure',
        );
      }
      app.server.closeAllConnections();
    }, drainMs);
    try {
      await app.close();
    } finally {
      clearTimeout(force);
    }
    // Sockets may be closed, but aborted handlers still own bounded recovery
    // writes and idempotency release. Do not let db.destroy() overtake them.
    await waitForRequestSettlement(app, cleanupMs);
  };
}

/**
 * Give a completed response its chance to leave the kernel buffer before the
 * socket is torn down (the client may still be mid-body on a pipelined
 * request, so a plain end() would wait for its FIN forever).
 */
function destroySocket(socket: Socket): void {
  if (socket.destroyed) return;
  const closeSoon = (socket as Socket & { destroySoon?: () => void }).destroySoon;
  if (typeof closeSoon === 'function') closeSoon.call(socket);
  else socket.destroy();
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
    close: createApplicationClose(app),
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
