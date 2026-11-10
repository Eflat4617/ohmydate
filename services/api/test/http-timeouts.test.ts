import type { Server } from 'node:http';
import net from 'node:net';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createApplicationClose } from '../src/main.js';
import type { Database } from '../src/db/types.js';
import {
  DEFAULT_HTTP_CONNECTION_TIMEOUT_MS,
  DEFAULT_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS,
  DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  HTTP_CONNECTION_TIMEOUT_ENV,
  HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV,
  HTTP_HEADERS_TIMEOUT_ENV,
  HTTP_REQUEST_TIMEOUT_ENV,
  httpTimeouts,
} from '../src/app.js';

const { Pool } = pg;

interface AppHandle {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
}

async function buildTestApp(env: Record<string, string>): Promise<AppHandle> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const pool = new Pool({ connectionString: 'postgres://ohmydate@127.0.0.1:1/unused' });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(5, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  try {
    const app = await buildApp({
      config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'silent' }),
      repos,
      clock,
      ids,
      db,
      logger: false,
    });
    return { app, db };
  } catch (error) {
    await db.destroy();
    throw error;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('Fastify request and connection timeouts', () => {
  test('defaults separate request receive limits from socket inactivity', async () => {
    expect(DEFAULT_HTTP_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_HTTP_HEADERS_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_HTTP_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS).toBe(1_000);
    expect(httpTimeouts({})).toEqual({
      requestTimeoutMs: DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      headersTimeoutMs: DEFAULT_HTTP_HEADERS_TIMEOUT_MS,
      connectionTimeoutMs: DEFAULT_HTTP_CONNECTION_TIMEOUT_MS,
      connectionsCheckingIntervalMs: DEFAULT_HTTP_CONNECTIONS_CHECKING_INTERVAL_MS,
    });
    expect(() => httpTimeouts({ [HTTP_REQUEST_TIMEOUT_ENV]: '0' })).toThrow(
      'HTTP_REQUEST_TIMEOUT_MS must be a positive integer',
    );
    expect(() => httpTimeouts({ [HTTP_CONNECTION_TIMEOUT_ENV]: 'nope' })).toThrow(
      'HTTP_CONNECTION_TIMEOUT_MS must be a positive integer',
    );
    expect(() =>
      httpTimeouts({
        [HTTP_REQUEST_TIMEOUT_ENV]: '1000',
        [HTTP_HEADERS_TIMEOUT_ENV]: '2000',
      }),
    ).toThrow('HTTP_HEADERS_TIMEOUT_MS must be <= HTTP_REQUEST_TIMEOUT_MS');
  });

  test('the configured limits reach the Node HTTP server', async () => {
    const handle = await buildTestApp({
      [HTTP_REQUEST_TIMEOUT_ENV]: '4321',
      [HTTP_HEADERS_TIMEOUT_ENV]: '4000',
      [HTTP_CONNECTION_TIMEOUT_ENV]: '61000',
      [HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV]: '250',
    });
    try {
      const server = handle.app.server as Server & {
        connectionsCheckingInterval?: number;
      };
      expect(server.requestTimeout).toBe(4_321);
      expect(server.headersTimeout).toBe(4_000);
      // Fastify maps its `connectionTimeout` option onto `server.timeout`.
      expect(server.timeout).toBe(61_000);
      expect(server.connectionsCheckingInterval).toBe(250);
    } finally {
      await handle.app.close();
      await handle.db.destroy();
    }
  });

  test(
    'the request receive deadline cuts a trickling body on a running server',
    async () => {
      const handle = await buildTestApp({
        [HTTP_REQUEST_TIMEOUT_ENV]: '300',
        [HTTP_HEADERS_TIMEOUT_ENV]: '300',
        [HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV]: '50',
      });
      let socket: net.Socket | undefined;
      let trickle: NodeJS.Timeout | undefined;
      try {
        const address = new URL(await handle.app.listen({ host: '127.0.0.1', port: 0 }));
        const slowSocket = net.connect(Number(address.port), address.hostname);
        socket = slowSocket;
        let received = '';
        slowSocket.on('data', (chunk: Buffer) => {
          received += chunk.toString();
        });
        await new Promise<void>((resolve, reject) => {
          slowSocket.once('connect', resolve);
          slowSocket.once('error', reject);
        });
        slowSocket.write(
          'POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n',
        );
        trickle = setInterval(() => {
          if (!slowSocket.destroyed) slowSocket.write(' ');
        }, 100);

        await vi.waitFor(
          () => {
            expect(received).toContain('408 Request Timeout');
          },
          { timeout: 2_000, interval: 50 },
        );
      } finally {
        if (trickle !== undefined) clearInterval(trickle);
        socket?.destroy();
        await handle.app.close();
        await handle.db.destroy();
      }
    },
    10_000,
  );

  test(
    'force-closing remaining connections lets shutdown settle despite a trickle',
    async () => {
      const handle = await buildTestApp({
        [HTTP_REQUEST_TIMEOUT_ENV]: '300',
        [HTTP_HEADERS_TIMEOUT_ENV]: '300',
        [HTTP_CONNECTIONS_CHECKING_INTERVAL_ENV]: '50',
      });
      let socket: net.Socket | undefined;
      let trickle: NodeJS.Timeout | undefined;
      try {
        const address = new URL(await handle.app.listen({ host: '127.0.0.1', port: 0 }));
        const slowSocket = net.connect(Number(address.port), address.hostname);
        socket = slowSocket;
        await new Promise<void>((resolve, reject) => {
          slowSocket.once('connect', resolve);
          slowSocket.once('error', reject);
        });
        slowSocket.write(
          'POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n',
        );
        trickle = setInterval(() => {
          if (!slowSocket.destroyed) slowSocket.write(' ');
        }, 100);

        await Promise.race([
          createApplicationClose(handle.app, 400)(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('shutdown stalled on a trickle')), 3_000)
              .unref();
          }),
        ]);
      } finally {
        if (trickle !== undefined) clearInterval(trickle);
        socket?.destroy();
        await handle.app.close();
        await handle.db.destroy();
      }
    },
    10_000,
  );
});
