import net from 'node:net';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import type { Database } from '../src/db/types.js';

const { Pool } = pg;

describe('/readyz database deadline', () => {
  test(
    'reports database=failed when PostgreSQL accepts TCP but never answers',
    async () => {
      const sockets = new Set<net.Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('test proxy did not bind a port');
      }

      const pool = new Pool({
        connectionString: `postgres://ohmydate:ohmydate-dev-only@127.0.0.1:${address.port}/planner_test`,
        connectionTimeoutMillis: 0,
      });
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
      const clock = new FakeClock();
      const ids = createSeededIdGenerator(7, clock);
      const repos = createInMemoryRepositories({ clock, ids });
      const app = await buildApp({
        config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'silent' }),
        repos,
        clock,
        ids,
        db,
        logger: false,
      });

      try {
        const startedAt = Date.now();
        const response = await app.inject({ method: 'GET', url: '/readyz' });
        const elapsedMs = Date.now() - startedAt;

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          status: 'unavailable',
          checks: { database: 'failed', vikunja: 'skipped' },
        });
        expect(elapsedMs).toBeGreaterThanOrEqual(2_000);
        expect(elapsedMs).toBeLessThan(6_000);
      } finally {
        await app.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.race([
          db.destroy(),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000).unref();
          }),
        ]);
      }
    },
    20_000,
  );
});
