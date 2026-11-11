import {
  deadlineSlackMinutes,
  plannedMinutes,
  proposalWindow,
  replanDiff,
  retryWait,
  type ApprovedBlockLike,
} from '../src/domain/replan';

const BASE = 'version-1';
const SINCE = '2026-11-14T09:30:00.000Z';

function approved(
  id: string,
  taskId: string,
  startAt: string,
  endAt: string,
  options: Partial<Pick<ApprovedBlockLike, 'locked' | 'status' | 'planVersionId'>> = {},
): ApprovedBlockLike {
  return {
    id,
    taskId,
    startAt,
    endAt,
    planVersionId: options.planVersionId ?? BASE,
    locked: options.locked ?? false,
    status: options.status ?? 'planned',
  };
}

describe('replanDiff (M5-03 before/after of only the changed blocks)', () => {
  it('keeps unchanged blocks out of the change list and classifies moved, shrunk, extended, added and removed', () => {
    const current = [
      approved('a1', 'A', '2026-11-14T10:00:00Z', '2026-11-14T11:00:00Z'),
      approved('b1', 'B', '2026-11-14T12:00:00Z', '2026-11-14T12:40:00Z'),
      approved('c1', 'C', '2026-11-15T01:00:00Z', '2026-11-15T02:00:00Z'),
      approved('d1', 'D', '2026-11-15T03:00:00Z', '2026-11-15T03:30:00Z'),
      approved('e1', 'E', '2026-11-16T01:00:00Z', '2026-11-16T01:30:00Z'),
    ];
    const candidate = [
      { taskId: 'A', startAt: '2026-11-14T10:00:00.000Z', endAt: '2026-11-14T11:00:00.000Z' },
      { taskId: 'B', startAt: '2026-11-16T02:00:00Z', endAt: '2026-11-16T02:40:00Z' },
      { taskId: 'C', startAt: '2026-11-15T01:00:00Z', endAt: '2026-11-15T01:30:00Z' },
      { taskId: 'D', startAt: '2026-11-15T03:00:00Z', endAt: '2026-11-15T04:00:00Z' },
      { taskId: 'F', startAt: '2026-11-17T01:00:00Z', endAt: '2026-11-17T01:30:00Z' },
    ];
    const diff = replanDiff({
      candidateBlocks: candidate,
      currentBlocks: current,
      affectedTaskIds: ['B', 'C', 'D', 'E', 'F'],
      basePlanVersionId: BASE,
      since: SINCE,
    });
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
    const current = [
      approved('lock', 'A', '2026-11-16T00:00:00Z', '2026-11-16T01:00:00Z', { locked: true }),
      approved('a2', 'A', '2026-11-17T00:00:00Z', '2026-11-17T01:00:00Z'),
    ];
    const diff = replanDiff({
      candidateBlocks: [{ taskId: 'A', startAt: '2026-11-17T00:00:00Z', endAt: '2026-11-17T01:00:00Z' }],
      currentBlocks: current,
      affectedTaskIds: [],
      basePlanVersionId: BASE,
      since: SINCE,
    });
    expect(diff.changes).toEqual([]);
    expect(diff.locked.map((block) => block.id)).toEqual(['lock']);
    expect(diff.unchangedCount).toBe(1);
  });

  it('infers the plan task set from the base plan version so a locked-only task still shows (negative: other plans stay out)', () => {
    const diff = replanDiff({
      candidateBlocks: [],
      currentBlocks: [
        approved('lock', 'L', '2026-11-16T00:00:00Z', '2026-11-16T01:00:00Z', { locked: true }),
        approved('other', 'X', '2026-11-16T03:00:00Z', '2026-11-16T04:00:00Z', { planVersionId: 'another-plan' }),
      ],
      affectedTaskIds: [],
      basePlanVersionId: BASE,
      since: SINCE,
    });
    expect([...diff.planTaskIds]).toEqual(['L']);
    expect(diff.locked).toHaveLength(1);
    expect(diff.changes).toEqual([]);
  });

  it('ignores history, done and superseded blocks (negative)', () => {
    const diff = replanDiff({
      candidateBlocks: [{ taskId: 'A', startAt: '2026-11-15T00:00:00Z', endAt: '2026-11-15T01:00:00Z' }],
      currentBlocks: [
        approved('past', 'A', '2026-11-14T08:00:00Z', '2026-11-14T09:00:00Z'),
        approved('done', 'A', '2026-11-14T10:00:00Z', '2026-11-14T11:00:00Z', { status: 'done' }),
        approved('old', 'A', '2026-11-14T12:00:00Z', '2026-11-14T13:00:00Z', { status: 'superseded' }),
        approved('keep', 'A', '2026-11-15T00:00:00Z', '2026-11-15T01:00:00Z'),
      ],
      affectedTaskIds: ['A'],
      basePlanVersionId: BASE,
      since: SINCE,
    });
    expect(diff.changes).toEqual([]);
    expect(diff.before.map((block) => block.id)).toEqual(['keep']);
  });
});

describe('replan metrics helpers', () => {
  it('computes deadline slack from the last block per task and ignores tasks without a due date', () => {
    const due = new Map([
      ['A', '2026-11-15T12:00:00Z'],
      ['B', '2026-11-14T13:00:00Z'],
    ]);
    const blocks = [
      { taskId: 'A', startAt: '2026-11-15T09:00:00Z', endAt: '2026-11-15T10:00:00Z' },
      { taskId: 'B', startAt: '2026-11-14T12:00:00Z', endAt: '2026-11-14T13:30:00Z' },
      { taskId: 'C', startAt: '2026-11-20T00:00:00Z', endAt: '2026-11-20T01:00:00Z' },
    ];
    expect(deadlineSlackMinutes(blocks, due)).toBe(-30);
    expect(deadlineSlackMinutes(blocks.slice(0, 1), due)).toBe(120);
    expect(deadlineSlackMinutes(blocks, new Map())).toBeNull();
    expect(plannedMinutes(blocks)).toBe(210);
  });

  it('turns Retry-After seconds into a rounded-up wait and rejects unusable values (negative)', () => {
    const now = Date.parse('2026-11-14T09:40:00Z');
    expect(retryWait(86_399.4, now)).toEqual({ minutes: 1440, untilMs: now + 86_399_400 });
    expect(retryWait(5, now)?.minutes).toBe(1);
    expect(retryWait(0, now)).toBeNull();
    expect(retryWait(-3, now)).toBeNull();
    expect(retryWait(Number.NaN, now)).toBeNull();
  });

  it('fetches a window from the proposal moment to two weeks past its last block, capped at 366 days', () => {
    const window = proposalWindow([{ taskId: 'A', startAt: '2026-11-16T00:00:00Z', endAt: '2026-11-16T01:00:00Z' }], SINCE);
    expect(window.from).toBe(SINCE);
    expect(window.to).toBe('2026-11-30T01:00:00.000Z');
    const far = proposalWindow([{ taskId: 'A', startAt: '2028-01-01T00:00:00Z', endAt: '2028-01-01T01:00:00Z' }], SINCE);
    expect(Date.parse(far.to) - Date.parse(far.from)).toBe(366 * 24 * 60 * 60 * 1000);
  });
});
