import type { Server } from 'node:http';
import net from 'node:net';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import type { Database } from '../src/db/types.js';
import {
  DEFAULT_HTTP_CONNECTION_TIMEOUT_MS,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  HTTP_CONNECTION_TIMEOUT_ENV,
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
  test('defaults are bounded and configurable through the environment', async () => {
    expect(DEFAULT_HTTP_REQUEST_TIMEOUT_MS).toBeLessThan(15_000);
    expect(DEFAULT_HTTP_CONNECTION_TIMEOUT_MS).toBeLessThan(15_000);
    expect(httpTimeouts({})).toEqual({
      requestTimeoutMs: DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
      connectionTimeoutMs: DEFAULT_HTTP_CONNECTION_TIMEOUT_MS,
    });
    expect(() => httpTimeouts({ [HTTP_REQUEST_TIMEOUT_ENV]: '0' })).toThrow(
      'HTTP_REQUEST_TIMEOUT_MS must be a positive integer',
    );
    expect(() => httpTimeouts({ [HTTP_CONNECTION_TIMEOUT_ENV]: 'nope' })).toThrow(
      'HTTP_CONNECTION_TIMEOUT_MS must be a positive integer',
    );

    const handle = await buildTestApp({
      [HTTP_REQUEST_TIMEOUT_ENV]: '4321',
      [HTTP_CONNECTION_TIMEOUT_ENV]: '1234',
    });
    try {
      const server = handle.app.server as Server;
      expect(server.requestTimeout).toBe(4_321);
      // Fastify maps its `connectionTimeout` option onto `server.timeout`.
      expect(server.timeout).toBe(1_234);
    } finally {
      await handle.app.close();
      await handle.db.destroy();
    }
  });

  test(
    'a slow client cannot stall graceful shutdown',
    async () => {
      const handle = await buildTestApp({
        [HTTP_CONNECTION_TIMEOUT_ENV]: '300',
        [HTTP_REQUEST_TIMEOUT_ENV]: '300',
      });
      let socket: net.Socket | undefined;
      try {
        const address = new URL(await handle.app.listen({ host: '127.0.0.1', port: 0 }));
        const slowSocket = net.connect(Number(address.port), address.hostname);
        socket = slowSocket;
        await new Promise<void>((resolve, reject) => {
          slowSocket.once('connect', resolve);
          slowSocket.once('error', reject);
        });
        // Headers never finish, so the server can only release the socket via
        // its connection timeout; without it app.close() waits forever.
        slowSocket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Slow: ');

        await Promise.race([
          handle.app.close(),
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('app.close() stalled on a slow client')), 3_000)
              .unref();
          }),
        ]);
      } finally {
        socket?.destroy();
        await handle.app.close();
        await handle.db.destroy();
      }
    },
    10_000,
  );
});
