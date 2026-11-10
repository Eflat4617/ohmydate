import net from 'node:net';
import { Writable } from 'node:stream';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createApplicationClose } from '../src/main.js';
import { shutdownControllerFor } from '../src/http/shutdown-context.js';
import type { Database } from '../src/db/types.js';

const { Pool } = pg;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return new Promise<void>(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => chunks.join('') };
}

interface TestApp {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly db: Kysely<Database>;
  readonly output: () => string;
}

async function buildTestApp(handleDelayMs: number): Promise<TestApp> {
  const { stream, output } = captureStream();
  const logger = pino({ level: 'warn' }, stream);
  const pool = new Pool({ connectionString: 'postgres://ohmydate@127.0.0.1:1/unused' });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(17, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  const app = await buildApp({
    config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'warn' }),
    repos,
    clock,
    ids,
    db,
    loggerInstance: logger,
  });
  app.get('/slow-test', async () => {
    // A real handler observes the application abort signal. A handler that
    // ignores it is covered by the never-settling shutdown regression.
    const signal = shutdownControllerFor(app)?.signal;
    await Promise.race([delay(handleDelayMs), aborted(signal)]);
    return { ok: true };
  });
  return { app, db, output };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('shutdown drain per socket', () => {
  test('a valid pending response drains while an incomplete pipelined request is dropped', async () => {
    const { app, db, output } = await buildTestApp(300);
    const close = createApplicationClose(app, 5_000);
    const sockets = new Set<net.Socket>();
    try {
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const socket = await connect(Number(address.port));
      sockets.add(socket);
      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString();
      });

      socket.write(
        'GET /slow-test HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n' +
          'POST /slow-test HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n',
      );
      await delay(100);
      const startedAt = Date.now();
      await Promise.race([
        close(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('shutdown stalled on the pipeline')), 3_000).unref();
        }),
      ]);

      await vi.waitFor(() => expect(received).toContain('HTTP/1.1 200'), {
        timeout: 2_000,
        interval: 25,
      });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(output()).not.toContain('forced shutdown closure');
    } finally {
      for (const socket of sockets) socket.destroy();
      await app.close();
      await db.destroy();
    }
  }, 10_000);

  test('drain expiry aborts the app signal and logs the forced closure without payload', async () => {
    const { app, db, output } = await buildTestApp(5_000);
    const close = createApplicationClose(app, 150);
    const sockets = new Set<net.Socket>();
    try {
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const socket = await connect(Number(address.port));
      sockets.add(socket);
      socket.on('data', () => undefined);
      socket.write(
        'GET /slow-test?token=query-secret HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'X-Secret-Payload: do-not-log-me\r\n\r\n' +
          'POST /unknown?token=query-secret HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
          'Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n',
      );
      await delay(100);

      await close();

      expect(shutdownControllerFor(app)?.signal.aborted).toBe(true);
      const lines = output()
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const forced = lines.find(
        (line) => line.msg === 'forced shutdown closure' && line.method === 'GET',
      );
      expect(forced).toBeDefined();
      expect(forced?.route).toBe('/slow-test');
      expect(forced?.method).toBe('GET');
      expect(typeof forced?.reqId).toBe('string');
      expect(String(forced?.reqId).length).toBeGreaterThan(0);
      const unmatched = lines.find(
        (line) => line.msg === 'forced shutdown closure' && line.method === 'POST',
      );
      expect(unmatched?.route).toBe('unmatched');
      expect(output()).not.toContain('do-not-log-me');
      expect(output()).not.toContain('query-secret');
    } finally {
      for (const socket of sockets) socket.destroy();
      await app.close();
      await db.destroy();
    }
  }, 10_000);
});
