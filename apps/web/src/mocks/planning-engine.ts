import {
  deficit,
  generate,
  validate,
  validateInput,
  type Block as SchedulerBlock,
  type PlanCandidate as SchedulerCandidate,
  type PolicyName,
  type ScheduleInput,
  type Task as SchedulerTask,
  type Violation as SchedulerViolation,
} from '../../../../packages/scheduler/src/index';
import type {
  Availability,
  Commitment,
  PlanBlock,
  PlanCandidate,
  PlanMetrics,
  Task,
  Violation,
} from '../api/client';
import { expandOccurrences } from '../domain/rrule';
import type { MockDb } from './db';
import { createUuidV7 } from './db';

const PUBLIC_VIOLATION_CODES = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8']);

export interface GenerationInput {
  readonly horizon: { start: string; end: string };
  readonly timeZone: string;
  readonly availability: Availability;
  readonly commitments: readonly Commitment[];
  readonly tasks: readonly Task[];
  readonly lockedBlocks?: readonly PlanBlock[];
}

export interface CandidateGeneration {
  readonly candidates: PlanCandidate[];
  readonly diversityNote: string | undefined;
}

function schedulerTask(task: Task): SchedulerTask {
  const minSessionMin = task.session?.minMinutes ?? 30;
  const maxSessionMin = Math.max(minSessionMin, task.session?.maxMinutes ?? 120);
  const estimateMin = Math.min(Math.max(60, minSessionMin), maxSessionMin);
  return {
    id: task.id,
    ...(task.dueAt === undefined ? {} : { dueAt: task.dueAt }),
    estimate: { p50Min: estimateMin, p90Min: estimateMin },
    splittable: task.splittable,
    minSessionMin,
    maxSessionMin,
    priority: task.priority as 1 | 2 | 3 | 4,
    dependsOn: task.dependsOn.filter((dependency) => dependency !== task.id),
  };
}

function commitmentIntervals(
  commitments: readonly Commitment[],
  horizon: { start: string; end: string },
): SchedulerInputCommitment[] {
  const intervals: SchedulerInputCommitment[] = [];
  for (const commitment of commitments) {
    const occurrences = expandOccurrences(commitment, horizon.start, horizon.end, 2_000);
    if (occurrences.length === 0) {
      if (commitment.startAt < horizon.end && commitment.endAt > horizon.start) {
        intervals.push({ start: commitment.startAt, end: commitment.endAt });
      }
      continue;
    }
    for (const occurrence of occurrences) {
      intervals.push({ start: occurrence.startAt, end: occurrence.endAt });
    }
  }
  return intervals;
}

interface SchedulerInputCommitment {
  start: string;
  end: string;
}

export function buildScheduleInput(input: GenerationInput): ScheduleInput {
  const horizonStartMs = Date.parse(input.horizon.start);
  const horizonEndMs = Date.parse(input.horizon.end);
  if (!Number.isFinite(horizonStartMs) || !Number.isFinite(horizonEndMs)) {
    throw new RangeError('horizon contains an invalid instant');
  }
  const tasks = input.tasks.map(schedulerTask);
  const taskIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) task.dependsOn = task.dependsOn.filter((id) => taskIds.has(id));

  return {
    now: input.horizon.start,
    timeZone: input.timeZone,
    horizon: { start: input.horizon.start, end: input.horizon.end },
    tasks,
    availability: input.availability.rules.map((rule) => ({
      weekday: rule.weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      startLocal: rule.startLocal,
      endLocal: rule.endLocal,
      kind: rule.kind,
    })),
    exceptions: input.availability.exceptions.map((exception) => ({
      date: exception.date,
      kind: exception.kind,
      ...(exception.startLocal === undefined ? {} : { startLocal: exception.startLocal }),
      ...(exception.endLocal === undefined ? {} : { endLocal: exception.endLocal }),
    })),
    commitments: commitmentIntervals(input.commitments, input.horizon),
    lockedBlocks: (input.lockedBlocks ?? []).map((block) => ({
      taskId: block.taskId,
      start: block.startAt,
      end: block.endAt,
    })),
    prefs: {
      maxDailyFocusMin: input.availability.prefs.maxDailyFocusMin,
      breakAfterMin: input.availability.prefs.breakAfterMin,
      breakMin: input.availability.prefs.breakMin,
      riskLevel: input.availability.prefs.riskLevel,
      dayStartLocal: input.availability.prefs.dayStartLocal,
      dayEndLocal: input.availability.prefs.dayEndLocal,
    },
    seed: 7,
  };
}

