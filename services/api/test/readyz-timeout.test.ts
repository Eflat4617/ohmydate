import net from 'node:net';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { READYZ_DB_TIMEOUT_MS, buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import type { Database } from '../src/db/types.js';

const { Pool } = pg;

const flushTasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

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
        // Drive the request under fake setTimeout/clearTimeout only. Socket
        // I/O and Date stay real, so the PostgreSQL black hole still behaves
        // normally while the /readyz deadline becomes deterministic: the test
        // advances virtual time instead of racing the suite's wall clock, and
        // therefore cannot flake when the worker is starved under load.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        expect(READYZ_DB_TIMEOUT_MS).toBe(2_500);

        let settled = false;
        const pending = app.inject({ method: 'GET', url: '/readyz' });
        void pending.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        // Let the request handler run until it arms its single deadline timer.
        for (let i = 0; i < 10_000 && vi.getTimerCount() === 0; i += 1) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        expect(vi.getTimerCount()).toBe(1);

        // One virtual millisecond before the configured deadline the database
        // check must still be waiting on the black-holed connection.
        await vi.advanceTimersByTimeAsync(READYZ_DB_TIMEOUT_MS - 1);
        await flushTasks();
        expect(settled).toBe(false);

        // Advancing to exactly the deadline must abort the check and answer
        // 503. This proves the abort came from the readyz deadline itself, not
        // from a later request/pool timeout or a slow wall-clock measurement.
        await vi.advanceTimersByTimeAsync(1);
        const response = await pending;

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          status: 'unavailable',
          checks: { database: 'failed', vikunja: 'skipped' },
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
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
