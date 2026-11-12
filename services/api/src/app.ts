import cookie from '@fastify/cookie';
import { createServer as createHttpServer } from 'node:http';
import { registerIanaTimeZoneFormat } from '@ohmydate/contracts';
import { DomainError, type Clock, type IdGenerator } from '@ohmydate/domain';
import {
  BudgetGuard,
  OpenAICompatibleLlm,
  PolicyLlm,
  maxPromptTimeoutMs,
  staleReservationThresholdWithFallbackMs,
  type LlmPort,
  type ResolvedLlmAccess,
} from '@ohmydate/llm';
import { vikunjaCallBudgetMs } from '@ohmydate/provider-vikunja';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { assertFakeKnobsAllowed, llmPromptLimits, type AppConfig } from './config.js';
import type { AppRepositories, IdempotencyStore } from './application/ports.js';
import type { Id } from '@ohmydate/domain';
import { AuthService } from './application/auth-service.js';
import { createBaseFakeLlm } from './adapters/fake-llm-scenarios.js';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher.js';
import { InMemoryLoginRateLimiter } from './adapters/in-memory-login-rate-limiter.js';
import { InMemorySessionStore } from './adapters/in-memory-session-store.js';
import { PgIdempotencyStore } from './adapters/pg-idempotency-store.js';
import { createPgSpendLedger } from './adapters/pg-spend-ledger.js';
import { ScriptedFakeLlm } from './adapters/scripted-fake-llm.js';
import { PgPlanningStore } from './adapters/pg-planning-store.js';
import { PgUserRepository, parseUserSettings } from './adapters/pg-user-repository.js';
import { IntakeError } from './application/intake/intake-error.js';
import { DailyProblemError } from './application/daily-errors.js';
import { NotificationJob } from './application/notification-service.js';
import { ExportPurgeJob } from './application/export-purge-job.js';
import { ReplanDetectionJob } from './application/replan-detection-job.js';
import { ReplanSuppressedError } from './application/replan-errors.js';
import { PgNotificationStore } from './adapters/pg-notification-store.js';
import { PgExportStore } from './adapters/pg-export-store.js';
import { createVikunjaRepositories } from './adapters/vikunja/composition.js';
import { listReconcilerOwnerIds } from './adapters/vikunja/owner-accounts.js';
import {
  createPgSessionLeaderLock,
  VikunjaReconciler,
} from './adapters/vikunja/reconciler.js';

/** Distinct advisory lock key from the Vikunja reconciler (08 §4, §2.9). */
export const NOTIFICATION_ADVISORY_LOCK_KEY = 5_196_102;
export const EXPORT_PURGE_ADVISORY_LOCK_KEY = 5_196_103;
export const REPLAN_DETECTION_ADVISORY_LOCK_KEY = 5_196_104;
export const DEFAULT_REPLAN_DETECTION_JOB_INTERVAL_MS = 300_000;
export const DEFAULT_NOTIFICATION_JOB_INTERVAL_MS = 60_000;
export const DEFAULT_EXPORT_PURGE_JOB_INTERVAL_MS = 300_000;

/**
 * Single-process (memory provider) maintenance scheduler. The leader-only path
 * uses the shared `setInterval` scheduler; this recursive timer keeps the
 * in-process sweeps independent of the leader-lock lifecycle and unref'd so a
 * background timer never delays shutdown.
 */
