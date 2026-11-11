import { expect, test } from '@playwright/test';
import {
  availabilityWindows,
  calendarBlockSelector,
  dateFromKoreanLabel,
  findAvailabilityExitEdit,
  findFeasibleNudge,
  findOverlapEdit,
  koreanClock,
  koreanDateLabel,
  localDate,
  nudgeBlocker,
  weekStartOf,
  type AvailabilityShape,
  type EditContext,
  type EditableBlock,
  type EditableCandidate,
  type TaskConstraints,
} from '../helpers/plan-edit';

// Pure checks for the E2E-3 edit pickers; no browser or server involved.

const WEEKDAY_AVAILABILITY: AvailabilityShape = {
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startLocal: '09:00', endLocal: '11:00', kind: 'work' },
    { weekday, startLocal: '14:00', endLocal: '16:00', kind: 'work' },
  ]),
  exceptions: [],
  prefs: { breakAfterMin: 600, breakMin: 15 },
};

// 2026-11-12 is a Thursday.
const DAY = '2026-11-12';

function block(taskId: string, start: string, end: string, date = DAY): EditableBlock {
  return { taskId, startAt: `${date}T${start}:00Z`, endAt: `${date}T${end}:00Z` };
}

function candidate(blocks: EditableBlock[], feasible = true, policy = 'front_loaded'): EditableCandidate {
  return { id: `cand-${policy}`, policy, feasible, blocks };
}

function tasksFor(
  blocks: readonly EditableBlock[],
  overrides: Record<string, TaskConstraints> = {},
): Map<string, TaskConstraints> {
  const map = new Map<string, TaskConstraints>();
  for (const item of blocks) map.set(item.taskId, overrides[item.taskId] ?? { dependsOn: [] });
  return map;
}

function context(blocks: readonly EditableBlock[], overrides: Partial<EditContext> = {}): EditContext {
  return {
    horizon: { start: '2026-11-09T00:00:00Z', end: '2026-11-23T00:00:00Z' },
    timeZone: 'UTC',
    availability: WEEKDAY_AVAILABILITY,
    occupied: [],
    tasks: tasksFor(blocks),
    notBeforeMs: Date.parse('2026-11-12T00:00:00Z'),
    ...overrides,
  };
}

