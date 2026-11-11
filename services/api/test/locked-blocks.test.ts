import type { Availability } from '@ohmydate/contracts';
import type { Id, Instant, Task } from '@ohmydate/domain';
import { generate } from '@ohmydate/scheduler';
import type { ApprovedBlock } from '../src/application/planning-ports.js';
import {
  assembleScheduleInput,
  withoutLockedEchoes,
} from '../src/application/plan-service.js';

/**
 * M5-02R-1 H1 (reviewer's inline reproduction): a locked block of the
 * current plan is an immutable lockedBlock, never a movable existingBlock.
 */

const PLAN = 'plan-1' as Id;
const NOW = '2026-11-11T08:00:00Z';

const availability: Availability = {
  version: 1,
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    startLocal: '09:00',
    endLocal: '18:00',
    kind: 'work' as const,
  })),
  exceptions: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 480,
    breakMin: 15,
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
    riskLevel: 'p50',
  },
};

const task: Task = {
  id: 'task-a' as Id,
  ownerId: 'owner' as Id,
  projectId: 'project' as Id,
  title: 'A',
  status: 'todo',
  splittable: true,
  session: { minMinutes: 30, maxMinutes: 120 },
  priority: 2,
  dependsOn: [],
  version: 1 as never,
  createdAt: NOW as Instant,
  updatedAt: NOW as Instant,
  external: [],
};

function block(start: string, end: string, locked: boolean, id = `b-${start}`): ApprovedBlock {
  return {
    id: id as Id,
    planId: PLAN,
    planVersionId: 'v1' as Id,
    taskId: task.id,
    startAt: `2026-11-11T${start}:00Z` as Instant,
    endAt: `2026-11-11T${end}:00Z` as Instant,
    status: 'planned',
    locked,
    version: 1,
  };
}

function assemble(blocks: ApprovedBlock[], commitments: { startAt: string; endAt: string }[] = []) {
  return assembleScheduleInput({
    now: NOW,
    timeZone: 'UTC',
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-14T00:00:00Z' },
    availability,
    commitments: commitments.map((entry, index) => ({
      id: `c${index}` as Id,
      ownerId: 'owner' as Id,
      title: 'Commitment',
      startAt: entry.startAt as Instant,
      endAt: entry.endAt as Instant,
      timeZone: 'UTC',
      source: 'manual',
      version: 1,
      createdAt: NOW as Instant,
      updatedAt: NOW as Instant,
    })),
    planningTasks: [task],
    extraTasks: [],
    estimates: new Map([[task.id, { taskId: task.id, p50Min: 60, p90Min: 60 }]]),
    activeBlocks: blocks,
    currentPlanId: PLAN,
    seed: 1,
  });
}

describe('assembleScheduleInput locked blocks (M5-02R-1 H1)', () => {
  it('routes a future locked current-plan block to lockedBlocks, never existingBlocks', () => {
    const assembled = assemble([block('15:00', '16:00', true)], [
      { startAt: '2026-11-11T15:30:00Z', endAt: '2026-11-11T16:30:00Z' },
    ]);
    expect(assembled.input.lockedBlocks).toEqual([
      { taskId: task.id, start: '2026-11-11T15:00:00Z', end: '2026-11-11T16:00:00Z' },
    ]);
    expect(assembled.input.existingBlocks ?? []).toEqual([]);
    // The scheduler cannot move it: no candidate re-places the task, and the
    // locked/commitment overlap is reported instead of silently fixed.
    for (const candidate of generate(assembled.input).candidates) {
      expect(candidate.blocks.filter((entry) => entry.taskId === task.id)).toEqual([]);
      expect(candidate.feasible).toBe(false);
      expect(candidate.explanation.join(' ')).toMatch(/H1/);
    }
  });

  it('keeps an unlocked current-plan block movable and a started locked block as history (negative)', () => {
    const movable = assemble([block('15:00', '16:00', false)]);
    expect(movable.input.lockedBlocks).toEqual([]);
    expect(movable.input.existingBlocks).toHaveLength(1);
    const started = assemble([block('07:30', '08:30', true)]);
    expect(started.input.lockedBlocks).toEqual([]);
    expect(started.historyBlocks).toHaveLength(1);
  });

  it('drops only exact echoes of future locked blocks from edited sets', () => {
    const locked = block('15:00', '16:00', true);
    const edited = [
      { taskId: task.id, startAt: '2026-11-11T15:00:00.000Z', endAt: '2026-11-11T16:00:00.000Z' },
      { taskId: task.id, startAt: '2026-11-11T13:00:00Z', endAt: '2026-11-11T14:00:00Z' },
    ];
    expect(withoutLockedEchoes(edited, [locked], NOW)).toEqual([edited[1]]);
    expect(withoutLockedEchoes(edited, [block('15:00', '16:00', false)], NOW)).toEqual(edited);
  });
});