function maintenanceTimeoutScheduler(
  callback: () => void,
  milliseconds: number,
): { stop(): void } {
  let handle: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    callback();
    handle = setTimeout(tick, milliseconds);
    handle.unref?.();
  };
  handle = setTimeout(tick, milliseconds);
  handle.unref?.();
  return {
    stop: () => {
      stopped = true;
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}
import type { Database } from './db/types.js';
import {
  ProblemError,
  domainErrorToProblem,
  sendProblem,
  sendValidationProblem,
  type FastifyValidationError,
} from './http/problem.js';
import { createRuntime, registerRoutes } from './http/routes.js';
import {
  AvailabilityChangedError,
  ConstraintViolationError,
  PlanConflictError,
} from './application/planning-errors.js';
import { installShutdownContext } from './http/shutdown-context.js';
import { loggedPath, loggedUrl } from './http/log-url.js';
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
   * Injected LLM adapter. Default composition uses FakeLlm for
   * `LLM_PROVIDER=fake` and the OpenAI-compatible DeepSeek adapter (wrapped in
   * the owner consent/budget gate) for `LLM_PROVIDER=deepseek`.
   */
  readonly llm?: LlmPort;
  /** Boot-time key read by main; never part of AppConfig or logs. */
  readonly llmApiKey?: string;
  /** HMAC secret for the non-identifying opencode.ai session header. */
  readonly llmSessionSecret?: string;
  /** Test override for the fail-closed budget guard. */
  readonly budgetGuard?: BudgetGuard;
  /**
   * Test override for the reconciler's advisory-lock key. Production uses the
   * stable VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY; a distinct key lets parallel
   * test workers avoid contending on the shared planner database.
   */
  readonly reconcileLockKey?: number;
  /**
   * Test-only overrides for the leader-only maintenance jobs. Production uses
   * the built-in intervals and real timers; disabling an interval (0) keeps
   * background sweeps out of isolated test processes.
   */
  readonly jobOverrides?: MaintenanceJobOverrides;
}

