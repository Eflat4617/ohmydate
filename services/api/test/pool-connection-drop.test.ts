import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { Kysely, PostgresDialect } from 'kysely';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import type { Database } from '../src/db/types.js';
import { attachPoolErrorHandler, createDatabasePool } from '../src/main.js';
import { startDropProxy, type DropProxy } from './support/drop-proxy.js';
import { databaseUrl, hasDatabase } from './support/test-context.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!hasDatabase)('checked-out pg client socket drop', () => {
  test(
    'logs the loss, answers 5xx and recovers once the network is restored',
    async () => {
      const proxy: DropProxy = await startDropProxy(databaseUrl as string);
      const pool = createDatabasePool(proxy.connectionString, {});
      const errors: Error[] = [];
      attachPoolErrorHandler(pool, (error) => errors.push(error));
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
      const clock = new FakeClock();
      const ids = createSeededIdGenerator(11, clock);
      const repos = createInMemoryRepositories({ clock, ids });
      const app: FastifyInstance = await buildApp({
        config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'silent' }),
        repos,
        clock,
        ids,
        db,
        logger: false,
      });

      try {
        // Establish one idle client so the next /readyz has to check it out.
        await pool.query('select 1');

        proxy.pause();
        const pending = app.inject({ method: 'GET', url: '/readyz' });
        await delay(200);

        // Abrupt socket loss on a checked-out client: no PostgreSQL FATAL.
        proxy.dropConnections();

        const response = await pending;
        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          status: 'unavailable',
          checks: { database: 'failed', vikunja: 'skipped' },
        });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.message).toMatch(/Connection terminated|socket hang up|ECONNRESET/);

        // The process is still alive: a restored network serves the next probe.
        proxy.resume();
        await vi.waitFor(
          async () => {
            const recovered = await app.inject({ method: 'GET', url: '/readyz' });
            expect(recovered.statusCode).toBe(200);
            expect(recovered.json().checks.database).toBe('ok');
          },
          { timeout: 5_000, interval: 100 },
        );
      } finally {
        proxy.resume();
        await app.close();
        await db.destroy();
        await proxy.close();
      }
    },
    30_000,
  );
});
