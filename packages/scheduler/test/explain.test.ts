import type { AvailabilityRule, Block, ScheduleInput, Task } from '../src/index.js';
import { deficit } from '../src/index.js';

function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    estimate: { p50Min: 60, p90Min: 60 },
    splittable: true,
    minSessionMin: 30,
    maxSessionMin: 120,
    priority: 1,
    dependsOn: [],
    ...overrides,
  };
}

function makeInput(options: {
  start: string;
  end: string;
  availability: AvailabilityRule[];
  tasks: Task[];
  lockedBlocks?: Block[];
}): ScheduleInput {
  return {
    now: options.start,
    timeZone: 'UTC',
    horizon: { start: options.start, end: options.end },
    tasks: options.tasks,
    availability: options.availability,
    exceptions: [],
    commitments: [],
    lockedBlocks: options.lockedBlocks ?? [],
    prefs: {
      maxDailyFocusMin: 480,
      breakAfterMin: 480,
      breakMin: 15,
      riskLevel: 'p50',
      dayStartLocal: '00:00',
      dayEndLocal: '24:00',
    },
    seed: 303,
  };
}

const MONDAY_0900_1000: AvailabilityRule[] = [
  { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
];

describe('deficit explanation', () => {
  it('credits locked minutes toward the task requirement', () => {
    const input = makeInput({
      start: '2026-11-09T09:00:00Z',
      end: '2026-11-09T10:00:00Z',
      availability: MONDAY_0900_1000,
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T10:00:00Z',
        }),
      ],
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
    });

    const report = deficit(input);
    expect(report.tasks).toEqual([
      {
        taskId: 'A',
        requiredMin: 60,
        availableBeforeDueMin: 60,
        deficitMin: 0,
      },
    ]);
    expect(report.total).toEqual({
      requiredMin: 60,
      availableBeforeDueMin: 60,
      deficitMin: 0,
    });
  });

  it('chains dependency readiness from actual interval consumption', () => {
    const input = makeInput({
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-09T11:00:00Z',
      availability: MONDAY_0900_1000,
      tasks: [
        makeTask({ id: 'A' }),
        makeTask({
          id: 'B',
          dueAt: '2026-11-09T10:00:00Z',
          dependsOn: ['A'],
        }),
      ],
    });

    const report = deficit(input);
    const byId = new Map(report.tasks.map((task) => [task.taskId, task]));
    expect(byId.get('A')).toEqual({
      taskId: 'A',
      requiredMin: 60,
      availableBeforeDueMin: 60,
      deficitMin: 0,
    });
    expect(byId.get('B')).toEqual({
      taskId: 'B',
      requiredMin: 60,
      availableBeforeDueMin: 0,
      deficitMin: 60,
    });
    expect(report.total).toEqual({
      requiredMin: 120,
      availableBeforeDueMin: 60,
      deficitMin: 60,
    });
  });

  it('uses P90 requirements and locked completion for successors', () => {
    const input = makeInput({
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-09T12:00:00Z',
      availability: [
        { weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
      ],
      tasks: [
        makeTask({
          id: 'A',
          estimate: { p50Min: 30, p90Min: 60 },
        }),
        makeTask({
          id: 'B',
          dueAt: '2026-11-09T09:30:00Z',
          estimate: { p50Min: 30, p90Min: 60 },
          dependsOn: ['A'],
        }),
      ],
      lockedBlocks: [
        {
          taskId: 'A',
          start: '2026-11-09T09:00:00Z',
          end: '2026-11-09T10:00:00Z',
        },
      ],
    });
    input.prefs.riskLevel = 'p90';

    const report = deficit(input);
    const byId = new Map(report.tasks.map((task) => [task.taskId, task]));
    expect(byId.get('A')).toEqual({
      taskId: 'A',
      requiredMin: 60,
      availableBeforeDueMin: 180,
      deficitMin: 0,
    });
    expect(byId.get('B')).toEqual({
      taskId: 'B',
      requiredMin: 60,
      availableBeforeDueMin: 0,
      deficitMin: 60,
    });
  });
  it('blocks successors when a predecessor cannot finish inside its window', () => {
    const input = makeInput({
      start: '2026-11-09T00:00:00Z',
      end: '2026-11-09T11:00:00Z',
      availability: MONDAY_0900_1000,
      tasks: [
        makeTask({
          id: 'A',
          dueAt: '2026-11-09T09:30:00Z',
        }),
        makeTask({
          id: 'B',
          dueAt: '2026-11-09T10:00:00Z',
          estimate: { p50Min: 30, p90Min: 30 },
          dependsOn: ['A'],
        }),
      ],
    });

    const report = deficit(input);
    const byId = new Map(report.tasks.map((task) => [task.taskId, task]));
    expect(byId.get('A')).toEqual({
      taskId: 'A',
      requiredMin: 60,
      availableBeforeDueMin: 30,
      deficitMin: 30,
    });
    expect(byId.get('B')).toEqual({
      taskId: 'B',
      requiredMin: 30,
      availableBeforeDueMin: 0,
      deficitMin: 30,
    });
    expect(report.total).toEqual({
      requiredMin: 90,
      availableBeforeDueMin: 30,
      deficitMin: 60,
    });
  });

});
