import pg from 'pg';
import {
  POOL_CONNECTION_TIMEOUT_MS,
  attachPoolErrorHandler,
  createDatabasePool,
  createShutdownController,
  parsePort,
} from '../src/main.js';
import { databaseUrl, hasDatabase } from './support/test-context.js';

const { Client } = pg;

function fakeLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe('main pool hardening', () => {
  test('the production pool sets connectionTimeoutMillis', async () => {
    const pool = createDatabasePool('postgres://ohmydate@127.0.0.1:55432/planner_test');
    try {
      const options = (pool as unknown as { options: { connectionTimeoutMillis?: number } })
        .options;
      expect(options.connectionTimeoutMillis).toBe(POOL_CONNECTION_TIMEOUT_MS);
      expect(POOL_CONNECTION_TIMEOUT_MS).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  describe.skipIf(!hasDatabase)('idle backend termination', () => {
    test('logs the pool error and keeps serving queries', async () => {
      const pool = createDatabasePool(databaseUrl as string);
      const errors: Error[] = [];
      attachPoolErrorHandler(pool, (error) => {
        errors.push(error);
      });
      const admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      try {
        const client = await pool.connect();
        const pid = (await client.query('select pg_backend_pid() as pid')).rows[0]
          .pid as number;
        client.release();

        await admin.query('select pg_terminate_backend($1)', [pid]);

        await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), { timeout: 5_000 });
        expect(errors[0]?.message).toMatch(/terminating connection|administrator/i);

        const result = await pool.query('select 1 as ok');
        expect(result.rows[0]).toEqual({ ok: 1 });
      } finally {
        await admin.end();
        await pool.end();
      }
    });
  });
});

describe('parsePort', () => {
  test('rejects values outside the TCP port range', () => {
    expect(() => parsePort('70000')).toThrow('PORT must be an integer');
    expect(() => parsePort('-1')).toThrow('PORT must be an integer');
    expect(parsePort(undefined)).toBe(3000);
  });
});

describe('shutdown controller', () => {
  test('ignores repeated signals while a graceful close is in progress', async () => {
    let release!: () => void;
    const closing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.fn(() => closing);
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const logger = fakeLogger();

    const shutdown = createShutdownController({
      logger,
      close,
      destroy,
      exit,
      deadlineMs: 1_000,
    });

    shutdown('SIGTERM');
    shutdown('SIGINT');
    shutdown('SIGTERM');

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      { signal: 'SIGINT' },
      'shutdown already in progress; ignoring signal',
    );

    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('exits 1 when the shutdown deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      const logger = fakeLogger();
      const exit = vi.fn();
      const shutdown = createShutdownController({
        logger,
        close: () => new Promise<void>(() => undefined),
        destroy: vi.fn(async () => undefined),
        exit,
        deadlineMs: 50,
      });

      shutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(51);

      expect(exit).toHaveBeenCalledWith(1);
      expect(logger.error).toHaveBeenCalledWith(
        { signal: 'SIGTERM', deadlineMs: 50 },
        'graceful shutdown timed out',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('still destroys the pool and exits 1 when close fails', async () => {
    const destroy = vi.fn(async () => undefined);
    const exit = vi.fn();
    const shutdown = createShutdownController({
      logger: fakeLogger(),
      close: vi.fn(async () => {
        throw new Error('close failed');
      }),
      destroy,
      exit,
      deadlineMs: 1_000,
    });

    shutdown('SIGTERM');

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
