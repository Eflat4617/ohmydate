import { Temporal } from 'temporal-polyfill';
import type {
  Block,
  InputIssue,
  Instant,
  ScheduleInput,
  Task,
  Violation,
  ValidateOptions,
} from './types.js';
import {
  GRID_MS,
  MINUTE_MS,
  instantToZoned,
  isGridAligned,
  isValidTimeZone,
  parseClock,
  parseInstant,
  splitByLocalDay,
} from './time.js';
import { taskRequiredMinutes } from './requirements.js';

interface ParsedBlock {
  block: Block;
  startMs: number;
  endMs: number;
}

interface IntervalMs {
  startMs: number;
  endMs: number;
}

interface ExceptionWindow {
  date: string;
  kind: 'off' | 'extra';
  startLocal?: string;
  endLocal?: string;
}

/**
 * Audit a candidate plan against hard constraints H1-H8.
 *
 * This module intentionally uses a different strategy from `slots.ts`:
 * availability is tested per block by sampling 5-minute points against the
 * raw weekly rules, and overlaps are found with a sorted scan. That keeps it
 * usable as an independent audit of a future plan generator.
 */
export function validate(
  input: ScheduleInput,
  blocks: Block[],
  opts: ValidateOptions,
): Violation[] {
  const violations: Violation[] = [];

  if (!isValidTimeZone(input.timeZone)) {
    return [
      {
        code: 'H8',
        message: `Invalid IANA time zone: ${input.timeZone}`,
      },
    ];
  }

  const candidate = parsePlanBlocks(blocks, violations);
  const locked = parsePlanBlocks(input.lockedBlocks, violations);
  const plan = [...candidate, ...locked];

  checkH1(input, plan, violations);
  checkH2(input, plan, violations);
  checkH3(input, plan, violations);
  checkH4(input, plan, violations);
  checkH5(input, plan, opts, violations);
  checkH6(input, plan, violations);
  checkH7(input, plan, opts, violations);

  return violations;
}

function parsePlanBlocks(blocks: Block[], violations: Violation[]): ParsedBlock[] {
  const parsed: ParsedBlock[] = [];
  for (const block of blocks) {
    let startMs: number;
    let endMs: number;
    try {
      startMs = parseInstant(block.start);
      endMs = parseInstant(block.end);
    } catch {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" has an invalid instant.`,
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    if (endMs <= startMs) {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" ends before it starts.`,
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    if (!isGridAligned(startMs) || !isGridAligned(endMs)) {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" is not aligned to the 5-minute grid.`,
        taskId: block.taskId,
        blocks: [block],
      });
    }
    parsed.push({ block, startMs, endMs });
  }
  return parsed;
}

function checkH1(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  const sorted = [...plan].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current === undefined) {
      continue;
    }
    for (let other = index + 1; other < sorted.length; other += 1) {
      const next = sorted[other];
      if (next === undefined || next.startMs >= current.endMs) {
        break;
      }
      if (next.startMs < current.endMs && next.endMs > current.startMs) {
        violations.push({
          code: 'H1',
          message:
            current.block.taskId === next.block.taskId
              ? `Blocks for task "${current.block.taskId}" overlap.`
              : `Blocks for tasks "${current.block.taskId}" and "${next.block.taskId}" overlap.`,
          blocks: [current.block, next.block],
        });
      }
    }
  }

  for (const parsed of plan) {
    for (const commitment of input.commitments) {
      const startMs = tryParseInstant(commitment.start);
      const endMs = tryParseInstant(commitment.end);
      if (startMs === undefined || endMs === undefined) {
        continue;
      }
      if (parsed.startMs < endMs && parsed.endMs > startMs) {
        violations.push({
          code: 'H1',
          message: `Block for task "${parsed.block.taskId}" overlaps a commitment.`,
          taskId: parsed.block.taskId,
          blocks: [parsed.block],
        });
      }
    }
  }
}

