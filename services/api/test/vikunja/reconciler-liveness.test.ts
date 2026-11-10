import { randomUUID } from 'node:crypto';
import type { Id, TaskChangePage } from '@ohmydate/domain';
import { FakeClock } from '@ohmydate/testkit';
import pg from 'pg';
import {
  createPgSessionLeaderLock,
  VikunjaReconciler,
} from '../../src/adapters/vikunja/reconciler.js';
import { requireDatabaseUrl } from '../db/helpers.js';
import { hasDatabase } from './pg-support.js';
import { startBlackholeProxy, startSilentProxy } from './tcp-proxy.js';

const { Client } = pg;

function uniqueLockKey(): number {
  return 7_000_000 + Math.floor(Math.random() * 1_000_000);
}

describe.skipIf(!hasDatabase)('Vikunja reconciler leadership liveness', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('silent lock loss stops the sweep at the next active leadership probe', async () => {
    const proxy = await startBlackholeProxy(requireDatabaseUrl());
    const clock = new FakeClock();
    const ownerA = randomUUID() as Id;
    const ownerB = randomUUID() as Id;
    const calls: string[] = [];
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let releaseResolve: (() => void) | undefined;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    let firstOwner = true;
    const logged: string[] = [];
    const applicationName = `fu28-silent-${randomUUID()}`;
    const lockUrl = new URL(proxy.connectionString);
    lockUrl.searchParams.set('application_name', applicationName);
    const lockKey = uniqueLockKey();

    const reconciler = new VikunjaReconciler({
      taskRepository: {
        async listChangedSince(ownerId: Id): Promise<TaskChangePage> {
          calls.push(String(ownerId));
          if (firstOwner) {
            firstOwner = false;
            startedResolve?.();
            await release;
          }
          return { changes: [], cursor: null };
        },
      },
      ownerIds: async () => [ownerA, ownerB],
      leaderLock: createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key: lockKey,
        queryTimeoutMs: 150,
        logger: {
          warn: (message) => logged.push(`warn:${message}`),
          error: (message) => logged.push(`error:${message}`),
        },
      }),
      clock,
      intervalMs: 300_000,
    });

    try {
      const run = reconciler.runOnce();
      await started;

      const watcher = new Client({ connectionString: requireDatabaseUrl() });
      await watcher.connect();
      let lockPid: number | undefined;
      try {
        for (let attempt = 0; attempt < 100 && lockPid === undefined; attempt += 1) {
          const result = await watcher.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
              WHERE application_name = $1 AND pid <> pg_backend_pid()`,
            [applicationName],
          );
          lockPid = result.rows[0]?.pid;
          if (lockPid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } finally {
        await watcher.end();
      }
      if (lockPid === undefined) throw new Error('lock backend not found');

      // Partition the lock socket first, then kill the server session. The
      // client sees no 'error'/'end', so only the active probe can notice.
      proxy.blackhole();
      const terminator = new Client({ connectionString: requireDatabaseUrl() });
      await terminator.connect();
      try {
        const result = await terminator.query<{ terminated: boolean }>(
          'SELECT pg_terminate_backend($1) AS terminated',
          [lockPid],
        );
        expect(result.rows[0]?.terminated).toBe(true);
      } finally {
        await terminator.end();
      }

      releaseResolve?.();
      const finishing = Date.now();
      expect(await run).toBe(false);
      const elapsed = Date.now() - finishing;

      expect(elapsed).toBeLessThan(3_000);
      expect(calls).toEqual([String(ownerA)]);
      expect(reconciler.lastRunAt).toBeUndefined();
      expect(logged.filter((entry) => entry.startsWith('error:'))).toHaveLength(1);

      // The server-side session is gone, so the advisory lock is free even
      // though A's socket is still blackholed.
      const holder = new Client({ connectionString: requireDatabaseUrl() });
      await holder.connect();
      try {
        const acquired = await holder.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [lockKey],
        );
        expect(acquired.rows[0]?.locked).toBe(true);
      } finally {
        await holder
          .query('SELECT pg_advisory_unlock($1)', [lockKey])
          .catch(() => undefined);
        await holder.end();
      }
    } finally {
      await proxy.close();
    }
  });

  test('unlock is bounded by the query timeout after a silent partition', async () => {
    const proxy = await startBlackholeProxy(requireDatabaseUrl());
    const logged: string[] = [];
    const lock = createPgSessionLeaderLock({
      connectionString: proxy.connectionString,
      key: uniqueLockKey(),
      queryTimeoutMs: 150,
      logger: {
        warn: (message) => logged.push(`warn:${message}`),
        error: (message) => logged.push(`error:${message}`),
      },
    });

    try {
      const started = Date.now();
      const result = await lock(async ({ isLeader }) => {
        expect(await isLeader()).toBe(true);
        proxy.blackhole();
      });
      const elapsed = Date.now() - started;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(3_000);
      expect(logged.some((entry) => entry.startsWith('warn:vikunja leader lock unlock failed'))).toBe(
        true,
      );
    } finally {
      await proxy.close();
    }
  });

  test('leadership lost on the last owner does not advance lastRunAt', async () => {
    const clock = new FakeClock();
    const calls: string[] = [];
    let probes = 0;
    const reconciler = new VikunjaReconciler({
      taskRepository: {
        async listChangedSince(ownerId: Id): Promise<TaskChangePage> {
          calls.push(String(ownerId));
          return { changes: [], cursor: null };
        },
      },
      ownerIds: async () => [randomUUID() as Id],
      leaderLock: async (run) => {
        const controller = new AbortController();
        await run({
          signal: controller.signal,
          isLeader: async () => {
            probes += 1;
            // First probe passes (before the owner); the post-loop probe loses
            // leadership, which is "during" the last owner's completion window.
            if (probes >= 2) {
              controller.abort(new Error('leadership lost after last owner'));
              return false;
            }
            return true;
          },
        });
        return !controller.signal.aborted;
      },
      clock,
      intervalMs: 300_000,
    });

    expect(await reconciler.runOnce()).toBe(false);
    expect(calls).toHaveLength(1);
    expect(reconciler.lastRunAt).toBeUndefined();
  });

  test('lock connect is bounded by the query timeout when the server never answers', async () => {
    const proxy = await startSilentProxy(requireDatabaseUrl());
    const logged: string[] = [];
    const lock = createPgSessionLeaderLock({
      connectionString: proxy.connectionString,
      key: uniqueLockKey(),
      queryTimeoutMs: 200,
      logger: {
        warn: (message) => logged.push(`warn:${message}`),
        error: (message) => logged.push(`error:${message}`),
      },
    });

    try {
      const started = Date.now();
      let ran = false;
      await expect(
        lock(async () => {
          ran = true;
        }),
      ).rejects.toThrow(/timeout expired/);
      const elapsed = Date.now() - started;

      expect(ran).toBe(false);
      expect(elapsed).toBeLessThan(3_000);
      // No sweep started, so a failed connect must not claim to abort one.
      expect(logged).toEqual([]);
    } finally {
      await proxy.close();
    }
  });

  test('lock session requests server keepalives through startup options', async () => {
    const applicationName = `fu33-keepalive-${randomUUID()}`;
    const lockUrl = new URL(requireDatabaseUrl());
    lockUrl.searchParams.set('application_name', applicationName);
    const seen: string[] = [];
    const originalQuery = pg.Client.prototype.query as unknown as (
      this: pg.Client,
      text: string,
    ) => Promise<{ rows: Array<Record<string, string>> }>;
    pg.Client.prototype.query = async function (
      this: pg.Client,
      ...args: unknown[]
    ): Promise<unknown> {
      const parameters = (
        this as unknown as { connectionParameters?: { application_name?: string } }
      ).connectionParameters;
      if (
        parameters?.application_name === applicationName &&
        typeof args[0] === 'string' &&
        args[0].includes('pg_try_advisory_lock')
      ) {
        const shown = await originalQuery.call(this, 'SHOW tcp_keepalives_idle');
        seen.push(shown.rows[0]?.tcp_keepalives_idle ?? 'missing');
      }
      return (originalQuery as unknown as (...args: unknown[]) => unknown).apply(this, args);
    } as unknown as typeof pg.Client.prototype.query;
    try {
      const defaults = createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key: uniqueLockKey(),
      });
      expect(await defaults(async () => undefined)).toBe(true);
      expect(seen).toEqual(['30']);

      seen.length = 0;
      const custom = createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key: uniqueLockKey(),
        serverKeepalives: { idleSeconds: 45, intervalSeconds: 7, count: 2 },
      });
      expect(await custom(async () => undefined)).toBe(true);
      expect(seen).toEqual(['45']);
    } finally {
      pg.Client.prototype.query = originalQuery as unknown as typeof pg.Client.prototype.query;
    }
  });

  test('a server FATAL during end() after a completed sweep is not uncaught', async () => {
    const outcome = await withTerminationDuringEnd(async (applicationName) => {
      const lockUrl = new URL(requireDatabaseUrl());
      lockUrl.searchParams.set('application_name', applicationName);
      const lock = createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key: uniqueLockKey(),
      });
      let ran = false;
      const result = await lock(async () => {
        ran = true;
      });
      return { result, ran };
    });
    expect(outcome.result.result).toBe(true);
    expect(outcome.result.ran).toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  test('a server FATAL during end() on the non-leader path is not uncaught', async () => {
    const lockKey = uniqueLockKey();
    const holder = new Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [lockKey]);
    try {
      const outcome = await withTerminationDuringEnd(async (applicationName) => {
        const lockUrl = new URL(requireDatabaseUrl());
        lockUrl.searchParams.set('application_name', applicationName);
        const lock = createPgSessionLeaderLock({
          connectionString: lockUrl.toString(),
          key: lockKey,
        });
        let ran = false;
        const result = await lock(async () => {
          ran = true;
        });
        return { result, ran };
      });
      expect(outcome.result.result).toBe(false);
      expect(outcome.result.ran).toBe(false);
      expect(outcome.errors).toEqual([]);
    } finally {
      await holder
        .query('SELECT pg_advisory_unlock($1)', [lockKey])
        .catch(() => undefined);
      await holder.end();
    }
  });
});

async function terminateBackend(applicationName: string): Promise<void> {
  const killer = new Client({ connectionString: requireDatabaseUrl() });
  await killer.connect();
  try {
    await killer.query(
      `SELECT pg_terminate_backend(pid) AS terminated
         FROM pg_stat_activity
        WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [applicationName],
    );
  } finally {
    await killer.end().catch(() => undefined);
  }
}

/**
 * Runs `scenario` with pg Client.end() patched so the lock session's backend is
 * terminated ~300 ms before `end()` completes: the window where a FATAL error
 * event arrives with no active query. Returns the scenario result plus any
 * uncaught exception seen while the window is open.
 */
async function withTerminationDuringEnd<T>(
  scenario: (applicationName: string) => Promise<T>,
): Promise<{ result: T; errors: unknown[] }> {
  const applicationName = `fu33-end-${randomUUID()}`;
  const errors: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    errors.push(error);
  };
  const originalEnd = pg.Client.prototype.end as unknown as (
    this: pg.Client,
    callback?: (error: Error) => void,
  ) => Promise<void> | void;
  let terminated = false;
  pg.Client.prototype.end = function (this: pg.Client, callback?: (error: Error) => void) {
    const parameters = (this as unknown as { connectionParameters?: { application_name?: string } })
      .connectionParameters;
    if (parameters?.application_name !== applicationName) {
      return callback === undefined ? originalEnd.call(this) : originalEnd.call(this, callback);
    }
    const finish = async (): Promise<void> => {
      if (!terminated) {
        terminated = true;
        await terminateBackend(applicationName);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      if (callback === undefined) {
        await originalEnd.call(this);
      } else {
        originalEnd.call(this, callback);
      }
    };
    return finish();
  } as unknown as typeof pg.Client.prototype.end;
  process.on('uncaughtException', onUncaught);
  try {
    const result = await scenario(applicationName);
    // Give a late FATAL a chance to surface before we stop listening.
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { result, errors };
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    pg.Client.prototype.end = originalEnd as unknown as typeof pg.Client.prototype.end;
  }
}
