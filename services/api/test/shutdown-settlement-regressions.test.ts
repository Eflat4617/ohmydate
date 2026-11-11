import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import {
  SHUTDOWN_CLEANUP_BUDGET_ENV,
  SHUTDOWN_DEADLINE_MS,
  SHUTDOWN_DRAIN_BUDGET_MS,
  createApplicationClose,
  createShutdownController,
  shutdownCleanupBudgetMs,
} from '../src/main.js';
import { pendingOperationCount } from '../src/http/shutdown-context.js';
import type { Database } from '../src/db/types.js';

const { Pool } = pg;

vi.setConfig({ testTimeout: 30_000 });

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface TestApp {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly output: () => string;
}

async function buildTestApp(): Promise<TestApp> {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'warn' }, stream);
  const pool = new Pool({ connectionString: 'postgres://ohmydate@127.0.0.1:1/unused' });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(7, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  const app = await buildApp({
    config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'warn' }),
    repos,
    clock,
    ids,
    db,
    loggerInstance: logger,
  });
  return { app, db, output: () => chunks.join('') };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function listen(app: FastifyInstance): Promise<number> {
  return app
    .listen({ host: '127.0.0.1', port: 0 })
    .then((address) => Number(new URL(address).port));
}

describe('FU-42cR-1 regressions', () => {
  test(
    'close waits for a handler that starts after a pre-handler I/O delay and a client disconnect',
    async () => {
      const { app, db, output } = await buildTestApp();
      // Production installs the shutdown controller before it ever listens.
      const close = createApplicationClose(app, 3_000);
      const preStarted = deferred();
      const handlerStarted = deferred();
      let handlerFinishedAt = 0;
      try {
        app.route({
          method: 'POST',
          url: '/pre-handler',
          preHandler: async () => {
            preStarted.resolve();
            await delay(200);
          },
          handler: async () => {
            handlerStarted.resolve();
            await delay(200);
            handlerFinishedAt = Date.now();
            return { ok: true };
          },
        });
        const port = await listen(app);
        const socket = await connect(port);
        socket.write(
          'POST /pre-handler HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
        );
        await preStarted.promise;
        // The connection dies while the async pre-handler is still awaiting.
        socket.destroy();
        await handlerStarted.promise;

        await close();

        expect(handlerFinishedAt).toBeGreaterThan(0);
        expect(pendingOperationCount(app)).toBe(0);
        expect(output()).not.toContain('unsettled operations');
      } finally {
        await app.close().catch(() => undefined);
        await db.destroy();
      }
    },
    20_000,
  );

  test(
    'an abort-ignoring handler that starts after a pre-handler disconnect exits 1',
    async () => {
      const { app, db, output } = await buildTestApp();
      const preStarted = deferred();
      const handlerStarted = deferred();
      let exitCode: number | undefined;
      const exited = deferred();
      try {
        app.route({
          method: 'POST',
          url: '/pre-handler-never',
          preHandler: async () => {
            preStarted.resolve();
            await delay(100);
          },
          handler: () => {
            handlerStarted.resolve();
            // Deliberately ignores the abort signal and never settles.
            return new Promise(() => undefined);
          },
        });
        const shutdown = createShutdownController({
          logger: {
            info: () => undefined,
            error: (details, message) => app.log.error(details, message),
          },
          close: createApplicationClose(app, 100, 100),
          destroy: async () => undefined,
          exit: (code) => {
            exitCode = code;
            exited.resolve();
          },
          deadlineMs: 5_000,
        });

        const port = await listen(app);
        const socket = await connect(port);
        socket.write(
          'POST /pre-handler-never HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}',
        );
        await preStarted.promise;
        socket.destroy();
        await handlerStarted.promise;

        shutdown('SIGTERM');
        await exited.promise;

        expect(exitCode).toBe(1);
        expect(output()).toContain('unsettled operations after shutdown cleanup budget');
      } finally {
        await app.close().catch(() => undefined);
        await db.destroy();
      }
    },
    20_000,
  );

  test('a sync handler returning reply survives a write-after-end rejection', async () => {
    const { app, db } = await buildTestApp();
    try {
      app.get('/sync-reply', (_request, reply) => {
        setTimeout(() => {
          reply.raw.end('done');
          reply.raw.write('late');
        }, 10);
        return reply;
      });
      app.get('/ok', async () => ({ ok: true }));
      const port = await listen(app);
      const base = `http://127.0.0.1:${String(port)}`;

      const response = await fetch(`${base}/sync-reply`);
      expect(response.status).toBe(200);
      await response.text();
      await delay(100);

      const stillAlive = await fetch(`${base}/ok`);
      expect(stillAlive.status).toBe(200);
      expect(await stillAlive.json()).toEqual({ ok: true });
      expect(pendingOperationCount(app)).toBe(0);
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 15_000);

  test('15 pipelined requests do not add a close listener per request', async () => {
    const { app, db } = await buildTestApp();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);
    let socket: net.Socket | undefined;
    try {
      app.get('/fast', async () => ({ ok: true }));
      const port = await listen(app);
      socket = await connect(port);
      const connected = socket;
      let received = '';
      connected.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });
      let pipeline = '';
      for (let index = 0; index < 15; index += 1) {
        pipeline += 'GET /fast HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n';
      }
      connected.write(pipeline);

      await vi.waitFor(
        () => {
          const count = received.match(/HTTP\/1\.1 200/g)?.length ?? 0;
          expect(count).toBe(15);
        },
        { timeout: 5_000, interval: 20 },
      );
      await delay(50);
      expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual(
        [],
      );
    } finally {
      process.removeListener('warning', onWarning);
      socket?.destroy();
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 20_000);

  test('a response that completes during the cleanup window is delivered', async () => {
    const { app, db } = await buildTestApp();
    const close = createApplicationClose(app, 100, 1_500);
    let socket: net.Socket | undefined;
    try {
      app.addHook('onSend', async (request, _reply, payload) => {
        if (request.url === '/late') await delay(150);
        return payload;
      });
      app.get('/late', async () => {
        // Ignores the abort signal and settles after the drain budget.
        await delay(300);
        return { ok: true };
      });
      const port = await listen(app);
      socket = await connect(port);
      const connected = socket;
      let received = '';
      connected.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });
      connected.write('GET /late HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await delay(20);

      await close();

      await vi.waitFor(() => expect(received).toContain('HTTP/1.1 200'), {
        timeout: 2_000,
        interval: 20,
      });
      expect(received).toContain('"ok":true');
      expect(pendingOperationCount(app)).toBe(0);
    } finally {
      socket?.destroy();
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 20_000);

  test('onClose hooks run only after handlers have settled', async () => {
    const { app, db } = await buildTestApp();
    const close = createApplicationClose(app, 3_000);
    const handlerStarted = deferred();
    let handlerFinishedAt = 0;
    let onCloseAt = 0;
    try {
      app.addHook('onClose', async () => {
        onCloseAt = Date.now();
      });
      app.get('/slow-close', async () => {
        handlerStarted.resolve();
        await delay(300);
        handlerFinishedAt = Date.now();
        return { ok: true };
      });
      const port = await listen(app);
      const socket = await connect(port);
      socket.write('GET /slow-close HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await handlerStarted.promise;
      socket.destroy();
      await delay(20);

      await close();

      expect(handlerFinishedAt).toBeGreaterThan(0);
      expect(onCloseAt).toBeGreaterThanOrEqual(handlerFinishedAt);
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 20_000);

  test('SHUTDOWN_CLEANUP_BUDGET_MS must leave room inside the hard deadline', () => {
    const max =
      SHUTDOWN_DEADLINE_MS - SHUTDOWN_DRAIN_BUDGET_MS - 500;
    expect(shutdownCleanupBudgetMs({})).toBe(2_000);
    expect(
      shutdownCleanupBudgetMs({ [SHUTDOWN_CLEANUP_BUDGET_ENV]: String(max) }),
    ).toBe(max);
    expect(() =>
      shutdownCleanupBudgetMs({ [SHUTDOWN_CLEANUP_BUDGET_ENV]: String(max + 1) }),
    ).toThrow(SHUTDOWN_CLEANUP_BUDGET_ENV);
    expect(() =>
      shutdownCleanupBudgetMs({ [SHUTDOWN_CLEANUP_BUDGET_ENV]: '3000' }),
    ).toThrow(SHUTDOWN_CLEANUP_BUDGET_ENV);
  });

  test('a 1000-request mixed workload settles the registry back to zero', async () => {
    const { app, db } = await buildTestApp();
    try {
      app.get('/p/async', async () => ({ ok: true }));
      app.get('/p/sync', () => ({ ok: true }));
      app.get('/p/sync-reply', (_request, reply) => {
        reply.send({ ok: true });
        return reply;
      });
      app.get('/p/stream', (_request, reply) =>
        reply.send(Readable.from(['streamed'])),
      );
      app.get('/p/hijack', (_request, reply) => {
        reply.hijack();
        reply.raw.writeHead(200, { 'content-type': 'text/plain' });
        reply.raw.end('hijacked');
      });
      app.route({
        method: 'GET',
        url: '/p/pre',
        preHandler: async () => {
          await delay(1);
        },
        handler: async () => ({ ok: true }),
      });
      app.route({
        method: 'GET',
        url: '/p/protected',
        preHandler: async () => {
          const error = new Error('authentication required') as Error & { statusCode: number };
          error.statusCode = 401;
          throw error;
        },
        handler: async () => ({ ok: true }),
      });
      app.post('/p/echo', async (request) => ({ body: request.body }));
      await app.ready();

      const kinds = [
        'async',
        'sync',
        'sync-reply',
        'stream',
        'hijack',
        'pre',
        'protected',
        'echo',
        '404',
        'bad-json',
      ] as const;
      for (let index = 0; index < 1_000; index += 1) {
        const kind = kinds[index % kinds.length] as (typeof kinds)[number];
        if (kind === 'async' || kind === 'sync' || kind === 'sync-reply' || kind === 'stream' || kind === 'hijack' || kind === 'pre') {
          await app.inject({ method: 'GET', url: `/p/${kind === 'pre' ? 'pre' : kind}` });
          continue;
        }
        if (kind === 'protected') {
          await app.inject({ method: 'GET', url: '/p/protected' });
          continue;
        }
        if (kind === 'echo') {
          await app.inject({ method: 'POST', url: '/p/echo', payload: { value: index } });
          continue;
        }
        if (kind === '404') {
          await app.inject({ method: 'GET', url: '/p/missing?token=query-secret' });
          continue;
        }
        await app.inject({
          method: 'POST',
          url: '/p/echo',
          headers: { 'content-type': 'application/json' },
          payload: '{',
        });
      }

      expect(pendingOperationCount(app)).toBe(0);
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 30_000);
});
