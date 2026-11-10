import {
  VersionConflictError,
  type Id,
  type Instant,
  type Version,
} from '@ohmydate/domain';
import { InMemoryMappingStore, type ExternalMapping } from '../../src/mapping-store.js';

const ownerId = '01900000-0000-7000-8000-000000000001' as Id;
const entityId = '01900000-0000-7000-8000-000000000002' as Id;

function mapping(version: number, title?: string): ExternalMapping {
  return {
    provider: 'vikunja',
    entityType: 'task',
    entityId,
    externalId: '42',
    ownerId,
    localVersion: version as Version,
    createdAt: '2026-01-01T00:00:00Z' as Instant,
    updatedAt: '2026-01-01T00:00:00Z' as Instant,
    ...(title === undefined ? {} : { externalEtag: title }),
  };
}

describe('InMemoryMappingStore expectedLocalVersion', () => {
  test('accepts a put when the stored version matches the precondition', async () => {
    const store = new InMemoryMappingStore();
    await store.put(mapping(1));

    await store.put(mapping(2), { expectedLocalVersion: 1 as Version });

    expect((await store.get('task', entityId))?.localVersion).toBe(2);
  });

  test('rejects a stale put without overwriting the newer mapping', async () => {
    const store = new InMemoryMappingStore();
    await store.put(mapping(1));

    await expect(
      store.put(mapping(2, 'stale'), { expectedLocalVersion: 2 as Version }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const stored = await store.get('task', entityId);
    expect(stored?.localVersion).toBe(1);
    expect(stored?.externalEtag).toBeUndefined();
  });

  test('rejects a precondition when no mapping exists yet', async () => {
    const store = new InMemoryMappingStore();

    await expect(
      store.put(mapping(1), { expectedLocalVersion: 1 as Version }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await store.get('task', entityId)).toBeNull();
  });
});