function checkH2(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  for (const parsed of plan) {
    let unavailable = false;
    let cursor = parsed.startMs;
    while (cursor < parsed.endMs) {
      if (!isLocallyAvailable(input, cursor)) {
        unavailable = true;
        break;
      }
      cursor += GRID_MS;
    }
    if (unavailable) {
      violations.push({
        code: 'H2',
        message: `Block for task "${parsed.block.taskId}" is outside availability.`,
        taskId: parsed.block.taskId,
        blocks: [parsed.block],
      });
    }
  }
}

function isLocallyAvailable(input: ScheduleInput, epochMs: number): boolean {
  const zoned = instantToZoned(epochMs, input.timeZone);
  const date = zoned.toPlainDate().toString();
  const weekday = zoned.dayOfWeek;
  const minute = zoned.hour * 60 + zoned.minute;
  const exceptions = input.exceptions.filter(
    (exception) => exception.date === date,
  ) as ExceptionWindow[];

  const isFullDayOff = exceptions.some(
    (exception) =>
      exception.kind === 'off' &&
      exception.startLocal === undefined &&
      exception.endLocal === undefined,
  );
  if (isFullDayOff) {
    return false;
  }

  const fromRule = input.availability.some(
    (rule) =>
      rule.weekday === weekday &&
      clockRangeContains(rule.startLocal, rule.endLocal, minute),
  );
  const fromExtra = exceptions.some(
    (exception) =>
      exception.kind === 'extra' &&
      exceptionContains(exception, minute),
  );
  const fromOff = exceptions.some(
    (exception) =>
      exception.kind === 'off' && exceptionContains(exception, minute),
  );

  return (fromRule || fromExtra) && !fromOff;
}

function clockRangeContains(startLocal: string, endLocal: string, minute: number): boolean {
  try {
    const start = clockMinutesOf(startLocal);
    const end = clockMinutesOf(endLocal);
    return end > start && minute >= start && minute < end;
  } catch {
    return false;
  }
}

function exceptionContains(exception: ExceptionWindow, minute: number): boolean {
  if (exception.startLocal === undefined && exception.endLocal === undefined) {
    return true;
  }
  if (exception.startLocal === undefined || exception.endLocal === undefined) {
    return false;
  }
  return clockRangeContains(exception.startLocal, exception.endLocal, minute);
}

function clockMinutesOf(value: string): number {
  const clock = parseClock(value);
  return clock.hour * 60 + clock.minute;
}

function checkH3(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  const byTask = groupByTask(plan);
  for (const task of input.tasks) {
    const successorBlocks = byTask.get(task.id);
    if (successorBlocks === undefined || successorBlocks.length === 0) {
      continue;
    }
    const successorFirst = successorBlocks[0];
    if (successorFirst === undefined) {
      continue;
    }
    for (const dependencyId of task.dependsOn) {
      const dependencyBlocks = byTask.get(dependencyId);
      if (dependencyBlocks === undefined || dependencyBlocks.length === 0) {
        continue;
      }
      const dependencyLast = dependencyBlocks[dependencyBlocks.length - 1];
      if (dependencyLast === undefined) {
        continue;
      }
      if (dependencyLast.endMs > successorFirst.startMs) {
        violations.push({
          code: 'H3',
          message: `Task "${task.id}" starts before dependency "${dependencyId}" finishes.`,
          taskId: task.id,
          blocks: [dependencyLast.block, successorFirst.block],
        });
      }
    }
  }
}

function checkH4(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  const byTask = groupByTask(plan);
  for (const task of input.tasks) {
    const taskBlocks = byTask.get(task.id);
    if (taskBlocks === undefined || taskBlocks.length === 0) {
      continue;
    }
    const first = taskBlocks[0];
    const last = taskBlocks[taskBlocks.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }

    if (task.earliestStartAt !== undefined) {
      const earliestMs = tryParseInstant(task.earliestStartAt);
      if (earliestMs !== undefined && first.startMs < earliestMs) {
        violations.push({
          code: 'H4',
          message: `Task "${task.id}" starts before earliestStartAt.`,
          taskId: task.id,
          blocks: [first.block],
        });
      }
    }

    if (task.dueAt !== undefined) {
      const dueMs = tryParseInstant(task.dueAt);
      const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
      if (dueMs !== undefined && last.endMs > dueMs - bufferMs) {
        violations.push({
          code: 'H4',
          message:
            bufferMs > 0
              ? `Task "${task.id}" ends inside its pre-due buffer.`
              : `Task "${task.id}" ends after its due time.`,
          taskId: task.id,
          blocks: [last.block],
        });
      }
    }
  }
}

