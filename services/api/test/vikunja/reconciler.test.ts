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
      leaderLock: createPgSessionLeaderLock({ connectionString: requireDatabaseUrl() }),
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
    const reconciler = new VikunjaReconciler({
      taskRepository: repository,
      ownerIds: async () => [randomUUID() as Id],
      leaderLock: createPgSessionLeaderLock({ connectionString: requireDatabaseUrl() }),
      clock,
      intervalMs: 300_000,
    });

    const holder = new Client({ connectionString: requireDatabaseUrl() });
    await holder.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(${VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY})`);
      expect(await reconciler.runOnce()).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY})`);
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
        await run();
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
});
