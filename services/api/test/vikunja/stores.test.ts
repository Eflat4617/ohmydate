import { randomUUID } from 'node:crypto';
import { VersionConflictError, type Id, type Instant, type Version } from '@ohmydate/domain';
import type { ExternalMapping, JournalAppend } from '@ohmydate/provider-vikunja';
import { FakeClock } from '@ohmydate/testkit';
import { PgChangeJournalStore } from '../../src/adapters/vikunja/pg-change-journal-store.js';
import { PgMappingStore } from '../../src/adapters/vikunja/pg-mapping-store.js';
import { PgPlannerFieldStore } from '../../src/adapters/vikunja/pg-planner-field-store.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './pg-support.js';

function mappingFor(
  overrides: Partial<ExternalMapping> & {
    ownerId: Id;
    entityType: 'task' | 'project';
    entityId: Id;
    externalId: string;
  },
): ExternalMapping {
  const clockNow = '2026-11-11T00:00:00.000Z' as Instant;
  return {
    provider: 'vikunja',
    localVersion: 1 as Version,
    createdAt: clockNow,
    updatedAt: clockNow,
    ...overrides,
  };
}

describe.skipIf(!hasDatabase)('durable Vikunja stores (PostgreSQL)', () => {
  let store: PgTestStore;

  beforeEach(async () => {
    store = await createPgTestStore();
  });

  afterEach(async () => {
    await store.close();
  });

  test('round-trips every mapping field and enforces the global 1:1 unique', async () => {
    const mappings = new PgMappingStore(store.db);
    const ownerId = randomUUID() as Id;
    const entityId = randomUUID() as Id;
    const mapping = mappingFor({
      ownerId,
      entityType: 'task',
      entityId,
      externalId: '42',
      externalEtag: 'etag-1',
      externalUpdatedAt: '2026-11-11T01:02:03.000Z' as Instant,
      localVersion: 3 as Version,
      contentFingerprint: 'fingerprint-1',
      needsReconcile: true,
      pendingCompletion: {
        expectedVersion: 2 as Version,
        at: '2026-11-11T01:00:00.000Z' as Instant,
        dueAtBefore: '2026-11-10T09:00:00.000Z' as Instant,
      },
    });

    await mappings.put(mapping);
    expect(await mappings.get('task', entityId)).toEqual(mapping);
    expect(await mappings.getByExternal('vikunja', 'task', '42')).toEqual(mapping);
    expect(await mappings.listByOwner(ownerId)).toEqual([mapping]);

    const deletedAt = '2026-11-11T02:00:00.000Z' as Instant;
    // Omitted optional fields must clear the old columns.
    await mappings.put({
      provider: 'vikunja',
      entityType: mapping.entityType,
      entityId: mapping.entityId,
      externalId: mapping.externalId,
      ownerId: mapping.ownerId,
      localVersion: 4 as Version,
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
      deletedAt,
    });
    const stored = await mappings.get('task', entityId);
    expect(stored?.externalEtag).toBeUndefined();
    expect(stored?.externalUpdatedAt).toBeUndefined();
    expect(stored?.contentFingerprint).toBeUndefined();
    expect(stored?.pendingCompletion).toBeUndefined();
    expect(stored?.needsReconcile).toBeUndefined();
    expect(stored?.deletedAt).toBe(deletedAt);

    // FU-22 optimistic precondition: a stale expected version cannot overwrite.
    const bumped: ExternalMapping = {
      provider: 'vikunja',
      entityType: mapping.entityType,
      entityId: mapping.entityId,
      externalId: mapping.externalId,
      ownerId: mapping.ownerId,
      localVersion: 5 as Version,
      createdAt: mapping.createdAt,
      updatedAt: '2026-11-11T03:00:00.000Z' as Instant,
    };
    await expect(
      mappings.put(bumped, { expectedLocalVersion: 3 as Version }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await mappings.get('task', entityId))?.localVersion).toBe(4);
    await mappings.put(bumped, { expectedLocalVersion: 4 as Version });
    expect((await mappings.get('task', entityId))?.localVersion).toBe(5);
    await expect(
      mappings.put(bumped, { expectedLocalVersion: 4 as Version }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    await expect(
      mappings.put(
        mappingFor({
          ownerId,
          entityType: 'task',
          entityId: randomUUID() as Id,
          externalId: '42',
        }),
      ),
    ).rejects.toThrow(/vikunja_mapping_external_unique/);
  });

  test('stores planner-only fields and resolves the owner from the task mapping', async () => {
    const mappings = new PgMappingStore(store.db);
    const plannerFields = new PgPlannerFieldStore(store.db);
    const ownerId = randomUUID() as Id;
    const taskId = randomUUID() as Id;
    await mappings.put(
      mappingFor({ ownerId, entityType: 'task', entityId: taskId, externalId: '7' }),
    );

    expect(await plannerFields.getTask(taskId)).toBeNull();
    const fields = {
      splittable: true,
      priority: 3 as const,
      status: 'in_progress' as const,
      dependsOn: [randomUUID() as Id],
      session: { minMinutes: 15, maxMinutes: 45 },
    };
    await plannerFields.putTask(taskId, fields);
    expect(await plannerFields.getTask(taskId)).toEqual(fields);

    const updated = { ...fields, splittable: false, status: 'todo' as const };
    await plannerFields.putTask(taskId, updated);
    expect(await plannerFields.getTask(taskId)).toEqual(updated);

    const row = await store.db
      .selectFrom('vikunja_planner_fields')
      .select(['owner_id', 'fields'])
      .where('task_id', '=', taskId)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(ownerId);

    await expect(
      plannerFields.putTask(randomUUID() as Id, {
        splittable: false,
        priority: 2,
        status: 'todo',
        dependsOn: [],
      }),
    ).rejects.toThrow(/unmapped task/);
  });

  test('keeps the journal epoch across store restarts and appends atomically', async () => {
    const journal = new PgChangeJournalStore(store.db);
    const restarted = new PgChangeJournalStore(store.db);
    const epoch = await journal.epoch();
    expect(await restarted.epoch()).toBe(epoch);

    const clock = new FakeClock();
    const ownerId = randomUUID() as Id;
    const first = await journal.append({
      ownerId,
      taskId: randomUUID() as Id,
      externalId: '11',
      version: 1 as Version,
      at: clock.now(),
    });
    clock.advance(1_000);
    const second = await journal.append({
      ownerId,
      taskId: randomUUID() as Id,
      externalId: '12',
      version: 1 as Version,
      at: clock.now(),
      deletedAt: clock.now(),
    });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(await journal.head(ownerId)).toBe(2);
    expect((await journal.readAfter(ownerId, 0)).map((entry) => entry.sequence)).toEqual([1, 2]);
    expect((await journal.readAfter(ownerId, 1)).map((entry) => entry.sequence)).toEqual([2]);
    expect(await journal.head(randomUUID() as Id)).toBe(0);
    expect(await journal.hasSnapshot(ownerId)).toBe(false);
  });

  test('appends a snapshot exactly once per owner and epoch under concurrency', async () => {
    const journal = new PgChangeJournalStore(store.db);
    const ownerId = randomUUID() as Id;
    const clock = new FakeClock();
    const entries: JournalAppend[] = [
      {
        ownerId,
        taskId: randomUUID() as Id,
        externalId: '100',
        version: 2 as Version,
        at: clock.now(),
      },
      {
        ownerId,
        taskId: randomUUID() as Id,
        externalId: '101',
        version: 1 as Version,
        at: clock.now(),
        deletedAt: clock.now(),
      },
    ];

    const [left, right] = await Promise.all([
      journal.appendSnapshotOnce(ownerId, entries),
      journal.appendSnapshotOnce(ownerId, entries),
    ]);
    const inserted = [...left, ...right];
    expect(inserted).toHaveLength(2);
    expect(inserted.map((entry) => entry.sequence).sort()).toEqual([1, 2]);
    expect(await journal.hasSnapshot(ownerId)).toBe(true);
    expect(await journal.head(ownerId)).toBe(2);
    expect(await journal.appendSnapshotOnce(ownerId, entries)).toEqual([]);

    const next = await journal.append({
      ownerId,
      taskId: randomUUID() as Id,
      externalId: '102',
      version: 3 as Version,
      at: clock.now(),
    });
    expect(next.sequence).toBe(3);
  });
});
