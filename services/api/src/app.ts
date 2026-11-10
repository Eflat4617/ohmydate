import cookie from '@fastify/cookie';
import { createServer as createHttpServer } from 'node:http';
import { registerIanaTimeZoneFormat } from '@ohmydate/contracts';
import { DomainError, type Clock, type IdGenerator } from '@ohmydate/domain';
import { BudgetGuard, FakeLlm, type LlmPort } from '@ohmydate/llm';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { AppConfig } from './config.js';
import type { AppRepositories, IdempotencyStore } from './application/ports.js';
import { AuthService } from './application/auth-service.js';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher.js';
import { InMemoryLoginRateLimiter } from './adapters/in-memory-login-rate-limiter.js';
import { InMemorySessionStore } from './adapters/in-memory-session-store.js';
import { PgIdempotencyStore } from './adapters/pg-idempotency-store.js';
import { PgUserRepository } from './adapters/pg-user-repository.js';
import { IntakeError } from './application/intake/intake-error.js';
import { createVikunjaRepositories } from './adapters/vikunja/composition.js';
import { listReconcilerOwnerIds } from './adapters/vikunja/owner-accounts.js';
import {
  createPgSessionLeaderLock,
  VikunjaReconciler,
} from './adapters/vikunja/reconciler.js';
import type { Database } from './db/types.js';
import {
  ProblemError,
  domainErrorToProblem,
  sendProblem,
  sendValidationProblem,
  type FastifyValidationError,
} from './http/problem.js';
import { createRuntime, registerRoutes } from './http/routes.js';
import './http/fastify-augment.js';

export type LoggerOption = NonNullable<FastifyServerOptions['logger']>;
export type LoggerInstanceOption = NonNullable<FastifyServerOptions['loggerInstance']>;

/** 08 §1: planner API base path, independent of the Vikunja API version. */
export const API_PREFIX = '/api/v1' as const;

export interface BuildAppOptions {
  readonly config: AppConfig;
  /**
   * Repository composition. Optional for `provider=vikunja`, where the
   * composition root builds the Vikunja adapter with durable PG stores.
   * `provider=memory` keeps the existing injected in-memory repositories.
   */
  readonly repos?: AppRepositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly db: Kysely<Database>;
  /** Test override; production uses the structured pino defaults below. */
  readonly logger?: LoggerOption;
  /**
   * Test-only override for capturing logs with a pre-built pino instance.
   * It bypasses `defaultLoggerOptions`, so redaction and serializers are not
   * applied; never pass a caller-supplied instance in production.
   */
  readonly loggerInstance?: LoggerInstanceOption;
  /** Test override for forcing idempotency-store failures. */
  readonly idempotency?: IdempotencyStore;
  /**
   * Injected LLM adapter. Default composition uses FakeLlm only when
   * `LLM_PROVIDER=fake`; otherwise no provider is wired (GB-1 pending).
   */
  readonly llm?: LlmPort;
  /** Test override for the fail-closed budget guard. */
  readonly budgetGuard?: BudgetGuard;
  /**
   * Test override for the reconciler's advisory-lock key. Production uses the
   * stable VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY; a distinct key lets parallel
   * test workers avoid contending on the shared planner database.
   */
  readonly reconcileLockKey?: number;
}

/**
 * 09 §7: structured JSON logs with request IDs. Bodies, cookies and auth
 * headers are never logged; /auth/* bodies are redacted by path as a belt and
 * braces measure on top of the request serializer.
 */
export function defaultLoggerOptions(config: AppConfig): LoggerOption {
  return {
    level: config.logLevel,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'req.headers["set-cookie"]',
        'res.headers["set-cookie"]',
        'req.body.password',
        'req.body.csrf',
        'req.body.cookie',
        'password',
        'token',
      ],
      censor: '[REDACTED]',
    },
    serializers: {
      req(request: { method?: string; url?: string; id?: string }) {
        return { method: request.method ?? '', url: request.url ?? '', id: request.id ?? '' };
      },
      res(reply: { statusCode?: number }) {
        return { statusCode: reply.statusCode ?? 0 };
      },
    },
  } as unknown as LoggerOption;
}

/** /readyz must never hang on a database that accepts TCP but never answers. */
export const READYZ_DB_TIMEOUT_MS = 2_500;

/**
 * Slow/incomplete request protection uses Node's receive limits, not the
 * socket inactivity timeout: a valid handler may legitimately wait >10 s for
 * provider retries (three 10 s Vikunja GET attempts plus margin), and the
 * inactivity timer would kill it mid-handler (FU-37R finding 3).
 *
 * - `requestTimeout` bounds receiving the whole request (default 10 s).
 * - `headersTimeout` bounds receiving the headers (default 10 s).
 * - `connectionTimeout` is only the socket inactivity guard for the worst-case
 *   provider budget above; it must stay well above 30 s (default 60 s).
 * - `connectionsCheckingInterval` makes the receive limits fire promptly
 *   instead of Node's 30 s default.
 */
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_CONNECTION_TIMEOUT_MS = 60_000;
export const DEFAULT_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;
export const HTTP_REQUEST_TIMEOUT_ENV = 'HTTP_REQUEST_TIMEOUT_MS';
export const HTTP_HEADERS_TIMEOUT_ENV = 'HTTP_HEADERS_TIMEOUT_MS';
export const HTTP_CONNECTION_TIMEOUT_ENV = 'HTTP_CONNECTION_TIMEOUT_MS';
export const HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV =
  'HTTP_CONNECTIONS_CHECKING_INTERVAL_MS';

