import 'fake-indexeddb/auto';
import { IndexedDbSessionJournal } from '../src/session/journal';

const EVENT = {
  id: '01900000-0000-7000-8000-0000000000f1',
  sessionId: '01900000-0000-7000-8000-0000000000f2',
  kind: 'pause' as const,
  clientAt: '2026-11-11T10:00:00.000Z',
  idempotencyKey: '01900000-0000-7000-8000-0000000000f3',
  expectedVersion: 1,
};

describe('IndexedDB focus journal', () => {
  it('keeps owner namespaces across journal instances (reload/tab close) and retains other owners', async () => {
    const ownerA = `owner-a-${Date.now().toString(36)}`;
    const ownerB = `owner-b-${Date.now().toString(36)}`;

    const firstTab = new IndexedDbSessionJournal();
    firstTab.setOwner(ownerA);
    const record = await firstTab.append(EVENT);

    const reopenedTab = new IndexedDbSessionJournal();
    reopenedTab.setOwner(ownerA);
    const restored = await reopenedTab.list();
    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe(record.id);
    expect(restored[0]?.ownerId).toBe(ownerA);

    reopenedTab.setOwner(ownerB);
    expect(await reopenedTab.list()).toHaveLength(0);
    await reopenedTab.append({ ...EVENT, id: '01900000-0000-7000-8000-0000000000f4' });
    expect(await reopenedTab.list()).toHaveLength(1);

    reopenedTab.setOwner(ownerA);
    await reopenedTab.clear();
    expect(await reopenedTab.list()).toHaveLength(0);

    reopenedTab.setOwner(ownerB);
    expect(await reopenedTab.list()).toHaveLength(1);
    await reopenedTab.clear();
  });
});
