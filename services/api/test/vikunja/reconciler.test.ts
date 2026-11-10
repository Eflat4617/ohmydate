import { randomUUID } from 'node:crypto';
import type { Id, Instant, TaskChangePage, Version } from '@ohmydate/domain';
import type { ExternalMapping } from '@ohmydate/provider-vikunja';
import { FakeClock } from '@ohmydate/testkit';
import pg from 'pg';
import { PgMappingStore } from '../../src/adapters/vikunja/pg-mapping-store.js';
import { listReconcilerOwnerIds } from '../../src/adapters/vikunja/owner-accounts.js';
import {
  createPgAdvisoryLeaderLock,
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
      leaderLock: createPgAdvisoryLeaderLock(store.db),
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
      leaderLock: createPgAdvisoryLeaderLock(store.db),
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

  test('is stoppable and registers the configured interval', () => {
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
    reconciler.stop();
    expect(state.stopped).toBe(true);
    expect(starts[0]?.stopped).toBe(true);
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