test.describe('E2E-3 plan edit pickers', () => {
  test('feasible nudge skips packed blocks and picks the one with free space', () => {
    const blocks = [
      block('a', '09:00', '10:00'),
      block('b', '10:00', '11:00'),
      block('c', '14:00', '15:00'),
    ];
    const nudge = findFeasibleNudge([candidate(blocks)], context(blocks));
    expect(nudge).not.toBeNull();
    expect(nudge?.blockIndex).toBe(2);
    expect(nudge?.key).toBe('ArrowDown');
    expect(nudge?.moved).toEqual({
      taskId: 'c',
      startAt: '2026-11-12T14:05:00.000Z',
      endAt: '2026-11-12T15:05:00.000Z',
    });
    expect(nudge?.blocks[0]).toEqual(blocks[0]);
  });

  test('feasible nudge returns null when every block is boxed in (negative)', () => {
    // The 09:50 UTC shape from FU-55: both windows full, neighbours adjacent.
    const blocks = [
      block('a', '09:00', '10:00'),
      block('b', '10:00', '11:00'),
      block('c', '14:00', '16:00'),
    ];
    expect(findFeasibleNudge([candidate(blocks)], context(blocks))).toBeNull();
    expect(nudgeBlocker(blocks, 0, 'ArrowDown', context(blocks))).toContain('H1');
    expect(nudgeBlocker(blocks, 1, 'ArrowDown', context(blocks))).toContain('H2');
  });

  test('feasible nudge honours commitments, approved blocks, past, due time and dependencies', () => {
    const blocks = [block('a', '09:30', '10:30')];
    const base = context(blocks);
    expect(nudgeBlocker(blocks, 0, 'ArrowDown', base)).toBeNull();
    expect(nudgeBlocker(blocks, 0, 'ArrowUp', base)).toBeNull();

    const occupied = [
      { startAt: '2026-11-12T10:30:00Z', endAt: '2026-11-12T11:00:00Z' },
      { startAt: '2026-11-12T09:00:00Z', endAt: '2026-11-12T09:30:00Z' },
    ];
    expect(findFeasibleNudge([candidate(blocks)], { ...base, occupied })).toBeNull();

    const past = { ...base, notBeforeMs: Date.parse('2026-11-12T09:30:00Z') };
    expect(nudgeBlocker(blocks, 0, 'ArrowUp', past)).toContain('past');

    const due = { ...base, tasks: tasksFor(blocks, { a: { dueAt: '2026-11-12T10:30:00Z', dependsOn: [] } }) };
    expect(nudgeBlocker(blocks, 0, 'ArrowDown', due)).toContain('H4');
    expect(nudgeBlocker(blocks, 0, 'ArrowUp', due)).toBeNull();

    const linked = { ...base, tasks: tasksFor(blocks, { a: { dependsOn: ['other'] } }) };
    expect(findFeasibleNudge([candidate(blocks)], linked)).toBeNull();

    expect(findFeasibleNudge([candidate(blocks, false)], base)).toBeNull();
  });

  test('feasible nudge falls through to a later candidate when the first is packed', () => {
    const packed = [block('a', '09:00', '11:00'), block('b', '14:00', '16:00')];
    const spread = [block('a', '09:00', '10:00'), block('b', '14:00', '15:00')];
    const nudge = findFeasibleNudge(
      [candidate(packed), candidate(spread, true, 'balanced')],
      context(packed),
    );
    expect(nudge?.candidateIndex).toBe(1);
    expect(nudge?.candidateId).toBe('cand-balanced');
  });

  test('overlap edit slides a block into its same-day neighbour', () => {
    const blocks = [block('a', '09:00', '09:30'), block('b', '09:40', '10:00')];
    const edit = findOverlapEdit([candidate(blocks)], 'UTC', context(blocks).horizon);
    expect(edit).not.toBeNull();
    expect(edit?.key).toBe('ArrowDown');
    expect(edit?.presses).toBe(3);
    expect(edit?.moved.startAt).toBe('2026-11-12T09:15:00.000Z');
    expect(edit?.overlapped).toEqual(blocks[1]);
    const adjacent = [block('a', '09:00', '10:00'), block('b', '10:00', '11:00')];
    expect(findOverlapEdit([candidate(adjacent)], 'UTC', context(adjacent).horizon)?.presses).toBe(1);
  });

  test('overlap edit returns null without a same-day pair (negative)', () => {
    const blocks = [block('a', '09:00', '10:00'), block('b', '09:00', '10:00', '2026-11-13')];
    expect(findOverlapEdit([candidate(blocks)], 'UTC', context(blocks).horizon)).toBeNull();
  });

  test('availability exit uses the nearest window edge and lands on uncovered time', () => {
    const blocks = [block('a', '14:00', '15:00'), block('b', '09:00', '10:55')];
    const edit = findAvailabilityExitEdit([candidate(blocks)], context(blocks));
    expect(edit).not.toBeNull();
    expect(edit?.blockIndex).toBe(0);
    expect(edit?.key).toBe('ArrowUp');
    expect(edit?.presses).toBe(1);
    expect(edit?.moved.startAt).toBe('2026-11-12T13:55:00.000Z');
  });

  test('availability exit returns null when adjacent windows cover the edge (negative)', () => {
    const adjacent: AvailabilityShape = {
      ...WEEKDAY_AVAILABILITY,
      rules: [
        { weekday: 4, startLocal: '07:00', endLocal: '09:00', kind: 'work' },
        { weekday: 4, startLocal: '09:00', endLocal: '11:00', kind: 'focus' },
        { weekday: 4, startLocal: '11:00', endLocal: '13:00', kind: 'work' },
      ],
    };
    const blocks = [block('a', '09:00', '11:00')];
    expect(
      findAvailabilityExitEdit([candidate(blocks)], { ...context(blocks), availability: adjacent }),
    ).toBeNull();
  });

  test('windows, week start and selectors follow the plan time zone', () => {
    expect(availabilityWindows('2026-11-14', WEEKDAY_AVAILABILITY)).toEqual([]);
    expect(
      availabilityWindows('2026-11-12', {
        ...WEEKDAY_AVAILABILITY,
        exceptions: [{ date: '2026-11-12', kind: 'off', startLocal: '09:30', endLocal: '10:00' }],
      }),
    ).toEqual([
      { start: 540, end: 570 },
      { start: 600, end: 660 },
      { start: 840, end: 960 },
    ]);
    expect(weekStartOf('2026-11-15')).toBe('2026-11-09');
    expect(weekStartOf('2026-11-16')).toBe('2026-11-16');
    expect(localDate('2026-11-12T16:30:00Z', 'Asia/Seoul')).toBe('2026-11-13');
    expect(calendarBlockSelector(block('a', '16:30', '17:00'), 'Asia/Seoul')).toBe(
      '.calendar-block[aria-label*=", 11월 13일 (금) 오전 1:30~"]',
    );
  });

  test('writes dates and clocks the way the Korean UI renders them', () => {
    expect(koreanDateLabel('2026-11-13')).toBe('11월 13일 (금)');
    expect(koreanDateLabel('2026-11-16', true)).toBe('2026년 11월 16일 (월)');
    expect(dateFromKoreanLabel('주간 보기 · 2026년 11월 16일 (월) ~ 11월 22일 (일)')).toBe('2026-11-16');
    expect(dateFromKoreanLabel('주간 보기 · 11월 16일 (월)')).toBeUndefined();
    expect(koreanClock('2026-11-12T15:00:00Z', 'Asia/Seoul')).toBe('오전 12:00');
    expect(koreanClock('2026-11-13T03:05:00Z', 'Asia/Seoul')).toBe('오후 12:05');
    expect(koreanClock('2026-11-13T10:00:00Z', 'Asia/Seoul')).toBe('오후 7:00');
  });
});
