import cookie from '@fastify/cookie';
import { registerIanaTimeZoneFormat } from '@ohmydate/contracts';
import { DomainError, type Clock, type IdGenerator } from '@ohmydate/domain';
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';
import type { Kysely } from 'kysely';
import type { AppConfig } from './config.js';
import type { AppRepositories, IdempotencyStore } from './application/ports.js';
import { AuthService } from './application/auth-service.js';
import { Argon2PasswordHasher } from './adapters/argon2-password-hasher.js';
import { InMemoryLoginRateLimiter } from './adapters/in-memory-login-rate-limiter.js';
import { InMemorySessionStore } from './adapters/in-memory-session-store.js';
import { PgIdempotencyStore } from './adapters/pg-idempotency-store.js';
import { PgUserRepository } from './adapters/pg-user-repository.js';
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

export interface BuildAppOptions {
  readonly config: AppConfig;
  readonly repos: AppRepositories;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly db: Kysely<Database>;
  /** Test override; production uses the structured pino defaults below. */
  readonly logger?: LoggerOption;
  /** Test override for capturing logs with a pre-built pino instance. */
  readonly loggerInstance?: LoggerInstanceOption;
  /** Test override for forcing idempotency-store failures. */
  readonly idempotency?: IdempotencyStore;
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

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, clock, ids, db } = options;
  const logging =
    options.loggerInstance === undefined
      ? { logger: options.logger ?? defaultLoggerOptions(config) }
      : { loggerInstance: options.loggerInstance };
  const app = Fastify({
    ...logging,
    trustProxy: config.trustProxy,
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
    if (error instanceof DomainError) {
      const problem = domainErrorToProblem(error);
      if (problem.status >= 500) {
        request.log.error({ err: error }, 'unhandled domain error');
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
    request.log.error({ err: error }, 'unhandled request error');
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

  const runtime = createRuntime({
    config,
    clock,
    users,
    sessions,
    idempotency,
    auth,
    repos: options.repos,
  });

  registerRoutes(app, runtime);
  return app;
}