export interface MaintenanceJobOverrides {
  readonly notificationIntervalMs?: number;
  readonly exportPurgeIntervalMs?: number;
  readonly scheduler?: (callback: () => void, milliseconds: number) => { stop(): void };
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
      // M6-01R-1 H1: path only; query values are never logged (see log-url.ts).
      req(request: { method?: string; url?: string; id?: string }) {
        const logged = loggedUrl(request.url ?? '');
        return {
          method: request.method ?? '',
          url: logged.path,
          ...(logged.queryKeys === undefined ? {} : { queryKeys: logged.queryKeys }),
          ...(logged.queryOmitted === undefined ? {} : { queryOmitted: logged.queryOmitted }),
          id: request.id ?? '',
        };
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
 *   provider budget above; it must stay well above 30 s. M6-01 fix round 1: a
 *   note-grounded decomposition may take one 120 s attempt plus one repair
 *   (`LLM_DECOMPOSITION_TIMEOUT_MS`), so the default is 300 s (2 x 120 s + margin)
 *   and boot warns when an explicit value is below twice that timeout.
 * - `connectionsCheckingInterval` makes the receive limits fire promptly
 *   instead of Node's 30 s default.
 */
export const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_HEADERS_TIMEOUT_MS = 10_000;
export const DEFAULT_HTTP_CONNECTION_TIMEOUT_MS = 300_000;
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

/**
 * ADR-022 composition: `fake` stays the deterministic CI provider; `deepseek`
 * is opt-in and always wrapped by the owner consent/budget gate. The key is
 * supplied by main after a single fail-closed boot read and is never stored on
 * AppConfig.
 */
async function createConfiguredLlm(input: {
  readonly options: BuildAppOptions;
  readonly config: AppConfig;
  readonly db: Kysely<Database>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): Promise<LlmPort | null> {
  const { options, config, db, clock, ids } = input;
  if (options.llm !== undefined) return options.llm;
  if (config.llmProvider === 'fake') return fakeLlmFor(config);

  const apiKey = options.llmApiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('LLM API key is required when LLM_PROVIDER=deepseek');
  }
  const inner = new OpenAICompatibleLlm({
    baseUrl: config.llmBaseUrl,
    apiKey,
    model: config.llmModel,
    provider: config.llmProvider,
    reasoningEffort: config.llmReasoningEffort,
    maxOutputTokens: config.llmMaxOutputTokens,
    sessionHeader: config.llmSessionHeader,
    ...(options.llmSessionSecret === undefined
      ? {}
      : { sessionSecret: options.llmSessionSecret }),
    pricing: {
      inputUsd: config.llmPriceInputPerM,
      outputUsd: config.llmPriceOutputPerM,
      cachedInputUsd: config.llmPriceCachedPerM,
    },
  });

  const resolve = async (ownerId: string): Promise<ResolvedLlmAccess | null> => {
    const user = await db
      .selectFrom('user')
      .select('settings')
      .where('id', '=', ownerId as Id)
      .executeTakeFirst();
    if (user === undefined) return null;
    const settings = parseUserSettings(user.settings);
    const explicitBudget = hasExplicitBudget(user.settings);
    return {
      consent: settings.llm?.consent ?? null,
      budget:
        settings.llm?.budget ?? (explicitBudget ? ('invalid' as const) : null),
    };
  };

  const ledger = createPgSpendLedger(db);
  return new PolicyLlm({
    inner,
    providerId: config.llmProvider,
    defaultBudget: {
      dailyUsd: config.llmDailyBudgetUsd,
      monthlyUsd: config.llmMonthlyBudgetUsd,
    },
    resolve,
    ledger,
    pricing: {
      inputUsd: config.llmPriceInputPerM,
      outputUsd: config.llmPriceOutputPerM,
      cachedInputUsd: config.llmPriceCachedPerM,
    },
    maxOutputTokens: config.llmMaxOutputTokens,
    newReservationId: () => ids.next(),
    now: () => new Date(clock.now()),
    // A decomposition attempt may legitimately run for llmDecompositionTimeoutMs;
    // only reservations older than the slowest attempt chain (JSON-mode plus
    // the strict-instruction fallback, FU-54) are recovered.
    staleAfterMs: staleReservationThresholdWithFallbackMs(
      maxPromptTimeoutMs(llmPromptLimits(config)),
    ),
  });
}

/**
 * `LLM_PROVIDER=fake` composition. The base fake mode comes first: the
 * fixture-less FakeLlm (immediate llm_unavailable -> manual mode), or, with
 * `LLM_FAKE_SCENARIO`, the M6-03 scenario for its owners on top of that plain
 * fake. The FU-76 scripted slow owners WRAP the base and delegate every other
 * owner to it, so no fake mode shadows another. Fake knobs were already checked
 * by `assertFakeKnobsAllowed` (never in production).
 */
export function fakeLlmFor(config: AppConfig): LlmPort {
  const base: LlmPort = createBaseFakeLlm({ scenario: config.llmFakeScenario, owners: config.llmFakeScenarioOwners });
  if (config.llmFakeScriptedOwners.length === 0) return base;
  return new ScriptedFakeLlm({
    inner: base,
    latencyMs: config.llmFakeLatencyMs,
    owners: config.llmFakeScriptedOwners,
  });
}

function hasExplicitBudget(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const llm = (value as Record<string, unknown>)['llm'];
  return llm !== null && typeof llm === 'object' && !Array.isArray(llm) && Object.hasOwn(llm, 'budget');
}

const startupSweeps = new WeakMap<
  FastifyInstance,
  Promise<{ readonly runs: number; readonly sessions: number } | null>
>();

/** FU-76: the background startup sweep of `app` (tests await it). */
export function startupSweepFor(
  app: FastifyInstance,
): Promise<{ readonly runs: number; readonly sessions: number } | null> | undefined {
  return startupSweeps.get(app);
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, clock, ids, db } = options;
  // FU-76R-1 H3: a config built without configFromEnv is checked at boot too.
  assertFakeKnobsAllowed(config);
  // ADR-020 §10: the succession wait must cover the slowest single HTTP
  // request so a replaced approver's already-started request cannot still be
  // running; requests it would start later are fenced before fetch.
  const minimumCallBudget = vikunjaCallBudgetMs();
  if (
    !Number.isInteger(config.providerMaxCallMs) ||
    config.providerMaxCallMs < minimumCallBudget
  ) {
    throw new Error(
      `PROVIDER_MAX_CALL_MS must be an integer >= ${minimumCallBudget} ` +
        '(the Vikunja client one-request attempts*timeout+backoff budget)',
    );
  }
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
  const decompositionCallBudgetMs = 2 * config.llmDecompositionTimeoutMs;
  if (config.llmProvider !== 'fake' && connectionTimeoutMs < decompositionCallBudgetMs) {
    app.log.warn(
      { connectionTimeoutMs, decompositionCallBudgetMs },
      'HTTP connection timeout is below the decomposition call budget (attempt + repair)',
    );
  }

  app.decorateRequest('authSession', null);
  installShutdownContext(app);
  await app.register(cookie);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-trace-id', String(request.id));
    return payload;
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, 404, 'not_found', 'Not found', 'no route matches this request'),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AvailabilityChangedError) {
      return sendProblem(
        request,
        reply,
        412,
        'availability_changed',
        'Availability changed',
        error.message,
      );
    }
    if (error instanceof ConstraintViolationError) {
      return sendProblem(
        request,
        reply,
        422,
        'constraint_violation',
        'Plan violates scheduling constraints',
        'the candidate cannot be approved as-is',
        undefined,
        error.violations,
      );
    }
    if (error instanceof PlanConflictError) {
      return sendProblem(
        request,
        reply,
        409,
        'illegal_transition',
        'State conflict',
        error.message,
      );
    }
    if (error instanceof ReplanSuppressedError) {
      reply.header('Retry-After', String(error.retryAfterSec));
      return sendProblem(
        request,
        reply,
        409,
        'replan_suppressed',
        'Replan suppressed',
        error.message,
      );
    }
    if (error instanceof DailyProblemError) {
      return sendProblem(
        request,
        reply,
        error.status,
        error.code,
        error.title,
        error.detail,
      );
    }
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
      if (error.headers !== undefined) {
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      }
      return sendProblem(request, reply, error.status, error.code, error.title, error.detail);
    }
    if (error instanceof DomainError) {
      const problem = domainErrorToProblem(error);
      if (problem.status === 500) {
        request.log.error(
          {
            code: problem.code,
            name: (error as Error).name,
            route: request.routeOptions.url ?? loggedPath(request.url),
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
        route: request.routeOptions.url ?? loggedPath(request.url),
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

  const planningStore = new PgPlanningStore({ db, clock, ids });
  const llm = await createConfiguredLlm({ options, config, db, clock, ids });
  // The owner gate enforces consent + the per-owner settings budget; keep the
  // legacy global guard permissive there so a user-raised budget is not
  // re-clamped by the config default. Injected guards (tests) still win.
  const gateEnforcesBudget =
    options.llm === undefined && config.llmProvider === 'deepseek';
  const budgetGuard =
    options.budgetGuard ??
    new BudgetGuard(
      {
        dailyUsd: gateEnforcesBudget
          ? Number.MAX_SAFE_INTEGER
          : config.llmDailyBudgetUsd,
        monthlyUsd: gateEnforcesBudget
          ? Number.MAX_SAFE_INTEGER
          : config.llmMonthlyBudgetUsd,
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
    planningStore,
    llm,
    budgetGuard,
    logger: {
      warn: (message, details) => app.log.warn(details ?? {}, message),
    },
  });

  registerHealthRoutes(app, config, db);

  // FU-76 startup sweep: AI runs and intake sessions left "in flight" by a
  // crashed process (older than the intake AI request bound) become
  // cancelled / ai_interrupted. It runs in the background so an unreachable
  // database never blocks boot; onClose waits for it only briefly.
  const sweep = runtime.intake.sweepOrphanedAiRuns().then(
    (result) => {
      if (result.runs > 0 || result.sessions > 0) {
        app.log.warn(result, 'swept orphaned intake AI runs');
      }
      return result;
    },
    (error: unknown) => {
      app.log.warn(
        { name: error instanceof Error ? error.name : 'unknown' },
        'orphaned intake AI run sweep failed',
      );
      return null;
    },
  );
  startupSweeps.set(app, sweep);
  app.addHook('onClose', async () => {
    await Promise.race([sweep, new Promise((resolve) => setTimeout(resolve, 1_000).unref())]);
  });

  await app.register(
    async (instance) => {
      registerRoutes(instance, runtime);
    },
    { prefix: API_PREFIX },
  );

  // FU-79: E2E-only, fake-provider-only isolation of the fixed login window.
  // Not part of the public contract/OpenAPI; production boot rejects the knob.
  if (config.e2eResetLoginRateLimit) {
    app.post(`${API_PREFIX}/__e2e__/reset-login-rate-limit`, async (_request, reply) => {
      runtime.auth.resetLoginRateLimit();
      return reply.code(204).send();
    });
  }

  const leaderConnection = config.databaseUrl;
  const useLeaderLock =
    config.provider === 'vikunja' &&
    leaderConnection !== null &&
    leaderConnection.length > 0;
  const jobLogger = {
    warn: (message: string, details?: Readonly<Record<string, unknown>>) =>
      app.log.warn(details ?? {}, message),
    error: (message: string, details?: Readonly<Record<string, unknown>>) =>
      app.log.error(details ?? {}, message),
  };
  const lockFor = (key: number): ReturnType<typeof createPgSessionLeaderLock> | undefined =>
    useLeaderLock && leaderConnection !== null
      ? createPgSessionLeaderLock({
          connectionString: leaderConnection,
          key,
          logger: jobLogger,
        })
      : undefined;
  const scheduler =
    options.jobOverrides?.scheduler ??
    (useLeaderLock ? undefined : maintenanceTimeoutScheduler);
  const startMaintenance = useLeaderLock || config.provider === 'memory';
  const notificationLock = lockFor(NOTIFICATION_ADVISORY_LOCK_KEY);
  const notificationJob = new NotificationJob({
    store: new PgNotificationStore({ db, ids }),
    clock,
    intervalMs:
      options.jobOverrides?.notificationIntervalMs ?? DEFAULT_NOTIFICATION_JOB_INTERVAL_MS,
    ...(notificationLock === undefined ? {} : { leaderLock: notificationLock }),
    logger: jobLogger,
    ...(scheduler === undefined ? {} : { scheduler }),
  });
  const exportPurgeLock = lockFor(EXPORT_PURGE_ADVISORY_LOCK_KEY);
  const exportPurgeJob = new ExportPurgeJob({
    store: new PgExportStore({ db, clock }),
    clock,
    intervalMs:
      options.jobOverrides?.exportPurgeIntervalMs ?? DEFAULT_EXPORT_PURGE_JOB_INTERVAL_MS,
    ...(exportPurgeLock === undefined ? {} : { leaderLock: exportPurgeLock }),
    logger: jobLogger,
    ...(scheduler === undefined ? {} : { scheduler }),
  });
  app.addHook('onClose', async () => {
    await notificationJob.stop();
    await exportPurgeJob.stop();
  });
  if (startMaintenance) {
    notificationJob.start();
    exportPurgeJob.start();
  }

  if (useLeaderLock && leaderConnection !== null) {
    const replanDetectionJob = new ReplanDetectionJob({
      runner: runtime.replan,
      clock,
      intervalMs: DEFAULT_REPLAN_DETECTION_JOB_INTERVAL_MS,
      leaderLock: createPgSessionLeaderLock({
        connectionString: leaderConnection,
        key: REPLAN_DETECTION_ADVISORY_LOCK_KEY,
        logger: jobLogger,
      }),
      logger: jobLogger,
    });
    app.addHook('onClose', async () => {
      await replanDetectionJob.stop();
    });
    replanDetectionJob.start();
  }

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
