import type { IncomingMessage } from 'node:http';
import { runWithAbortSignal } from '@ohmydate/provider-vikunja';
import type { FastifyInstance } from 'fastify';

export interface ShutdownRequestMeta {
  readonly reqId: string;
  readonly method: string;
  readonly route: string;
}

const controllers = new WeakMap<FastifyInstance, AbortController>();
const requestMeta = new WeakMap<IncomingMessage, ShutdownRequestMeta>();

/**
 * Installs the per-application shutdown signal on the request lifecycle.
 *
 * Every request runs inside `runWithAbortSignal`, so provider clients used by
 * the handler observe the drain deadline without every port carrying a signal.
 * The same hook captures the route, request id and method used to log a forced
 * closure; request and response bodies are deliberately never recorded.
 */
export function installShutdownContext(app: FastifyInstance): AbortController {
  const controller = new AbortController();
  controllers.set(app, controller);
  app.addHook('onRequest', (request, _reply, done) => {
    requestMeta.set(request.raw, {
      reqId: typeof request.id === 'string' ? request.id : String(request.id),
      method: request.method,
      route: request.routeOptions.url ?? request.url,
    });
    runWithAbortSignal(controller.signal, done);
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
