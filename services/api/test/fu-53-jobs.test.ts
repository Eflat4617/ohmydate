import { randomUUID } from 'node:crypto';
import type { Id, Instant } from '@ohmydate/domain';
import pg from 'pg';
import { PgExportStore } from '../src/adapters/pg-export-store.js';
import { PgNotificationStore } from '../src/adapters/pg-notification-store.js';
import {
  createPgSessionLeaderLock,
  type LeaderLock,
} from '../src/adapters/vikunja/reconciler.js';
import { ExportPurgeJob } from '../src/application/export-purge-job.js';
import {
  NotificationJob,
  type NotificationStore,
} from '../src/application/notification-service.js';
import {
  createTestContext,
  databaseUrl,
  hasDatabase,
  type TestContext,
} from './support/test-context.js';
import { seedActivePlan, seedAvailability, seedM4Task } from './support/m4-fixtures.js';

const { Client } = pg;

function uniqueLockKey(): number {
  return 6_000_000 + Math.floor(Math.random() * 1_000_000);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError ?? new Error('condition not met');
}

async function terminateBackend(applicationName: string): Promise<void> {
  const killer = new Client({ connectionString: databaseUrl as string });
  await killer.connect();
  try {
    const deadline = Date.now() + 5_000;
    let terminated = false;
    while (!terminated && Date.now() < deadline) {
      const result = await killer.query<{ terminated: boolean }>(
        `SELECT pg_terminate_backend(pid) AS terminated
           FROM pg_stat_activity
          WHERE application_name = $1 AND pid <> pg_backend_pid()`,
        [applicationName],
      );
      terminated = result.rows.some((row) => row.terminated);
      if (!terminated) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!terminated) throw new Error(`lock backend ${applicationName} not found`);
  } finally {
    await killer.end().catch(() => undefined);
  }
}

async function setup(ctx: TestContext): Promise<{ ownerId: Id; taskId: Id; blockId: Id }> {
  const ownerId = await ctx.seedUser({ email: `jobs-${randomUUID()}@example.com`, password: 'correct-horse' });
  ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
  await seedAvailability(ctx, ownerId);
  const seeded = await seedM4Task(ctx, ownerId, { title: 'Job task' });
  const plan = await seedActivePlan(ctx, ownerId, seeded.task.id, {
    horizonStart: '2026-11-12T00:00:00Z',
    horizonEnd: '2026-11-15T00:00:00Z',
    blockStart: '2026-11-12T08:05:00Z',
    blockEnd: '2026-11-12T09:05:00Z',
  });
  return { ownerId, taskId: seeded.task.id, blockId: plan.blockId };
}