function checkH5(
  input: ScheduleInput,
  plan: ParsedBlock[],
  opts: ValidateOptions,
  violations: Violation[],
): void {
  const byTask = groupByTask(plan);
  for (const task of input.tasks) {
    const taskBlocks = byTask.get(task.id);
    if (taskBlocks === undefined || taskBlocks.length === 0) {
      continue;
    }
    const durations = taskBlocks.map(
      (parsed) => (parsed.endMs - parsed.startMs) / MINUTE_MS,
    );

    if (!task.splittable) {
      const required = taskRequiredMinutes(task, opts.riskLevel);
      const total = durations.reduce((sum, duration) => sum + duration, 0);
      if (taskBlocks.length !== 1 || total !== required) {
        violations.push({
          code: 'H5',
          message: `Non-splittable task "${task.id}" must be one block covering ${required} minutes.`,
          taskId: task.id,
          blocks: taskBlocks.map((parsed) => parsed.block),
        });
      }
      continue;
    }

    for (let index = 0; index < taskBlocks.length; index += 1) {
      const duration = durations[index];
      if (
        duration !== undefined &&
        (duration < task.minSessionMin || duration > task.maxSessionMin)
      ) {
        const parsed = taskBlocks[index];
        violations.push({
          code: 'H5',
          message: `Task "${task.id}" has a ${duration}-minute session outside [${task.minSessionMin}, ${task.maxSessionMin}].`,
          taskId: task.id,
          ...(parsed === undefined ? {} : { blocks: [parsed.block] }),
        });
      }
    }
  }
}

function checkH6(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  const byDate = new Map<string, IntervalMs[]>();
  for (const parsed of plan) {
    for (const segment of splitByLocalDay(
      parsed.startMs,
      parsed.endMs,
      input.timeZone,
    )) {
      const list = byDate.get(segment.date) ?? [];
      list.push({ startMs: segment.startMs, endMs: segment.endMs });
      byDate.set(segment.date, list);
    }
  }

  const breakAfterMs = input.prefs.breakAfterMin * MINUTE_MS;
  const breakMs = input.prefs.breakMin * MINUTE_MS;

  for (const [date, intervals] of byDate) {
    const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
    const totalMin = sorted.reduce(
      (sum, interval) => sum + (interval.endMs - interval.startMs) / MINUTE_MS,
      0,
    );
    if (totalMin > input.prefs.maxDailyFocusMin) {
      violations.push({
        code: 'H6',
        message: `Daily focus on ${date} is ${totalMin} minutes, above ${input.prefs.maxDailyFocusMin}.`,
      });
    }

    if (breakAfterMs <= 0) {
      continue;
    }
    let runStart = sorted[0]?.startMs;
    let runEnd = sorted[0]?.endMs;
    for (const interval of sorted) {
      if (runStart === undefined || runEnd === undefined) {
        runStart = interval.startMs;
        runEnd = interval.endMs;
        continue;
      }
      if (interval.startMs - runEnd >= breakMs) {
        if (runEnd - runStart > breakAfterMs) {
          violations.push({
            code: 'H6',
            message: `Continuous focus on ${date} exceeds ${input.prefs.breakAfterMin} minutes without a ${input.prefs.breakMin}-minute break.`,
          });
        }
        runStart = interval.startMs;
        runEnd = interval.endMs;
      } else {
        runEnd = Math.max(runEnd, interval.endMs);
      }
    }
    if (
      runStart !== undefined &&
      runEnd !== undefined &&
      runEnd - runStart > breakAfterMs
    ) {
      violations.push({
        code: 'H6',
        message: `Continuous focus on ${date} exceeds ${input.prefs.breakAfterMin} minutes without a ${input.prefs.breakMin}-minute break.`,
      });
    }
  }
}

