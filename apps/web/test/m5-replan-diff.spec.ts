import { replanDiff, retryWait, type SnapshotBlock } from '../src/domain/replan';

/**
 * replanDiff compares the server's authoritative before snapshot (FU-70) with
 * the candidate. The client no longer infers the plan's blocks from a calendar
 * window (M5-03R-1 H1): history/done/superseded filtering and the plan's task
 * set are the server's job (services/api/test/replan-before-snapshot.test.ts).
 */

function snap(id: string, taskId: string, startAt: string, endAt: string, locked = false): SnapshotBlock {
  return { id, taskId, startAt, endAt, locked };
}

describe('replanDiff (before snapshot vs candidate: only the changed blocks)', () => {
  it('keeps unchanged blocks out of the change list and classifies moved, shrunk, extended, added and removed', () => {
    const before = [
      snap('a1', 'A', '2026-11-14T10:00:00Z', '2026-11-14T11:00:00Z'),
      snap('b1', 'B', '2026-11-14T12:00:00Z', '2026-11-14T12:40:00Z'),
      snap('c1', 'C', '2026-11-15T01:00:00Z', '2026-11-15T02:00:00Z'),
      snap('d1', 'D', '2026-11-15T03:00:00Z', '2026-11-15T03:30:00Z'),
      snap('e1', 'E', '2026-11-16T01:00:00Z', '2026-11-16T01:30:00Z'),
    ];
    const candidate = [
      { taskId: 'A', startAt: '2026-11-14T10:00:00.000Z', endAt: '2026-11-14T11:00:00.000Z' },
      { taskId: 'B', startAt: '2026-11-16T02:00:00Z', endAt: '2026-11-16T02:40:00Z' },
      { taskId: 'C', startAt: '2026-11-15T01:00:00Z', endAt: '2026-11-15T01:30:00Z' },
      { taskId: 'D', startAt: '2026-11-15T03:00:00Z', endAt: '2026-11-15T04:00:00Z' },
      { taskId: 'F', startAt: '2026-11-17T01:00:00Z', endAt: '2026-11-17T01:30:00Z' },
    ];
    const diff = replanDiff(before, candidate);
    expect(diff.unchangedCount).toBe(1);
    expect(diff.changes.map((change) => [change.kind, change.taskId])).toEqual([
      ['moved', 'B'],
      ['shrunk', 'C'],
      ['extended', 'D'],
      ['removed', 'E'],
      ['added', 'F'],
    ]);
    const moved = diff.changes.find((change) => change.taskId === 'B');
    expect(moved?.before?.startAt).toBe('2026-11-14T12:00:00Z');
    expect(moved?.after?.startAt).toBe('2026-11-16T02:00:00Z');
    expect(diff.changes.find((change) => change.kind === 'removed')?.after).toBeUndefined();
    expect(diff.changes.find((change) => change.kind === 'added')?.before).toBeUndefined();
  });

  it('lists locked blocks as unchanged and never as a change, even when the candidate omits them', () => {
    const diff = replanDiff(
      [
        snap('lock', 'A', '2026-11-16T00:00:00Z', '2026-11-16T01:00:00Z', true),
        snap('a2', 'A', '2026-11-17T00:00:00Z', '2026-11-17T01:00:00Z'),
      ],
      [{ taskId: 'A', startAt: '2026-11-17T00:00:00Z', endAt: '2026-11-17T01:00:00Z' }],
    );
    expect(diff.changes).toEqual([]);
    expect(diff.locked.map((block) => block.id)).toEqual(['lock']);
    expect(diff.unchangedCount).toBe(1);
  });

  it('pairs far-apart blocks regardless of distance: a December original moved to November (M5-03R-1 reviewer case)', () => {
    const diff = replanDiff(
      [snap('a', 'A', '2026-12-15T10:00:00Z', '2026-12-15T11:00:00Z'), snap('x', 'X', '2027-01-10T10:00:00Z', '2027-01-10T11:00:00Z')],
      [{ taskId: 'A', startAt: '2026-11-15T10:00:00Z', endAt: '2026-11-15T11:00:00Z' }],
    );
    expect(diff.changes).toEqual([
      {
        kind: 'moved',
        taskId: 'A',
        before: { taskId: 'A', startAt: '2026-12-15T10:00:00Z', endAt: '2026-12-15T11:00:00Z' },
        after: { taskId: 'A', startAt: '2026-11-15T10:00:00Z', endAt: '2026-11-15T11:00:00Z' },
      },
      { kind: 'removed', taskId: 'X', before: { taskId: 'X', startAt: '2027-01-10T10:00:00Z', endAt: '2027-01-10T11:00:00Z' } },
    ]);
  });

  it('only reports what the snapshot says: without a before block a candidate block is an addition (negative)', () => {
    const diff = replanDiff([], [{ taskId: 'A', startAt: '2026-11-15T10:00:00Z', endAt: '2026-11-15T11:00:00Z' }]);
    expect(diff.changes.map((change) => change.kind)).toEqual(['added']);
    expect(diff.locked).toEqual([]);
    expect(diff.unchangedCount).toBe(0);
  });
});

describe('replan retry wait', () => {
  it('turns Retry-After seconds into a rounded-up wait and rejects unusable values (negative)', () => {
    const now = Date.parse('2026-11-14T09:40:00Z');
    expect(retryWait(86_399.4, now)).toEqual({ minutes: 1440, untilMs: now + 86_399_400 });
    expect(retryWait(5, now)?.minutes).toBe(1);
    expect(retryWait(0, now)).toBeNull();
    expect(retryWait(-3, now)).toBeNull();
    expect(retryWait(Number.NaN, now)).toBeNull();
  });
});
