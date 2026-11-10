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
import { startBlackholeProxy } from './tcp-proxy.js';

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
});
