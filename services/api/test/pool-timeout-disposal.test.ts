import { Kysely, PostgresDialect, sql } from 'kysely';
import { attachPoolErrorHandler, createDatabasePool } from '../src/main.js';
import type { Database } from '../src/db/types.js';
import { startDropProxy, type DropProxy } from './support/drop-proxy.js';
import { databaseUrl, hasDatabase } from './support/test-context.js';

describe.skipIf(!hasDatabase)('client-side query timeout disposal', () => {
  test(
    'a timed-out client is destroyed and the next query gets a usable connection',
    async () => {
      const proxy: DropProxy = await startDropProxy(databaseUrl as string);
      const pool = createDatabasePool(proxy.connectionString, { PG_QUERY_TIMEOUT_MS: '400' });
      // Kysely releases a failed connection without an error, so pool capacity
      // one makes the blocked-client reuse explicit (FU-37R finding 1).
      pool.options.max = 1;
      attachPoolErrorHandler(pool, () => undefined);
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

      try {
        const first = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        const firstPid = first.rows[0]?.pid;
        expect(typeof firstPid).toBe('number');

        // Hold the connection past the 400 ms client-side deadline. The proxy
        // drops the bytes, so the server never sees or replies to this query.
        proxy.pause();
        const startedAt = Date.now();
        await expect(sql`select 1`.execute(db)).rejects.toThrow('Query read timeout');
        expect(Date.now() - startedAt).toBeLessThan(5_000);

        // The timed-out client must not be reused: after the network is back,
        // the next query has to come from a fresh PostgreSQL backend.
        proxy.resume();
        const second = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        expect(second.rows[0]?.pid).not.toBe(firstPid);
      } finally {
        proxy.resume();
        await db.destroy();
        await proxy.close();
      }
    },
    30_000,
  );

  test(
    'a server-side statement_timeout keeps the connection reusable',
    async () => {
      const pool = createDatabasePool(databaseUrl as string, {
        PG_STATEMENT_TIMEOUT_MS: '200',
        PG_QUERY_TIMEOUT_MS: '5000',
      });
      pool.options.max = 1;
      attachPoolErrorHandler(pool, () => undefined);
      const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

      try {
        const first = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        const firstPid = first.rows[0]?.pid;

        await expect(sql`select pg_sleep(1)`.execute(db)).rejects.toThrow(
          /statement timeout|canceling statement/i,
        );

        // The server cancelled and resynchronised the protocol; unlike a
        // client-side deadline the same backend remains usable.
        const second = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
        expect(second.rows[0]?.pid).toBe(firstPid);
      } finally {
        await db.destroy();
      }
    },
    30_000,
  );
});