function parseHttpTimeout(
  raw: string | undefined,
  name: string,
  fallback: number,
): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export interface HttpTimeouts {
  readonly requestTimeoutMs: number;
  readonly headersTimeoutMs: number;
  readonly connectionTimeoutMs: number;
  readonly connectionsCheckingIntervalMs: number;
}

export function httpTimeouts(env: NodeJS.ProcessEnv = process.env): HttpTimeouts {
  const timeouts: HttpTimeouts = {
    requestTimeoutMs: parseHttpTimeout(
      env[HTTP_REQUEST_TIMEOUT_ENV],
      HTTP_REQUEST_TIMEOUT_ENV,
      DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
    ),
    headersTimeoutMs: parseHttpTimeout(
      env[HTTP_HEADERS_TIMEOUT_ENV],
      HTTP_HEADERS_TIMEOUT_ENV,
      DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
    ),
    connectionTimeoutMs: parseHttpTimeout(
      env[HTTP_CONNECTION_TIMEOUT_ENV],
      HTTP_CONNECTION_TIMEOUT_ENV,
      DEFAULT_HTTP_CONNECTION_TIMEOUT_MS,
    ),
    connectionsCheckingIntervalMs: parseHttpTimeout(
      env[HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV],
      HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV,
      DEFAULT_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS,
    ),
  };
  if (timeouts.headersTimeoutMs > timeouts.requestTimeoutMs) {
    throw new Error(
      `${HTTP_HEADERS_TIMEOUT_ENV} must be <= ${HTTP_REQUEST_TIMEOUT_ENV}`,
    );
  }
  return timeouts;
}

