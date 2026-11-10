import type { IncomingMessage } from 'node:http';
import { runWithAbortSignal } from '@ohmydate/provider-vikunja';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ShutdownRequestMeta {
  readonly reqId: string;
  readonly method: string;
  readonly route: string;
}

/** Never log an untrusted raw request target. */
export const UNMATCHED_ROUTE = 'unmatched';

interface OperationRecord {
  readonly meta: ShutdownRequestMeta;
  /**
   * Set as soon as the route handler starts. Only then can the handler promise
   * be the settlement signal; before that an aborted request can never start.
   */
  handlerStarted: boolean;
  settled: boolean;
  /** Removes the connection-close fallback listener once settled. */
  detach?: () => void;
}

interface RequestActivity {
  readonly operations: Set<OperationRecord>;
  readonly waiters: Set<() => void>;
}

const controllers = new WeakMap<FastifyInstance, AbortController>();
const activities = new WeakMap<FastifyInstance, RequestActivity>();
const requestMeta = new WeakMap<IncomingMessage, ShutdownRequestMeta>();
const requestOperations = new WeakMap<IncomingMessage, OperationRecord>();

function notifyWhenEmpty(activity: RequestActivity): void {
  if (activity.operations.size > 0) return;
  const waiters = [...activity.waiters];
  activity.waiters.clear();
  for (const waiter of waiters) waiter();
}

function settleOperation(app: FastifyInstance, request: FastifyRequest): void {
  const activity = activities.get(app);
  const operation = requestOperations.get(request.raw);
  if (activity === undefined || operation === undefined) return;
  if (operation.settled) return;
  operation.settled = true;
  operation.detach?.();
  requestOperations.delete(request.raw);
  activity.operations.delete(operation);
  notifyWhenEmpty(activity);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Installs the per-application shutdown signal and handler-operation tracking.
 *
 * Every request runs inside `runWithAbortSignal`, so provider clients used by
 * the handler observe the drain deadline without every port carrying a signal.
 * In-flight tracking follows the route handler's own promise, not socket or
 * response events: a client disconnect does not settle the operation, while a
 * handler that finishes (even after a socket abort, stream abort or hijack)
 * always releases its record. The same hook captures the registered route
 * template (or the constant `unmatched`) for forced-closure logs; request and
 * response bodies and raw targets are deliberately never recorded.
 */
export function installShutdownContext(app: FastifyInstance): AbortController {
  const controller = new AbortController();
  controllers.set(app, controller);
  const activity: RequestActivity = {
    operations: new Set<OperationRecord>(),
    waiters: new Set<() => void>(),
  };
  activities.set(app, activity);

  app.addHook('onRequest', (request, _reply, done) => {
    const meta: ShutdownRequestMeta = {
      reqId: typeof request.id === 'string' ? request.id : String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    };
    const operation: OperationRecord = {
      meta,
      handlerStarted: false,
      settled: false,
    };
    requestMeta.set(request.raw, meta);
    requestOperations.set(request.raw, operation);
    activity.operations.add(operation);
    // A request whose connection dies before its handler starts (incomplete
    // body, forced socket close) can never reach handler settlement. Listen on
    // the socket, not on `request.raw`: IncomingMessage 'close' also fires
    // when a normal body is fully received, which would settle early.
    const socket = request.raw.socket;
    if (socket !== null) {
      const onSocketClose = (): void => {
        if (!operation.handlerStarted) settleOperation(app, request);
      };
      socket.once('close', onSocketClose);
      operation.detach = () => socket.removeListener('close', onSocketClose);
    }
    runWithAbortSignal(controller.signal, done);
  });

  // The handler promise is the settlement signal. Wrapping at route
  // registration covers every route, including ones registered after boot.
  app.addHook('onRoute', (routeOptions) => {
    const original = routeOptions.handler as unknown as (
      this: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => unknown;
    routeOptions.handler = function (
      this: unknown,
      request: FastifyRequest,
      reply: FastifyReply,
    ): unknown {
      const operation = requestOperations.get(request.raw);
      if (operation !== undefined) operation.handlerStarted = true;
      let result: unknown;
      try {
        result = original.call(this, request, reply);
      } catch (error) {
        settleOperation(app, request);
        throw error;
      }
      if (isThenable(result)) {
        return result.then(
          (value) => {
            settleOperation(app, request);
            return value;
          },
          (error: unknown) => {
            settleOperation(app, request);
            throw error;
          },
        );
      }
      settleOperation(app, request);
      return result;
    } as typeof routeOptions.handler;
  });

  // Safety net for requests that never reach a route handler: unmatched
  // routes, validation/auth failures, or a body cut before dispatch. A handler
  // that has already started is only settled by its own promise.
  const settleIfNeverStarted = (request: FastifyRequest): void => {
    const operation = requestOperations.get(request.raw);
    if (operation !== undefined && !operation.handlerStarted) {
      settleOperation(app, request);
    }
  };
  app.addHook('onResponse', (request, _reply, done) => {
    settleIfNeverStarted(request);
    done();
  });
  app.addHook('onError', (request, _reply, _error, done) => {
    settleIfNeverStarted(request);
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

/** Route templates of operations that are still running. */
export function pendingOperationRoutes(app: FastifyInstance): ShutdownRequestMeta[] {
  const activity = activities.get(app);
  if (activity === undefined) return [];
  return [...activity.operations].map((operation) => operation.meta);
}

export function pendingOperationCount(app: FastifyInstance): number {
  return activities.get(app)?.operations.size ?? 0;
}

/**
 * Resolves true once every handler operation has settled, or false when the
 * timeout expires first. Used for both the drain budget (before cancellation)
 * and the bounded cleanup budget (after cancellation).
 */
export function waitForOperationSettlement(
  app: FastifyInstance,
  timeoutMs: number,
): Promise<boolean> {
  const activity = activities.get(app);
  if (activity === undefined || activity.operations.size === 0) {
    return Promise.resolve(true);
  }
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const state: { timer?: NodeJS.Timeout } = {};
    const waiter = (): void => {
      if (state.timer !== undefined) clearTimeout(state.timer);
      resolve(true);
    };
    activity.waiters.add(waiter);
    state.timer = setTimeout(() => {
      activity.waiters.delete(waiter);
      resolve(activity.operations.size === 0);
    }, timeoutMs);
  });
}
