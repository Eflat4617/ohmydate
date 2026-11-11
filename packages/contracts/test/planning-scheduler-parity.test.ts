import {
  generate,
  validateInput,
  type Block as SchedulerBlock,
  type PlanCandidate as SchedulerPlanCandidate,
  type ScheduleInput,
} from '@ohmydate/scheduler';
import {
  PlanCandidateSchema,
  PlanSchema,
  ProblemSchema,
  planningRoutes,
  type PlanBlock,
  type PlanCandidateDto,
} from '../src/index.js';
import { compile } from './ajv.js';

const TASK_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const CANDIDATE_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c56';

const BASE_INPUT: ScheduleInput = {
  now: '2026-11-11T08:00:00Z',
  timeZone: 'UTC',
  horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-12T00:00:00Z' },
  tasks: [
    {
      id: TASK_ID,
      dueAt: '2026-11-11T10:00:30Z',
      estimate: { p50Min: 60, p90Min: 60 },
      splittable: false,
      minSessionMin: 60,
      maxSessionMin: 60,
      priority: 1,
      dependsOn: [],
    },
  ],
  availability: [{ weekday: 3, startLocal: '09:00', endLocal: '11:00', kind: 'work' }],
  exceptions: [],
  commitments: [],
  lockedBlocks: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 60,
    breakMin: 15,
    riskLevel: 'p50',
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
  },
  seed: 1,
};

/**
 * Pure adapter between the scheduler wire shape (`start`/`end`) and the public
 * plan DTO (`startAt`/`endAt`). M3-04 handlers can reuse the same mapping.
 */
export function toPlanBlock(block: SchedulerBlock): PlanBlock {
  return { taskId: block.taskId, startAt: block.start, endAt: block.end };
}

export function fromPlanBlock(block: PlanBlock): SchedulerBlock {
  return { taskId: block.taskId, start: block.startAt, end: block.endAt };
}

export function toPlanCandidateDto(candidate: SchedulerPlanCandidate): PlanCandidateDto {
  return {
    id: CANDIDATE_ID,
    policy: candidate.policy,
    blocks: candidate.blocks.map(toPlanBlock),
    metrics: candidate.metrics,
    feasible: candidate.feasible,
    deficitMin: candidate.deficitMin,
    capacityDeficitMin: candidate.capacityDeficitMin,
    explanation: candidate.explanation,
    generatorVersion: candidate.generatorVersion,
    inputHash: candidate.inputHash,
  };
}

function generateCandidates(input: ScheduleInput): SchedulerPlanCandidate[] {
  expect(validateInput(input)).toEqual([]);
  return generate(input, { policies: ['front_loaded', 'balanced', 'focus_blocked'] }).candidates;
}

test('block adapter is a lossless start/end <-> startAt/endAt rename', () => {
  const schedulerBlock: SchedulerBlock = {
    taskId: TASK_ID,
    start: '2026-11-11T09:00:00Z',
    end: '2026-11-11T10:00:00Z',
  };
  expect(toPlanBlock(schedulerBlock)).toEqual({
    taskId: TASK_ID,
    startAt: '2026-11-11T09:00:00Z',
    endAt: '2026-11-11T10:00:00Z',
  });
  expect(fromPlanBlock(toPlanBlock(schedulerBlock))).toEqual(schedulerBlock);
});

test('fractional and negative scheduler slack survives DTO validation', () => {
  const validate = compile(PlanCandidateSchema);

  const fractional = generateCandidates(BASE_INPUT);
  expect(fractional.length).toBeGreaterThan(0);
  expect(fractional.some((candidate) => candidate.metrics.minSlackMin === 0.5)).toBe(true);
  for (const candidate of fractional) {
    expect({ candidate: candidate.policy, valid: validate(toPlanCandidateDto(candidate)) }).toEqual({
      candidate: candidate.policy,
      valid: true,
    });
  }

  const overdue: ScheduleInput = {
    ...BASE_INPUT,
    tasks: [
      {
        ...BASE_INPUT.tasks[0]!,
        dueAt: '2026-11-11T09:00:00Z',
        remainingMin: 0,
      },
    ],
    lockedBlocks: [
      { taskId: TASK_ID, start: '2026-11-11T09:00:00Z', end: '2026-11-11T10:00:00Z' },
    ],
  };
  const overdueCandidates = generateCandidates(overdue);
  expect(overdueCandidates.length).toBeGreaterThan(0);
  expect(overdueCandidates.some((candidate) => candidate.metrics.minSlackMin === -60)).toBe(true);
  expect(overdueCandidates.every((candidate) => candidate.feasible === false)).toBe(true);
  for (const candidate of overdueCandidates) {
    expect({ candidate: candidate.policy, valid: validate(toPlanCandidateDto(candidate)) }).toEqual({
      candidate: candidate.policy,
      valid: true,
    });
  }
});

