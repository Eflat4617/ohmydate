import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
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
  readonly raw: IncomingMessage;
  /**
   * Set as soon as the route handler starts. Only then can the handler promise
   * be the settlement signal; before that an aborted request can never start.
   */
  handlerStarted: boolean;
  settled: boolean;
}

interface RequestActivity {
  readonly operations: Set<OperationRecord>;
  readonly waiters: Set<() => void>;
}

const controllers = new WeakMap<FastifyInstance, AbortController>();
const activities = new WeakMap<FastifyInstance, RequestActivity>();
const requestMeta = new WeakMap<IncomingMessage, ShutdownRequestMeta>();
const requestOperations = new WeakMap<IncomingMessage, OperationRecord>();
/**
 * One connection-close listener per socket, shared by every request that has
 * not started its handler yet. A listener per request would emit
 * MaxListenersExceededWarning after 10 pipelined requests.
 */
const unstartedBySocket = new WeakMap<Socket, Set<OperationRecord>>();

function notifyWhenEmpty(activity: RequestActivity): void {
  if (activity.operations.size > 0) return;
  const waiters = [...activity.waiters];
  activity.waiters.clear();
  for (const waiter of waiters) waiter();
}

function settleRecord(app: FastifyInstance, operation: OperationRecord): void {
  const activity = activities.get(app);
  if (activity === undefined || operation.settled) return;
  operation.settled = true;
  const socket = operation.raw.socket;
  if (socket !== null) unstartedBySocket.get(socket)?.delete(operation);
  requestOperations.delete(operation.raw);
  activity.operations.delete(operation);
  notifyWhenEmpty(activity);
}

function registerUnstarted(app: FastifyInstance, operation: OperationRecord): void {
  const socket = operation.raw.socket;
  if (socket === null) return;
  let pending = unstartedBySocket.get(socket);
  if (pending === undefined) {
    pending = new Set<OperationRecord>();
    unstartedBySocket.set(socket, pending);
    socket.once('close', () => {
      const records = unstartedBySocket.get(socket);
      if (records === undefined) return;
      unstartedBySocket.delete(socket);
      for (const record of [...records]) {
        // A handler that already started is settled only by its own promise.
        if (!record.handlerStarted) settleRecord(app, record);
      }
    });
  }
  pending.add(operation);
}

function createOperation(
  app: FastifyInstance,
  raw: IncomingMessage,
  meta: ShutdownRequestMeta,
): OperationRecord {
  const activity = activities.get(app);
  const operation: OperationRecord = {
    meta,
    raw,
    handlerStarted: false,
    settled: false,
  };
  requestMeta.set(raw, meta);
  requestOperations.set(raw, operation);
  activity?.operations.add(operation);
  registerUnstarted(app, operation);
  return operation;
}

/**
 * Installs the per-application shutdown signal and handler-operation tracking.
 *
 * Every request runs inside `runWithAbortSignal`, so provider clients used by
 * the handler observe the drain deadline without every port carrying a signal.
 * In-flight tracking follows the route handler's own promise, not socket or
 * response events: a client disconnect does not settle an operation, while a
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
    createOperation(app, request.raw, {
      reqId: typeof request.id === 'string' ? request.id : String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    });
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
      let operation = requestOperations.get(request.raw);
      if (operation === undefined || operation.settled) {
        // The connection may have closed while an I/O-backed preHandler ran.
        // Fastify still starts the handler, so hold a live operation again:
        // only the handler promise may settle it from here on.
        operation = createOperation(app, request.raw, {
          reqId: typeof request.id === 'string' ? request.id : String(request.id),
          method: request.method,
          route:
            routeOptions.url ?? request.routeOptions.url ?? UNMATCHED_ROUTE,
        });
      }
      operation.handlerStarted = true;
      const socket = request.raw.socket;
      if (socket !== null) unstartedBySocket.get(socket)?.delete(operation);
      const record = operation;

      let result: unknown;
      try {
        result = original.call(this, request, reply);
      } catch (error) {
        settleRecord(app, record);
        throw error;
      }
      // Chain through a real promise: a Fastify Reply is a callback-based
      // thenable whose `then` returns undefined, so a rejection handled in the
      // thenable callback would escape as an uncaught exception.
      return Promise.resolve(result).then(
        (value) => {
          settleRecord(app, record);
          return value;
        },
        (error: unknown) => {
          settleRecord(app, record);
          throw error;
        },
      );
    } as typeof routeOptions.handler;
  });

  // Safety net for requests that never reach a route handler: unmatched
  // routes, validation/auth failures, or a body cut before dispatch. A handler
  // that has already started is only settled by its own promise.
  const settleIfNeverStarted = (request: FastifyRequest): void => {
    const operation = requestOperations.get(request.raw);
    if (operation !== undefined && !operation.handlerStarted) {
      settleRecord(app, operation);
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