export function candidateToDto(
  candidate: SchedulerCandidate,
  diversityNote?: string,
): PlanCandidate {
  return {
    id: createUuidV7(),
    policy: candidate.policy,
    blocks: candidate.blocks.map((block) => ({
      taskId: block.taskId,
      startAt: block.start,
      endAt: block.end,
    })),
    metrics: candidate.metrics as PlanMetrics,
    feasible: candidate.feasible,
    deficitMin: candidate.deficitMin,
    capacityDeficitMin: candidate.capacityDeficitMin,
    explanation: candidate.explanation,
    explanationItems: candidate.explanationItems,
    ...(diversityNote === undefined ? {} : { diversityNote }),
    generatorVersion: candidate.generatorVersion,
    inputHash: candidate.inputHash,
  };
}

export function generateCandidates(
  input: GenerationInput,
  policies: readonly PolicyName[],
): CandidateGeneration {
  const scheduleInput = buildScheduleInput(input);
  const issues = validateInput(scheduleInput);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => issue.message).join('; '));
  }
  const result = generate(scheduleInput, { policies: [...policies] });
  return {
    candidates: result.candidates.map((candidate, index) =>
      candidateToDto(candidate, index === 0 ? result.diversityNote : undefined),
    ),
    diversityNote: result.diversityNote,
  };
}

export interface PreflightError {
  readonly index: number;
  readonly path: string;
  readonly message: string;
}

export function preflightBlocks(
  blocks: readonly PlanBlock[],
  horizon: { start: string; end: string },
  taskIds: ReadonlySet<string>,
  prefix = 'blocks',
): PreflightError[] {
  const horizonStart = Date.parse(horizon.start);
  const horizonEnd = Date.parse(horizon.end);
  const errors: PreflightError[] = [];
  blocks.forEach((block, index) => {
    const start = Date.parse(block.startAt);
    const end = Date.parse(block.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      errors.push({
        index,
        path: `/${prefix}/${index}`,
        message: 'block has an invalid instant',
      });
      return;
    }
    if (start < horizonStart || end > horizonEnd) {
      errors.push({
        index,
        path: `/${prefix}/${index}`,
        message: 'block lies outside the plan horizon',
      });
      return;
    }
    if (end <= start) {
      errors.push({
        index,
        path: `/${prefix}/${index}`,
        message: 'block end must be after start',
      });
      return;
    }
    if (!taskIds.has(block.taskId)) {
      errors.push({
        index,
        path: `/${prefix}/${index}`,
        message: 'task is not in the plan scope',
      });
    }
  });
  return errors;
}

export interface ValidationResult {
  readonly feasible: boolean;
  readonly violations: Violation[];
  readonly deficitMin: number;
}

function publicViolation(violation: SchedulerViolation): Violation | null {
  if (!PUBLIC_VIOLATION_CODES.has(violation.code)) return null;
  const code = violation.code as Violation['code'];
  return {
    code,
    message: violation.message,
    messageCode: violation.messageCode,
    params: { ...violation.params },
    ...(violation.taskId === undefined ? {} : { taskId: violation.taskId }),
  };
}

export function validateEditedBlocks(
  input: GenerationInput,
  blocks: readonly PlanBlock[],
): ValidationResult {
  const scheduleInput = buildScheduleInput(input);
  const schedulerBlocks: SchedulerBlock[] = blocks.map((block) => ({
    taskId: block.taskId,
    start: block.startAt,
    end: block.endAt,
  }));
  const violations = validate(scheduleInput, schedulerBlocks, {
    riskLevel: input.availability.prefs.riskLevel,
  })
    .map(publicViolation)
    .filter((violation): violation is Violation => violation !== null);
  const report = deficit(scheduleInput);
  return {
    feasible: violations.length === 0,
    violations,
    deficitMin: report.total.deficitMin,
  };
}

export function commitmentsFor(db: MockDb): Commitment[] {
  return [...db.commitments.values()];
}