test('every feasible and infeasible scheduler candidate serializes through the DTO', () => {
  const validate = compile(PlanCandidateSchema);
  const deficitInput: ScheduleInput = {
    ...BASE_INPUT,
    horizon: { start: '2026-11-11T00:00:00Z', end: '2026-11-11T11:00:00Z' },
    tasks: [
      {
        ...BASE_INPUT.tasks[0]!,
        id: TASK_ID,
        dueAt: '2026-11-11T11:00:00Z',
        estimate: { p50Min: 240, p90Min: 240 },
        minSessionMin: 60,
        maxSessionMin: 60,
      },
    ],
    availability: [{ weekday: 3, startLocal: '09:00', endLocal: '10:00', kind: 'work' }],
  };

  const fixtures: Array<{ name: string; input: ScheduleInput }> = [
    { name: 'fractional slack', input: BASE_INPUT },
    { name: 'capacity deficit', input: deficitInput },
  ];

  for (const fixture of fixtures) {
    const candidates = generateCandidates(fixture.input);
    expect(candidates.length).toBeGreaterThan(0);
    const feasibilities = new Set(candidates.map((candidate) => candidate.feasible));
    for (const candidate of candidates) {
      const dto = toPlanCandidateDto(candidate);
      expect({
        fixture: fixture.name,
        policy: candidate.policy,
        valid: validate(dto),
        errors: validate.errors,
      }).toEqual({
        fixture: fixture.name,
        policy: candidate.policy,
        valid: true,
        errors: null,
      });
      expect(dto.metrics).toEqual(candidate.metrics);
    }
    if (fixture.name === 'capacity deficit') {
      expect(feasibilities.has(false)).toBe(true);
    }
  }
});

test('edited-block preflight failures use validation_failed errors, not H0 violations', () => {
  const validateProblem = compile(ProblemSchema);
  expect(
    validateProblem({
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      errors: [
        { path: '/editedBlocks/0', message: 'block ends outside the plan horizon' },
        { path: '/editedBlocks/1', message: 'task is not in the plan scope' },
      ],
    }),
  ).toBe(true);

  const preview = requireRoute('previewPlanCandidateEdit');
  const approve = requireRoute('approvePlanCandidate');
  for (const route of [preview, approve]) {
    expect({ route: route.operationId, description: route.description }).toEqual({
      route: route.operationId,
      description: expect.stringMatching(/pre-flight/i),
    });
    expect({ route: route.operationId, horizon: route.description }).toEqual({
      route: route.operationId,
      horizon: expect.stringMatching(/validation_failed/),
    });
  }
});

test('documented preflight error paths exist on the route body schema', () => {
  for (const operationId of ['previewPlanCandidateEdit', 'approvePlanCandidate']) {
    const route = requireRoute(operationId);
    const match = /errors\[\{path: "\/([A-Za-z][A-Za-z0-9]*)\/<i>"/.exec(route.description ?? '');
    expect({ operationId, documented: match?.[1] }).toEqual({
      operationId,
      documented: expect.any(String),
    });
    const properties = Object.keys(
      ((route.body as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}) as Record<
        string,
        unknown
      >,
    );
    expect({ operationId, bodyProperties: properties }).toEqual({
      operationId,
      bodyProperties: expect.arrayContaining([match?.[1]]),
    });
  }
});

function requireRoute(operationId: string) {
  const route = planningRoutes.find((candidate) => candidate.operationId === operationId);
  if (route === undefined) throw new Error(`route ${operationId} missing`);
  return route;
}

test('regenerate declares the same Plan DTO so the original horizon must persist', () => {
  const route = planningRoutes.find((candidate) => candidate.operationId === 'regeneratePlan');
  expect(route?.responses[201]?.schema).toBe(PlanSchema);
});