function checkH7(
  input: ScheduleInput,
  plan: ParsedBlock[],
  opts: ValidateOptions,
  violations: Violation[],
): void {
  const byTask = groupByTask(plan);
  for (const task of input.tasks) {
    const taskBlocks = byTask.get(task.id) ?? [];
    const required = taskRequiredMinutes(task, opts.riskLevel);
    const placed = taskBlocks.reduce(
      (sum, parsed) => sum + (parsed.endMs - parsed.startMs) / MINUTE_MS,
      0,
    );
    if (placed !== required) {
      const difference = Math.abs(required - placed);
      violations.push({
        code: 'H7',
        message:
          placed < required
            ? `Task "${task.id}" is short by ${difference} minutes (deficit).`
            : `Task "${task.id}" is overallocated by ${difference} minutes.`,
        taskId: task.id,
        ...(taskBlocks.length === 0
          ? {}
          : { blocks: taskBlocks.map((parsed) => parsed.block) }),
      });
    }
  }
}

function groupByTask(plan: ParsedBlock[]): Map<string, ParsedBlock[]> {
  const byTask = new Map<string, ParsedBlock[]>();
  for (const parsed of plan) {
    const list = byTask.get(parsed.block.taskId) ?? [];
    list.push(parsed);
    byTask.set(parsed.block.taskId, list);
  }
  for (const list of byTask.values()) {
    list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }
  return byTask;
}

function tryParseInstant(value: Instant): number | undefined {
  try {
    return parseInstant(value);
  } catch {
    return undefined;
  }
}

/**
 * Validate the shape and internal consistency of a `ScheduleInput` before any
 * plan is generated. G07-style impossible windows are reported as
 * `invalid_window`.
 */
export function validateInput(input: ScheduleInput): InputIssue[] {
  const issues: InputIssue[] = [];

  if (!isValidTimeZone(input.timeZone)) {
    issues.push({
      code: 'invalid_timezone',
      message: `Invalid IANA time zone: ${input.timeZone}`,
    });
  }

  const horizonStart = tryParseInstant(input.horizon.start);
  const horizonEnd = tryParseInstant(input.horizon.end);
  if (horizonStart === undefined || horizonEnd === undefined) {
    issues.push({
      code: 'invalid_instant',
      message: 'Horizon contains an invalid instant.',
    });
  } else if (horizonEnd <= horizonStart) {
    issues.push({
      code: 'invalid_window',
      message: 'Horizon end must be after horizon start.',
    });
  }

  if (tryParseInstant(input.now) === undefined) {
    issues.push({ code: 'invalid_instant', message: 'now is not a valid instant.' });
  }

  const taskIds = new Set<string>();
  for (const task of input.tasks) {
    if (taskIds.has(task.id)) {
      issues.push({
        code: 'duplicate_task',
        message: `Task id "${task.id}" is duplicated.`,
        taskId: task.id,
      });
    }
    taskIds.add(task.id);
    validateTaskWindow(task, issues);
    if (
      task.estimate.p50Min < 0 ||
      task.estimate.p90Min < 0 ||
      (task.remainingMin !== undefined && task.remainingMin < 0)
    ) {
      issues.push({
        code: 'invalid_estimate',
        message: `Task "${task.id}" has a negative estimate.`,
        taskId: task.id,
      });
    }
    if (
      task.minSessionMin < 0 ||
      task.maxSessionMin < task.minSessionMin ||
      (task.splittable && task.minSessionMin === 0)
    ) {
      issues.push({
        code: 'invalid_session',
        message: `Task "${task.id}" has invalid session bounds.`,
        taskId: task.id,
      });
    }
  }

  for (const task of input.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          message: `Task "${task.id}" depends on unknown task "${dependency}".`,
          taskId: task.id,
        });
      }
    }
  }

  if (hasDependencyCycle(input.tasks)) {
    issues.push({
      code: 'dependency_cycle',
      message: 'Task dependencies contain a cycle.',
    });
  }

  for (const rule of input.availability) {
    if (rule.weekday < 1 || rule.weekday > 7) {
      issues.push({
        code: 'invalid_window',
        message: `Availability weekday ${rule.weekday} is outside 1-7.`,
      });
      continue;
    }
    if (!isValidClockRange(rule.startLocal, rule.endLocal)) {
      issues.push({
        code: 'invalid_window',
        message: `Availability window ${rule.startLocal}-${rule.endLocal} is invalid.`,
      });
    }
  }

  for (const exception of input.exceptions) {
    if (!isValidDate(exception.date)) {
      issues.push({
        code: 'invalid_window',
        message: `Exception date "${exception.date}" is invalid.`,
      });
    }
    const hasStart = exception.startLocal !== undefined;
    const hasEnd = exception.endLocal !== undefined;
    if (hasStart !== hasEnd) {
      issues.push({
        code: 'invalid_window',
        message: `Exception on "${exception.date}" must have both start and end or neither.`,
      });
    } else if (
      hasStart &&
      hasEnd &&
      !isValidClockRange(
        exception.startLocal as string,
        exception.endLocal as string,
      )
    ) {
      issues.push({
        code: 'invalid_window',
        message: `Exception window on "${exception.date}" is invalid.`,
      });
    }
  }

  for (const commitment of input.commitments) {
    validateBlockInterval(commitment.start, commitment.end, issues, 'commitment');
  }
  for (const block of [...input.lockedBlocks, ...(input.existingBlocks ?? [])]) {
    if (tryParseInstant(block.start) === undefined || tryParseInstant(block.end) === undefined) {
      issues.push({
        code: 'invalid_instant',
        message: `Block for task "${block.taskId}" has an invalid instant.`,
        taskId: block.taskId,
      });
    }
  }

  return issues;
}

