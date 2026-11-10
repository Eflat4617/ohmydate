import { randomUUID } from 'node:crypto';
import type { Id, Instant, TaskChangePage, Version } from '@ohmydate/domain';
import type { ExternalMapping } from '@ohmydate/provider-vikunja';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { buildApp } from '../../src/app.js';
import { createConfig } from '../../src/config.js';
import pg from 'pg';
import { PgMappingStore } from '../../src/adapters/vikunja/pg-mapping-store.js';
import { listReconcilerOwnerIds } from '../../src/adapters/vikunja/owner-accounts.js';
import {
  createPgSessionLeaderLock,
  VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY,
  VikunjaReconciler,
} from '../../src/adapters/vikunja/reconciler.js';
import { requireDatabaseUrl } from '../db/helpers.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './pg-support.js';

const { Client } = pg;

describe.skipIf(!hasDatabase)('Vikunja background reconciler', () => {
  let store: PgTestStore;

  beforeEach(async () => {
    store = await createPgTestStore();
  });

  afterEach(async () => {
    await store.close();
  });

  // The production key is database-global. Parallel test workers share
  // planner_test, so each test isolates itself with its own advisory key.
  function uniqueLockKey(): number {
    return 6_000_000 + Math.floor(Math.random() * 1_000_000);
  }

  test('pins the production advisory-lock key', () => {
    expect(VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY).toBe(5_196_101);
  });

  function stubRepository() {
    const calls: string[] = [];
    return {
      calls,
      repository: {
        async listChangedSince(ownerId: Id): Promise<TaskChangePage> {
          calls.push(String(ownerId));
          return { changes: [], cursor: null };
        },
      },
    };
  }

  test('sweeps every owner through listChangedSince with a null cursor', async () => {
    const clock = new FakeClock();
    const { calls, repository } = stubRepository();
    const ownerA = randomUUID() as Id;
    const ownerB = randomUUID() as Id;
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [ownerA, ownerB],
      leaderLock: createPgSessionLeaderLock({
        connectionString: requireDatabaseUrl(),
        key: uniqueLockKey(),
      }),
      clock,
      intervalMs: 300_000,
    });

    expect(await reconciler.runOnce()).toBe(true);
    expect(calls).toEqual([String(ownerA), String(ownerB)]);
    expect(reconciler.lastRunAt).toBe(clock.now());

    clock.advance(300_000);
    expect(await reconciler.runOnce()).toBe(true);
    expect(calls).toEqual([
      String(ownerA),
      String(ownerB),
      String(ownerA),
      String(ownerB),
    ]);
    expect(reconciler.lastRunAt).toBe(clock.now());
  });

  test('skips the sweep while another session holds the advisory lock', async () => {
    const clock = new FakeClock();
    const { calls, repository } = stubRepository();
    const lockKey = uniqueLockKey();
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [randomUUID() as Id],
      leaderLock: createPgSessionLeaderLock({
        connectionString: requireDatabaseUrl(),
        key: lockKey,
      }),
      clock,
      intervalMs: 300_000,
    });

    const holder = new Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [lockKey]);
      expect(await reconciler.runOnce()).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [lockKey]);
      await holder.end();
    }

    expect(await reconciler.runOnce()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test('is stoppable and registers the configured interval', async () => {
    const clock = new FakeClock();
    const { repository } = stubRepository();
    const starts: Array<{ milliseconds: number; stopped: boolean }> = [];
    const state = { stopped: false };
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [],
      leaderLock: async () => true,
      clock,
      intervalMs: 123_456,
      scheduler: (_callback, milliseconds) => {
        const entry = { milliseconds, stopped: false };
        starts.push(entry);
        return {
          stop: () => {
            entry.stopped = true;
            state.stopped = true;
          },
        };
      },
    });

    reconciler.start();
    reconciler.start();
    expect(starts).toHaveLength(1);
    expect(starts[0]?.milliseconds).toBe(123_456);
    await reconciler.stop();
    expect(state.stopped).toBe(true);
    expect(starts[0]?.stopped).toBe(true);
  });

  test('scheduler callback runs a sweep and stop awaits an in-flight sweep', async () => {
    const clock = new FakeClock();
    const { calls, repository } = stubRepository();
    let scheduled: (() => void) | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [randomUUID() as Id],
      leaderLock: async (run) => {
        await gate;
        await run({ signal: new AbortController().signal, isLeader: async () => true });
        return true;
      },
      clock,
      intervalMs: 5_000,
      scheduler: (callback) => {
        scheduled = callback;
        return { stop: () => undefined };
      },
    });

    reconciler.start();
    scheduled?.();
    expect(await reconciler.runOnce()).toBe(false);
    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(calls).toHaveLength(1);
    expect(reconciler.lastRunAt).toBe(clock.now());
  });

  test('buildApp with default config does not start the reconciler', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(31, clock);
    const repos = createInMemoryRepositories({ clock, ids });
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const app = await buildApp({
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        logLevel: 'silent',
      }),
      repos,
      clock,
      ids,
      db: store.db,
      logger: false,
    });
    try {
      expect(app).toBeDefined();
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
      intervalSpy.mockRestore();
    }
  });

  test('buildApp with vikunja defaults starts the reconciler at five minutes', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(32, clock);
    const repos = createInMemoryRepositories({ clock, ids });
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const app = await buildApp({
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        databaseUrl: requireDatabaseUrl(),
        logLevel: 'silent',
      }),
      repos,
      clock,
      ids,
      db: store.db,
      logger: false,
      reconcileLockKey: uniqueLockKey(),
    });
    try {
      expect(app).toBeDefined();
      expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 300_000);
    } finally {
      await app.close();
      intervalSpy.mockRestore();
    }
  });

  test('buildApp memory provider never starts the reconciler even with a database URL', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(33, clock);
    const repos = createInMemoryRepositories({ clock, ids });
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    const app = await buildApp({
      config: createConfig({
        provider: 'memory',
        databaseUrl: requireDatabaseUrl(),
        logLevel: 'silent',
      }),
      repos,
      clock,
      ids,
      db: store.db,
      logger: false,
    });
    try {
      expect(app).toBeDefined();
      expect(intervalSpy).not.toHaveBeenCalled();
    } finally {
      await app.close();
      intervalSpy.mockRestore();
    }
  });

  test('owner list includes accounts and owners left with needs_reconcile mappings', async () => {
    const mappings = new PgMappingStore(store.db);
    const accountOwner = randomUUID() as Id;
    const reconcileOwner = randomUUID() as Id;
    await store.db
      .insertInto('vikunja_owner_account')
      .values({
        owner_id: accountOwner,
        vikunja_user_id: 7,
        token_secret_ref: 'env:VIKUNJA_TEST_TOKEN',
      })
      .execute();
    const mapping: ExternalMapping = {
      provider: 'vikunja',
      entityType: 'task',
      entityId: randomUUID() as Id,
      externalId: '9001',
      ownerId: reconcileOwner,
      localVersion: 1 as Version,
      createdAt: '2026-11-11T00:00:00.000Z' as Instant,
      updatedAt: '2026-11-11T00:00:00.000Z' as Instant,
      needsReconcile: true,
    };
    await mappings.put(mapping);

    expect([...(await listReconcilerOwnerIds(store.db))].sort()).toEqual(
      [accountOwner, reconcileOwner].sort(),
    );
  });

  test('releases the advisory lock when the sweep throws', async () => {
    const lockKey = uniqueLockKey();
    const lock = createPgSessionLeaderLock({
      connectionString: requireDatabaseUrl(),
      key: lockKey,
    });
    await expect(
      lock(async () => {
        throw new Error('sweep exploded');
      }),
    ).rejects.toThrow('sweep exploded');

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
  });

  test('lock backend loss mid-sweep logs, aborts the sweep and re-acquires next tick', async () => {
    const clock = new FakeClock();
    const ownerA = randomUUID() as Id;
    const ownerB = randomUUID() as Id;
    const calls: string[] = [];
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let abortResolve: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      abortResolve = resolve;
    });
    const logged: string[] = [];
    let blockFirstOwner = true;
    const repository = {
      async listChangedSince(ownerId: Id): Promise<TaskChangePage> {
        calls.push(String(ownerId));
        if (blockFirstOwner) {
          blockFirstOwner = false;
          startedResolve?.();
          await gate;
        }
        return { changes: [], cursor: null };
      },
    };
    const applicationName = `fu27-lock-${randomUUID()}`;
    const lockUrl = new URL(requireDatabaseUrl());
    lockUrl.searchParams.set('application_name', applicationName);
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [ownerA, ownerB],
      leaderLock: createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key: uniqueLockKey(),
        logger: {
          warn: (message) => logged.push(`warn:${message}`),
          error: (message) => {
            logged.push(`error:${message}`);
            abortResolve?.();
          },
        },
      }),
      clock,
      intervalMs: 300_000,
    });

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

    await aborted;
    releaseGate?.();
    expect(await run).toBe(false);
    expect(calls).toEqual([String(ownerA)]);
    expect(logged.some((entry) => entry.startsWith('error:'))).toBe(true);
    expect(reconciler.lastRunAt).toBeUndefined();

    calls.length = 0;
    expect(await reconciler.runOnce()).toBe(true);
    expect(calls).toEqual([String(ownerA), String(ownerB)]);
    expect(reconciler.lastRunAt).toBe(clock.now());
  });

  test('buildApp with interval > 0 starts the timer and close awaits the in-flight sweep', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(77, clock);
    const ownerId = randomUUID() as Id;
    await store.db
      .insertInto('vikunja_owner_account')
      .values({
        owner_id: ownerId,
        vikunja_user_id: 12,
        token_secret_ref: 'env:VIKUNJA_TEST_TOKEN',
      })
      .execute();
    const repos = createInMemoryRepositories({ clock, ids });
    let sweepStartedResolve: (() => void) | undefined;
    const sweepStarted = new Promise<void>((resolve) => {
      sweepStartedResolve = resolve;
    });
    let releaseSweep: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseSweep = resolve;
    });
    const sweep = vi.spyOn(repos.tasks, 'listChangedSince').mockImplementation(async () => {
      sweepStartedResolve?.();
      await gate;
      return { changes: [], cursor: null };
    });

    const app = await buildApp({
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: 'http://127.0.0.1:3456',
        databaseUrl: requireDatabaseUrl(),
        reconcileIntervalMs: 50,
        logLevel: 'silent',
      }),
      repos,
      clock,
      ids,
      db: store.db,
      logger: false,
      reconcileLockKey: uniqueLockKey(),
    });
    try {
      await app.ready();
      await sweepStarted;
      let closed = false;
      const closing = app.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(false);
      releaseSweep?.();
      await closing;
      expect(closed).toBe(true);
      expect(sweep).toHaveBeenCalled();
    } finally {
      sweep.mockRestore();
      await app.close().catch(() => undefined);
    }
  });

  test('buildApp rejects interval > 0 without a lock database URL', async () => {
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(78, clock);
    const repos = createInMemoryRepositories({ clock, ids });
    await expect(
      buildApp({
        config: createConfig({
          provider: 'vikunja',
          vikunjaUrl: 'http://127.0.0.1:3456',
          databaseUrl: null,
          reconcileIntervalMs: 1_000,
          logLevel: 'silent',
        }),
        repos,
        clock,
        ids,
        db: store.db,
        logger: false,
      }),
    ).rejects.toThrow(/DATABASE_URL is required/);
  });
});
