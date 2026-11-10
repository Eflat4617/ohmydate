import type { IncomingMessage } from 'node:http';
import { runWithAbortSignal } from '@ohmydate/provider-vikunja';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface ShutdownRequestMeta {
  readonly reqId: string;
  readonly method: string;
  readonly route: string;
}

/** Never log an untrusted raw request target. */
export const UNMATCHED_ROUTE = 'unmatched';

interface RequestActivity {
  readonly tokens: Set<symbol>;
  readonly waiters: Set<() => void>;
}

const controllers = new WeakMap<FastifyInstance, AbortController>();
const activities = new WeakMap<FastifyInstance, RequestActivity>();
const requestMeta = new WeakMap<IncomingMessage, ShutdownRequestMeta>();
const requestTokens = new WeakMap<IncomingMessage, symbol>();

function settleRequest(app: FastifyInstance, request: FastifyRequest): void {
  const activity = activities.get(app);
  const token = requestTokens.get(request.raw);
  if (activity === undefined || token === undefined) return;
  requestTokens.delete(request.raw);
  if (!activity.tokens.delete(token)) return;
  if (activity.tokens.size > 0) return;
  const waiters = [...activity.waiters];
  activity.waiters.clear();
  for (const waiter of waiters) waiter();
}

/**
 * Installs the per-application shutdown signal and request activity tracking.
 *
 * Every request runs inside `runWithAbortSignal`, so provider clients used by
 * the handler observe the drain deadline without every port carrying a signal.
 * The same hook captures the registered route template (or the constant
 * `unmatched`) for forced-closure logs; request and response bodies and raw
 * targets are deliberately never recorded.
 */
export function installShutdownContext(app: FastifyInstance): AbortController {
  const controller = new AbortController();
  controllers.set(app, controller);
  const activity: RequestActivity = {
    tokens: new Set<symbol>(),
    waiters: new Set<() => void>(),
  };
  activities.set(app, activity);

  app.addHook('onRequest', (request, _reply, done) => {
    requestMeta.set(request.raw, {
      reqId: typeof request.id === 'string' ? request.id : String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    });
    const token = Symbol('shutdownRequest');
    requestTokens.set(request.raw, token);
    activity.tokens.add(token);
    runWithAbortSignal(controller.signal, done);
  });
  // onResponse/onError run after the handler settles; a forced socket close
  // must not release the database before the handler's recovery writes finish.
  app.addHook('onResponse', (request, _reply, done) => {
    settleRequest(app, request);
    done();
  });
  app.addHook('onError', (request, _reply, _error, done) => {
    settleRequest(app, request);
    done();
  });
  return controller;
}

export function shutdownControllerFor(app: FastifyInstance): AbortController | undefined {
  return controllers.get(app);
}

export function shutdownRequestMeta(
  request: IncomingMessage,
): ShutdownRequestMeta | undefined {
  return requestMeta.get(request);
}

/**
 * Resolves true once every started request has settled, or false when the
 * bounded cleanup budget expires first. Used after drain cancellation so
 * `db.destroy()` cannot overtake an aborted handler's recovery and idempotency
 * release (FU-42R-1 finding 1).
 */
export function waitForRequestSettlement(
  app: FastifyInstance,
  timeoutMs: number,
): Promise<boolean> {
  const activity = activities.get(app);
  if (activity === undefined || activity.tokens.size === 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const state: { timer?: NodeJS.Timeout } = {};
    const waiter = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      resolve(true);
    };
    activity.waiters.add(waiter);
    state.timer = setTimeout(() => {
      activity.waiters.delete(waiter);
      resolve(activity.tokens.size === 0);
    }, timeoutMs);
  });
}