describe.skipIf(!hasDatabase)('FU-53 leader-only jobs', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('NotificationJob: acquire/probe, two instances -> one leader, release re-acquires, lose stops the run', async () => {
    const fixture = await setup(ctx);
    const real = new PgNotificationStore({ db: ctx.db, ids: ctx.ids });
    const entered = deferred();
    const release = deferred();
    const runs: string[] = [];
    const store: NotificationStore = {
      runUpcoming: async (now) => {
        runs.push('run');
        entered.resolve();
        await release.promise;
        return real.runUpcoming(now);
      },
      list: (ownerId, query) => real.list(ownerId, query),
      get: (ownerId, id) => real.get(ownerId, id),
      dismiss: (ownerId, id, expectedVersion, now) => real.dismiss(ownerId, id, expectedVersion, now),
    };

    const key = uniqueLockKey();
    let probes = 0;
    const probeLock = (connectionString: string): LeaderLock => {
      const lock = createPgSessionLeaderLock({ connectionString, key });
      return (run) =>
        lock(async (lease) =>
          run({
            signal: lease.signal,
            isLeader: async () => {
              probes += 1;
              return lease.isLeader();
            },
          }),
        );
    };

    const jobA = new NotificationJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: probeLock(databaseUrl as string),
    });
    const jobB = new NotificationJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: databaseUrl as string,
        key,
      }),
    });

    const running = jobA.runOnce();
    await entered.promise;

    // A holds the lock: B cannot acquire it and performs no sweep.
    expect(await jobB.runOnce()).toBe(false);
    expect(runs).toHaveLength(1);

    release.resolve();
    expect(await running).toBe(true);
    expect(probes).toBeGreaterThanOrEqual(1);

    // A released the lock: B acquires it and runs (dedupe keeps one row).
    expect(await jobB.runOnce()).toBe(true);
    expect(runs).toHaveLength(2);
    const rows = await ctx.db
      .selectFrom('notification')
      .select('id')
      .where('owner_id', '=', fixture.ownerId)
      .execute();
    expect(rows).toHaveLength(1);

    // Lose: terminate the backend holding the lock while the sweep is in
    // flight; the run reports false even though the store call completes.
    const applicationName = `fu53-notify-${randomUUID()}`;
    const lockUrl = new URL(databaseUrl as string);
    lockUrl.searchParams.set('application_name', applicationName);
    const lost = deferred();
    const resume = deferred();
    const loseJob = new NotificationJob({
      store: {
        ...store,
        runUpcoming: async (now) => {
          lost.resolve();
          await resume.promise;
          return real.runUpcoming(now);
        },
      },
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: lockUrl.toString(),
        key,
      }),
    });
    const losing = loseJob.runOnce();
    await lost.promise;
    await terminateBackend(applicationName);
    resume.resolve();
    expect(await losing).toBe(false);

    // The advisory session lock is free again after the terminated connection.
    const replacement = new NotificationJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: databaseUrl as string,
        key,
      }),
    });
    expect(await replacement.runOnce()).toBe(true);
  });

  test('ExportPurgeJob: two instances -> one leader, then the released leader purges', async () => {
    const fixture = await setup(ctx);
    const real = new PgExportStore({ db: ctx.db, clock: ctx.clock });
    const id = ctx.ids.next();
    const now = ctx.clock.now();
    await real.createQueued(fixture.ownerId, id, now);
    await real.markRunning(fixture.ownerId, id, now);
    await real.saveReady(
      fixture.ownerId,
      id,
      Buffer.from('{"format":"ohmydate-export"}'),
      now,
      '2026-11-12T07:00:00Z' as Instant,
    );

    const entered = deferred();
    const release = deferred();
    const runs: string[] = [];
    const store = {
      purgeExpired: async (at: Instant) => {
        runs.push('purge');
        entered.resolve();
        await release.promise;
        return real.purgeExpired(at);
      },
    };

    const key = uniqueLockKey();
    const jobA = new ExportPurgeJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: databaseUrl as string,
        key,
      }),
    });
    const jobB = new ExportPurgeJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: databaseUrl as string,
        key,
      }),
    });

    const running = jobA.runOnce();
    await entered.promise;
    expect(await jobB.runOnce()).toBe(false);
    expect(runs).toHaveLength(1);

    release.resolve();
    expect(await running).toBe(true);
    expect(await jobB.runOnce()).toBe(true);
    expect(runs).toHaveLength(2);

    const row = await ctx.db
      .selectFrom('export_job')
      .select(['artifact'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.artifact).toBeNull();
  });

  test('ExportPurgeJob: lost leadership makes the run a no-op and the next leader takes over', async () => {
    const fixture = await setup(ctx);
    const real = new PgExportStore({ db: ctx.db, clock: ctx.clock });
    const id = ctx.ids.next();
    const now = ctx.clock.now();
    await real.createQueued(fixture.ownerId, id, now);
    await real.markRunning(fixture.ownerId, id, now);
    await real.saveReady(
      fixture.ownerId,
      id,
      Buffer.from('{"format":"ohmydate-export"}'),
      now,
      '2026-11-12T07:00:00Z' as Instant,
    );

    const runs: string[] = [];
    const store = {
      purgeExpired: async (at: Instant) => {
        runs.push('purge');
        return real.purgeExpired(at);
      },
    };
    const applicationName = `fu53-purge-${randomUUID()}`;
    const lockUrl = new URL(databaseUrl as string);
    lockUrl.searchParams.set('application_name', applicationName);
    const key = uniqueLockKey();
    const realLock = createPgSessionLeaderLock({
      connectionString: lockUrl.toString(),
      key,
    });
    const probeEntered = deferred();
    const releaseProbe = deferred();
    let probes = 0;
    const gatedLock: LeaderLock = (run) =>
      realLock(async (lease) =>
        run({
          signal: lease.signal,
          isLeader: async () => {
            probes += 1;
            if (probes === 1) {
              probeEntered.resolve();
              await releaseProbe.promise;
            }
            return lease.isLeader();
          },
        }),
      );

    const job = new ExportPurgeJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: gatedLock,
    });
    const running = job.runOnce();
    await probeEntered.promise;
    // Gate is reached: the lock is held, so terminating its backend is a real
    // leadership loss, not a timing race. The probe below then fails.
    await terminateBackend(applicationName);
    releaseProbe.resolve();
    expect(await running).toBe(false);
    expect(runs).toEqual([]);
    const beforeTakeover = await ctx.db
      .selectFrom('export_job')
      .select('artifact')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(beforeTakeover.artifact).not.toBeNull();

    const replacement = new ExportPurgeJob({
      store,
      clock: ctx.clock,
      intervalMs: 60_000,
      leaderLock: createPgSessionLeaderLock({
        connectionString: databaseUrl as string,
        key,
      }),
    });
    expect(await replacement.runOnce()).toBe(true);
    expect(runs).toEqual(['purge']);
    const afterTakeover = await ctx.db
      .selectFrom('export_job')
      .select('artifact')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(afterTakeover.artifact).toBeNull();
  });

  test('memory provider wires the notification and purge jobs (no leader lock)', async () => {
    const scheduled: Array<{ callback: () => void; milliseconds: number }> = [];
    const memoryCtx = await createTestContext({
      jobOverrides: {
        notificationIntervalMs: 1_000,
        exportPurgeIntervalMs: 1_000,
        scheduler: (callback, milliseconds) => {
          scheduled.push({ callback, milliseconds });
          return { stop: () => undefined };
        },
      },
    });
    try {
      const ownerId = await memoryCtx.seedUser({
        email: `memory-jobs-${randomUUID()}@example.com`,
        password: 'correct-horse',
      });
      memoryCtx.clock.set('2026-11-12T08:00:00Z' as Instant);
      await seedAvailability(memoryCtx, ownerId);
      const seeded = await seedM4Task(memoryCtx, ownerId, { title: 'Memory job' });
      await seedActivePlan(memoryCtx, ownerId, seeded.task.id, {
        horizonStart: '2026-11-12T00:00:00Z',
        horizonEnd: '2026-11-15T00:00:00Z',
        blockStart: '2026-11-12T08:05:00Z',
        blockEnd: '2026-11-12T09:05:00Z',
      });
      const exportStore = new PgExportStore({ db: memoryCtx.db, clock: memoryCtx.clock });
      const exportId = memoryCtx.ids.next();
      const now = memoryCtx.clock.now();
      await exportStore.createQueued(ownerId, exportId, now);
      await exportStore.markRunning(ownerId, exportId, now);
      await exportStore.saveReady(
        ownerId,
        exportId,
        Buffer.from('{}'),
        now,
        '2026-11-12T07:00:00Z' as Instant,
      );

      expect(scheduled).toHaveLength(2);
      for (const entry of scheduled) entry.callback();

      await eventually(async () => {
        const rows = await memoryCtx.db
          .selectFrom('notification')
          .select('id')
          .where('owner_id', '=', ownerId)
          .execute();
        expect(rows).toHaveLength(1);
        const artifact = await memoryCtx.db
          .selectFrom('export_job')
          .select('artifact')
          .where('id', '=', exportId)
          .executeTakeFirstOrThrow();
        expect(artifact.artifact).toBeNull();
      });
    } finally {
      await memoryCtx.close();
    }
  });
});