async function databaseReady(
  db: Kysely<Database>,
  timeoutMs: number = READYZ_DB_TIMEOUT_MS,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<boolean>((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), timeoutMs);
    });
    return await Promise.race([sql`select 1`.execute(db).then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 09 §7: readiness includes Vikunja when it is the repository provider. The
 * info endpoint is Vikunja's own v1 health surface, not the planner prefix.
 */
async function vikunjaReady(config: AppConfig): Promise<'ok' | 'failed' | 'skipped'> {
  if (config.provider !== 'vikunja') return 'skipped';
  if (config.vikunjaUrl === null || config.vikunjaUrl.length === 0) return 'failed';
  const baseUrl = config.vikunjaUrl.replace(/\/+$/, '');
  try {
    const response = await fetch(`${baseUrl}/api/v1/info`, {
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

function registerHealthRoutes(
  app: FastifyInstance,
  config: AppConfig,
  db: Kysely<Database>,
): void {
  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    const [database, vikunja] = await Promise.all([databaseReady(db), vikunjaReady(config)]);
    const ready = database && vikunja !== 'failed';
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'unavailable',
      checks: {
        database: database ? 'ok' : 'failed',
        vikunja,
      },
    });
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, clock, ids, db } = options;
  const logging =
    options.loggerInstance === undefined
      ? { logger: options.logger ?? defaultLoggerOptions(config) }
      : { loggerInstance: options.loggerInstance };
  const {
    requestTimeoutMs,
    headersTimeoutMs,
    connectionTimeoutMs,
    connectionsCheckingIntervalMs,
  } = httpTimeouts();
  const app = Fastify({
    ...logging,
    // Fastify does not surface headersTimeout or connectionsCheckingInterval,
    // and requestTimeout is only enforced when the connection checker runs.
    // Build the HTTP server with the receive limits so a trickling body is
    // cut promptly even while shutting down (FU-37R finding 2).
    serverFactory: (handler) =>
      createHttpServer(
        {
          requestTimeout: requestTimeoutMs,
          headersTimeout: headersTimeoutMs,
          connectionsCheckingInterval: connectionsCheckingIntervalMs,
        },
        handler,
      ),
    trustProxy: config.trustProxy as NonNullable<FastifyServerOptions['trustProxy']>,
    ajv: {
      plugins: [
        (ajv) => {
          registerIanaTimeZoneFormat(ajv as never);
          return ajv;
        },
      ],
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: true,
        allErrors: true,
        addUsedSchema: false,
      },
    },
  });

  // `serverFactory` bypasses Fastify's connectionTimeout mapping; set the
  // socket inactivity guard explicitly. It only covers a dead peer and must
  // stay above the worst-case provider budget, not valid handler latency.
  app.server.timeout = connectionTimeoutMs;

  app.decorateRequest('authSession', null);
  await app.register(cookie);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-trace-id', String(request.id));
    return payload;
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, 404, 'not_found', 'Not found', 'no route matches this request'),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ProblemError) {
      if (error.headers !== undefined) {
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      }
      return sendProblem(
        request,
        reply,
        error.status,
        error.code,
        error.title,
        error.detail,
        error.errors,
      );
    }
    if (error instanceof IntakeError) {
      return sendProblem(request, reply, error.status, error.code, error.title, error.detail);
    }
    if (error instanceof DomainError) {
      const problem = domainErrorToProblem(error);
      if (problem.status === 500) {
        request.log.error(
          {
            code: problem.code,
            name: (error as Error).name,
            route: request.routeOptions.url ?? request.url.split('?', 1)[0],
            reqId: request.id,
          },
          'unhandled domain error',
        );
        return sendProblem(
          request,
          reply,
          500,
          problem.code,
          'Internal error',
          'an unexpected error occurred',
        );
      }
      return sendProblem(
        request,
        reply,
        problem.status,
        problem.code,
        problem.title,
        problem.detail,
        problem.errors,
      );
    }
    const validationError = error as FastifyValidationError;
    if (validationError.validation !== undefined) {
      return sendValidationProblem(request, reply, validationError);
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 401) {
      return sendProblem(request, reply, 401, 'unauthenticated', 'Unauthenticated', 'authentication required');
    }
    if (statusCode === 429) {
      return sendProblem(request, reply, 429, 'rate_limited', 'Rate limited', 'retry later');
    }
    request.log.error(
      {
        code: 'internal_error',
        name: (error as Error).name,
        route: request.routeOptions.url ?? request.url.split('?', 1)[0],
        reqId: request.id,
      },
      'unhandled request error',
    );
    return sendProblem(
      request,
      reply,
      500,
      'internal_error',
      'Internal error',
      'an unexpected error occurred',
    );
  });

  const users = new PgUserRepository(db, clock);
  const sessions = new InMemorySessionStore({ clock, ttlMs: config.sessionTtlMs });
  const hasher = new Argon2PasswordHasher();
  const rateLimiter = new InMemoryLoginRateLimiter({
    clock,
    limit: config.loginRateLimit.limit,
    windowMs: config.loginRateLimit.windowMs,
  });
  const idempotency =
    options.idempotency ??
    new PgIdempotencyStore({
      db,
      clock,
      ids,
      ttlMs: config.idempotencyTtlMs,
    });
  const dummyPasswordHash = await hasher.hash('ohmydate-login-timing-dummy');
  const auth = new AuthService({
    users,
    hasher,
    sessions,
    rateLimiter,
    dummyPasswordHash,
  });

  let repos = options.repos;
  if (repos === undefined) {
    if (config.provider !== 'vikunja') {
      throw new Error(
        "provider 'memory' requires injected AppRepositories (see createInMemoryRepositories)",
      );
    }
    repos = (await createVikunjaRepositories({ db, config, clock, ids })).repos;
  }

  const llm =
    options.llm ?? (config.llmProvider === 'fake' ? new FakeLlm() : null);
  const budgetGuard =
    options.budgetGuard ??
    new BudgetGuard(
      {
        dailyUsd: config.llmDailyBudgetUsd,
        monthlyUsd: config.llmMonthlyBudgetUsd,
      },
      { allowUnpricedModels: ['fake-llm'] },
    );

  const runtime = createRuntime({
    config,
    clock,
    ids,
    db,
    users,
    sessions,
    idempotency,
    auth,
    repos,
    llm,
    budgetGuard,
  });

  registerHealthRoutes(app, config, db);

  await app.register(
    async (instance) => {
      registerRoutes(instance, runtime);
    },
    { prefix: API_PREFIX },
  );

  if (config.provider === 'vikunja' && config.reconcileIntervalMs > 0) {
    const connectionString = config.databaseUrl;
    if (connectionString === null || connectionString.length === 0) {
      throw new Error(
        'DATABASE_URL is required when VIKUNJA_RECONCILE_INTERVAL_MS > 0 ' +
          '(set config.databaseUrl)',
      );
    }
    const reconcilerLogger = {
      warn: (message: string, details?: Readonly<Record<string, unknown>>) =>
        app.log.warn(details ?? {}, message),
      error: (message: string, details?: Readonly<Record<string, unknown>>) =>
        app.log.error(details ?? {}, message),
    };
    const reconciler = new VikunjaReconciler({
      taskRepository: repos.tasks,
      ownerIds: () => listReconcilerOwnerIds(db),
      leaderLock: createPgSessionLeaderLock({
        connectionString,
        ...(options.reconcileLockKey === undefined ? {} : { key: options.reconcileLockKey }),
        logger: reconcilerLogger,
      }),
      clock,
      intervalMs: config.reconcileIntervalMs,
      logger: reconcilerLogger,
    });
    app.addHook('onClose', async () => {
      await reconciler.stop();
    });
    reconciler.start();
  }

  return app;
}