function validateTaskWindow(task: Task, issues: InputIssue[]): void {
  const earliest = task.earliestStartAt === undefined
    ? undefined
    : tryParseInstant(task.earliestStartAt);
  const due = task.dueAt === undefined ? undefined : tryParseInstant(task.dueAt);
  if ((task.earliestStartAt !== undefined && earliest === undefined) ||
      (task.dueAt !== undefined && due === undefined)) {
    issues.push({
      code: 'invalid_window',
      message: `Task "${task.id}" contains an invalid window instant.`,
      taskId: task.id,
    });
    return;
  }
  if (earliest !== undefined && due !== undefined) {
    const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
    if (earliest > due || earliest >= due - bufferMs) {
      issues.push({
        code: 'invalid_window',
        message: `Task "${task.id}" has earliestStartAt at or after its due window.`,
        taskId: task.id,
      });
    }
  }
}

function validateBlockInterval(
  start: Instant,
  end: Instant,
  issues: InputIssue[],
  label: string,
): void {
  const startMs = tryParseInstant(start);
  const endMs = tryParseInstant(end);
  if (startMs === undefined || endMs === undefined) {
    issues.push({
      code: 'invalid_instant',
      message: `${label} has an invalid instant.`,
    });
    return;
  }
  if (endMs <= startMs) {
    issues.push({
      code: 'invalid_window',
      message: `${label} ends before it starts.`,
    });
  }
}

function isValidClockRange(startLocal: string, endLocal: string): boolean {
  try {
    const start = parseClock(startLocal);
    const end = parseClock(endLocal);
    if (start.hour === 24) {
      return false;
    }
    return end.hour * 60 + end.minute > start.hour * 60 + start.minute;
  } catch {
    return false;
  }
}

function isValidDate(value: string): boolean {
  try {
    Temporal.PlainDate.from(value);
    return true;
  } catch {
    return false;
  }
}

function hasDependencyCycle(tasks: Task[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    const task = byId.get(id);
    if (task === undefined) {
      return false;
    }
    visiting.add(id);
    for (const dependency of task.dependsOn) {
      if (visit(dependency)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  for (const task of tasks) {
    if (visit(task.id)) {
      return true;
    }
  }
  return false;
}
