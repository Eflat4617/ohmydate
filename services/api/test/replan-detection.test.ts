import type { Id, Instant } from '@ohmydate/domain';
import {
  detectTriggers,
  p90Slack,
  type DetectionBlock,
  type DetectionInput,
} from '../src/application/replan-detection.js';
import { policyWindow } from '../src/application/replan-service.js';

const NOW = '2026-11-11T08:00:00Z' as Instant;

function block(taskId: string, start: string, end: string, status = 'planned'): DetectionBlock {
  return {
    taskId: taskId as Id,
    startAt: `2026-11-11T${start}:00Z` as Instant,
    endAt: `2026-11-11T${end}:00Z` as Instant,
    status,
  };
}

function input(overrides: Partial<DetectionInput> = {}): DetectionInput {
  return {
    now: NOW,
    riskLevel: 'p50',
    tasks: [{ id: 'A' as Id, dueAt: '2026-11-11T17:00:00Z' as Instant, status: 'todo' }],
    blocks: [block('A', '09:00', '10:00')],
    estimates: new Map([['A', { p50Min: 60, p90Min: 60 }]]),
    commitments: [],
    ...overrides,
  };
}

describe('P90 slack (05 §11 deadline risk)', () => {
  it('is due minus the covering block end when the plan covers P90', () => {
    const value = input();
    expect(p90Slack(value, value.tasks[0] as DetectionInput['tasks'][number])).toEqual({
      taskId: 'A',
      slackMin: 7 * 60,
      remainingP90Min: 60,
      plannedBeforeDueMin: 60,
    });
    expect(detectTriggers(value)).toEqual([]);
  });

  it('is minus the uncovered P90 minutes when the plan falls short (G09)', () => {
    const value = input({ estimates: new Map([['A', { p50Min: 60, p90Min: 120 }]]) });
    expect(p90Slack(value, value.tasks[0] as DetectionInput['tasks'][number])?.slackMin).toBe(-60);
    expect(detectTriggers(value)).toEqual([
      { kind: 'deadline_risk', reason: 'deadline_slack_negative', affectedTaskIds: ['A'] },
    ]);
  });

  it('does not count blocks that end after the deadline', () => {
    const value = input({ blocks: [block('A', '16:30', '17:30')] });
    expect(p90Slack(value, value.tasks[0] as DetectionInput['tasks'][number])?.slackMin).toBe(-60);
  });

  it('credits past and done blocks as history', () => {
    const value = input({
      estimates: new Map([['A', { p50Min: 120, p90Min: 120 }]]),
      blocks: [block('A', '07:00', '08:00'), block('A', '09:00', '10:00')],
    });
    expect(p90Slack(value, value.tasks[0] as DetectionInput['tasks'][number])?.slackMin).toBe(7 * 60);
    const done = input({
      estimates: new Map([['A', { p50Min: 120, p90Min: 120 }]]),
      blocks: [block('A', '12:00', '13:00', 'done'), block('A', '09:00', '10:00')],
    });
    expect(p90Slack(done, done.tasks[0] as DetectionInput['tasks'][number])?.slackMin).toBe(7 * 60);
  });

  it('ignores overdue, done and undated tasks (negative)', () => {
    for (const task of [
      { id: 'A' as Id, dueAt: '2026-11-11T07:00:00Z' as Instant, status: 'todo' as const },
      { id: 'A' as Id, dueAt: '2026-11-11T17:00:00Z' as Instant, status: 'done' as const },
      { id: 'A' as Id, status: 'todo' as const },
    ]) {
      const value = input({ tasks: [task], estimates: new Map([['A', { p50Min: 600, p90Min: 600 }]]) });
      expect(p90Slack(value, task)).toBeNull();
      expect(detectTriggers(value).some((trigger) => trigger.kind === 'deadline_risk')).toBe(false);
    }
  });
});

describe('commitment conflict and early completion', () => {
  it('flags only future blocks that overlap a commitment', () => {
    const value = input({
      tasks: [
        { id: 'A' as Id, status: 'todo' },
        { id: 'B' as Id, status: 'todo' },
      ],
      blocks: [block('A', '07:00', '08:00'), block('B', '09:00', '10:00')],
      estimates: new Map([
        ['A', { p50Min: 60, p90Min: 60 }],
        ['B', { p50Min: 60, p90Min: 60 }],
      ]),
      commitments: [
        { start: '2026-11-11T07:30:00Z', end: '2026-11-11T07:45:00Z' },
        { start: '2026-11-11T09:30:00Z', end: '2026-11-11T09:45:00Z' },
      ],
    });
    expect(detectTriggers(value)).toEqual([
      { kind: 'commitment_conflict', reason: 'commitment_overlap', affectedTaskIds: ['B'] },
    ]);
  });

  it('proposes freed time when planned minutes exceed the remaining need by >= 30 (G08)', () => {
    const over = input({
      tasks: [{ id: 'A' as Id, status: 'todo' }],
      blocks: [block('A', '09:00', '11:00')],
      estimates: new Map([['A', { p50Min: 60, p90Min: 60 }]]),
    });
    expect(detectTriggers(over)).toEqual([
      { kind: 'early_completion', reason: 'early_completion_capacity', affectedTaskIds: ['A'] },
    ]);
    const slight = input({
      tasks: [{ id: 'A' as Id, status: 'todo' }],
      blocks: [block('A', '09:00', '10:15')],
      estimates: new Map([['A', { p50Min: 60, p90Min: 60 }]]),
    });
    expect(detectTriggers(slight)).toEqual([]);
  });

  it('proposes freed time for a done task that still owns future blocks', () => {
    const value = input({ tasks: [{ id: 'A' as Id, status: 'done' }] });
    expect(detectTriggers(value)).toEqual([
      { kind: 'early_completion', reason: 'early_completion_capacity', affectedTaskIds: ['A'] },
    ]);
  });

  it('uses the owner-local calendar day for the daily caps', () => {
    expect(policyWindow('2026-11-11T16:00:00Z' as Instant, 'Asia/Seoul')).toEqual({
      now: '2026-11-11T16:00:00Z',
      dayStart: '2026-11-11T15:00:00Z',
      dayEnd: '2026-11-12T15:00:00Z',
    });
  });
});
