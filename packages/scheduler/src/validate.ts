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
  GRID_NS,
  MINUTE_MS,
  instantNanoseconds,
  instantToUtc,
  instantToZoned,
  isValidTimeZone,
  parseClock,
  parseInstant,
} from './time.js';
import { taskRequiredMinutes } from './requirements.js';

interface ParsedBlock {
  block: Block;
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
 * Upper bound for every minute-valued input field (estimates, remaining
 * minutes, session bounds and preferences). Values above this are rejected as
 * invalid input instead of producing an unreasonably long plan.
 */
export const MAX_INPUT_MINUTES = 100_000;

/**
 * Maximum supported planning horizon and occupied-block span. Transition
 * enumeration walks one IANA transition at a time and allocates one cell per
 * grid slot; both are bounded by this cap so absurd ranges are rejected as
 * invalid input instead of reaching the programming-error guard.
 */
export const MAX_HORIZON_DAYS = 366;
const MAX_HORIZON_MS = MAX_HORIZON_DAYS * 24 * 60 * MINUTE_MS;

/**
 * Audit a candidate plan against hard constraints H1-H8.
 *
 * H2 uses a genuinely different oracle from `slots.ts`: each block is split at
 * every relevant local rule/exception edge, local-midnight boundary and IANA
 * transition, then each resulting segment is classified by converting its
 * midpoint to local wall time and testing raw rule membership directly. It
 * does not build or subtract availability interval unions. Overlaps use a
 * separate sorted scan. Candidate blocks must lie inside the horizon
 * (`H0_horizon`) and every block must name a known task (`H0_unknown_task`);
 * locked blocks are exempt only from the horizon check.
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
        messageCode: 'h8_invalid_time_zone',
        params: {},
      },
    ];
  }

  const candidate = parsePlanBlocks(blocks, violations);
  const locked = parsePlanBlocks(input.lockedBlocks, violations);
  const history = parsePlanBlocks(opts.historyBlocks ?? [], violations);
  // H2-H5/H7 audit the live plan only. History is audited for H1 only against
  // candidate blocks; H6 counts it only on days/runs with an audited minute
  // (06 §7.1 history-only exemption).
  const audited = [...candidate, ...locked];

  checkUnknownTaskIds(input, audited, violations);
  checkHorizon(input, candidate, violations);
  checkH1(input, candidate, audited, history, violations);
  checkH2(input, audited, violations);
  checkH3(input, audited, violations);
  checkH4(input, audited, violations);
  checkH5(input, audited, opts, violations);
  checkH6(input, audited, history, violations);
  checkH7(input, audited, opts, violations);

  return violations;
}

function checkUnknownTaskIds(
  input: ScheduleInput,
  plan: ParsedBlock[],
  violations: Violation[],
): void {
  const knownTaskIds = new Set(input.tasks.map((task) => task.id));
  for (const parsed of plan) {
    if (!knownTaskIds.has(parsed.block.taskId)) {
      violations.push({
        code: 'H0_unknown_task',
        message: `Block references unknown task "${parsed.block.taskId}".`,
        messageCode: 'h0_unknown_task',
        params: { taskId: parsed.block.taskId },
        taskId: parsed.block.taskId,
        blocks: [parsed.block],
      });
    }
  }
}

function checkHorizon(
  input: ScheduleInput,
  candidate: ParsedBlock[],
  violations: Violation[],
): void {
  const horizonStart = tryParseInstant(input.horizon.start);
  const horizonEnd = tryParseInstant(input.horizon.end);
  if (horizonStart === undefined || horizonEnd === undefined) {
    violations.push({
      code: 'H8',
      message: 'Horizon contains an invalid instant.',
      messageCode: 'h8_invalid_horizon',
      params: {},
    });
    return;
  }
  for (const parsed of candidate) {
    if (parsed.startMs < horizonStart || parsed.endMs > horizonEnd) {
      violations.push({
        code: 'H0_horizon',
        message: `Block for task "${parsed.block.taskId}" is outside the planning horizon.`,
        messageCode: 'h0_outside_horizon',
        params: blockParams(parsed),
        taskId: parsed.block.taskId,
        blocks: [parsed.block],
      });
    }
  }
}

function parsePlanBlocks(blocks: Block[], violations: Violation[]): ParsedBlock[] {
  const parsed: ParsedBlock[] = [];
  for (const block of blocks) {
    let startNs: bigint;
    let endNs: bigint;
    try {
      startNs = instantNanoseconds(block.start);
      endNs = instantNanoseconds(block.end);
    } catch {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" has an invalid instant.`,
        messageCode: 'h8_invalid_instant',
        params: { taskId: block.taskId },
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    if (startNs % 1_000_000n !== 0n || endNs % 1_000_000n !== 0n) {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" has sub-millisecond precision.`,
        messageCode: 'h8_sub_millisecond',
        params: { taskId: block.taskId },
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    if (startNs % GRID_NS !== 0n || endNs % GRID_NS !== 0n) {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" is not aligned to the 5-minute grid.`,
        messageCode: 'h8_off_grid',
        params: { taskId: block.taskId },
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    const startMs = Number(startNs / 1_000_000n);
    const endMs = Number(endNs / 1_000_000n);
    if (endMs <= startMs) {
      violations.push({
        code: 'H8',
        message: `Block for task "${block.taskId}" ends before it starts.`,
        messageCode: 'h8_end_before_start',
        params: { taskId: block.taskId },
        taskId: block.taskId,
        blocks: [block],
      });
      continue;
    }
    parsed.push({ block, startMs, endMs });
  }
  return parsed;
}

function checkH1(
  input: ScheduleInput,
  candidate: ParsedBlock[],
  audited: ParsedBlock[],
  history: ParsedBlock[],
  violations: Violation[],
): void {
  const candidateSet = new Set(candidate);
  const historySet = new Set(history);
  const occupied = [...audited, ...history];
  const sorted = [...occupied].sort(
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
        // History-only collisions are facts, not plan violations (06 §7.1).
        // A history block is audited only against a candidate block; locked
        // blocks are audited against each other and against candidates.
        const involvesHistory =
          historySet.has(current) || historySet.has(next);
        const involvesCandidate =
          candidateSet.has(current) || candidateSet.has(next);
        if (involvesHistory && !involvesCandidate) {
          continue;
        }
        violations.push({
          code: 'H1',
          ...(current.block.taskId === next.block.taskId
            ? {
                message: `Blocks for task "${current.block.taskId}" overlap.`,
                messageCode: 'h1_same_task_overlap' as const,
                params: { taskId: current.block.taskId },
              }
            : {
                message: `Blocks for tasks "${current.block.taskId}" and "${next.block.taskId}" overlap.`,
                messageCode: 'h1_tasks_overlap' as const,
                params: {
                  taskId: current.block.taskId,
                  otherTaskId: next.block.taskId,
                },
              }),
          blocks: [current.block, next.block],
        });
      }
    }
  }

  for (const parsed of audited) {
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
          messageCode: 'h1_commitment_overlap',
          params: blockParams(parsed),
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
    if (!isBlockLocallyCovered(input, parsed.startMs, parsed.endMs)) {
      violations.push({
        code: 'H2',
        message: `Block for task "${parsed.block.taskId}" is outside availability.`,
        messageCode: 'h2_outside_availability',
        params: blockParams(parsed),
        taskId: parsed.block.taskId,
        blocks: [parsed.block],
      });
    }
  }
}

/** Independent ADR-017 partition used by the H2 and H6 oracles. */
interface OracleSegment {
  date: string;
  weekday: number;
  offsetMs: number;
  startMs: number;
  endMs: number;
  localMidnightMs: number;
}

const ORACLE_DAY_MS = 24 * 60 * MINUTE_MS;
export const ORACLE_MAX_TRANSITIONS = 4096;

function oracleOffsetMsAt(timeZone: string, epochMs: number): number {
  return Math.trunc(
    Temporal.Instant.fromEpochMilliseconds(epochMs)
      .toZonedDateTimeISO(timeZone).offsetNanoseconds / 1_000_000,
  );
}

/**
 * ADR-017 steps 1-2 for the validator. The partition *shape* follows the same
 * transition-then-local-midnight principle as `time.ts`, but the date and
 * weekday labels are deliberately derived by a different method (FU-12):
 * `Temporal` converts each segment start directly in the target zone instead
 * of using the wall-clock arithmetic that produced the split. Returned
 * segments always belong to a single local date, and a date can reappear after
 * a backward transition.
 *
 * Guard: like `time.ts`, the transition walk throws `RangeError` after
 * `ORACLE_MAX_TRANSITIONS` steps. That cap is unreachable for realistic
 * horizons (roughly two transitions per year over the IANA table), so it is a
 * programming-error guard rather than a validation outcome (FU-13).
 */
function partitionByLocalDateOracle(
  timeZone: string,
  startMs: number,
  endMs: number,
): OracleSegment[] {
  if (endMs <= startMs) {
    return [];
  }

  const boundaries: number[] = [startMs];
  let cursor = Temporal.Instant.fromEpochMilliseconds(startMs)
    .toZonedDateTimeISO(timeZone);
  for (let guard = 0; ; guard += 1) {
    if (guard >= ORACLE_MAX_TRANSITIONS) {
      throw new RangeError(
        `Time zone transition walk exceeded ${ORACLE_MAX_TRANSITIONS} steps for ${timeZone}.`,
      );
    }
    const transition = cursor.getTimeZoneTransition('next');
    if (transition === null) {
      break;
    }
    const transitionMs = transition.epochMilliseconds;
    if (transitionMs >= endMs) {
      break;
    }
    if (transitionMs > startMs) {
      boundaries.push(transitionMs);
    }
    cursor = transition;
  }
  boundaries.push(endMs);
  boundaries.sort((a, b) => a - b);

  const segments: OracleSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const pieceStart = boundaries[index];
    const pieceEnd = boundaries[index + 1];
    if (
      pieceStart === undefined ||
      pieceEnd === undefined ||
      pieceEnd <= pieceStart
    ) {
      continue;
    }
    const offsetMs = oracleOffsetMsAt(timeZone, pieceStart);
    const localStartMs = pieceStart + offsetMs;
    let nextLocalMidnightMs =
      (Math.floor(localStartMs / ORACLE_DAY_MS) + 1) * ORACLE_DAY_MS;

    const pieceBoundaries: number[] = [pieceStart];
    while (nextLocalMidnightMs - offsetMs < pieceEnd) {
      const midnightMs = nextLocalMidnightMs - offsetMs;
      if (midnightMs > pieceStart) {
        pieceBoundaries.push(midnightMs);
      }
      nextLocalMidnightMs += ORACLE_DAY_MS;
    }
    pieceBoundaries.push(pieceEnd);

    for (let sub = 0; sub < pieceBoundaries.length - 1; sub += 1) {
      const segmentStart = pieceBoundaries[sub];
      const segmentEnd = pieceBoundaries[sub + 1];
      if (
        segmentStart === undefined ||
        segmentEnd === undefined ||
        segmentEnd <= segmentStart
      ) {
        continue;
      }
      const localStart = Temporal.Instant.fromEpochMilliseconds(
        segmentStart,
      ).toZonedDateTimeISO(timeZone);
      segments.push({
        date: localStart.toPlainDate().toString(),
        weekday: localStart.dayOfWeek,
        offsetMs,
        startMs: segmentStart,
        endMs: segmentEnd,
        localMidnightMs:
          Math.floor((segmentStart + offsetMs) / ORACLE_DAY_MS) *
            ORACLE_DAY_MS -
          offsetMs,
      });
    }
  }
  return segments;
}

function isBlockLocallyCovered(
  input: ScheduleInput,
  startMs: number,
  endMs: number,
): boolean {
  const boundaries = new Set<number>([startMs, endMs]);

  for (const segment of partitionByLocalDateOracle(
    input.timeZone,
    startMs,
    endMs,
  )) {
    boundaries.add(segment.startMs);
    boundaries.add(segment.endMs);
    for (const rule of input.availability) {
      if (rule.weekday !== segment.weekday) {
        continue;
      }
      addSegmentBoundary(boundaries, segment, rule.startLocal, startMs, endMs);
      addSegmentBoundary(boundaries, segment, rule.endLocal, startMs, endMs);
    }
    for (const exception of input.exceptions) {
      if (exception.date !== segment.date) {
        continue;
      }
      if (
        exception.startLocal === undefined ||
        exception.endLocal === undefined
      ) {
        continue;
      }
      addSegmentBoundary(
        boundaries,
        segment,
        exception.startLocal,
        startMs,
        endMs,
      );
      addSegmentBoundary(
        boundaries,
        segment,
        exception.endLocal,
        startMs,
        endMs,
      );
    }
  }

  const sorted = [...boundaries].sort((a, b) => a - b);
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const left = sorted[index];
    const right = sorted[index + 1];
    if (left === undefined || right === undefined || right <= left) {
      continue;
    }
    const midpoint = Math.floor((left + right) / 2);
    if (!isInstantLocallyAvailable(input, midpoint)) {
      return false;
    }
  }
  return true;
}

function addSegmentBoundary(
  boundaries: Set<number>,
  segment: OracleSegment,
  clockValue: string,
  startMs: number,
  endMs: number,
): void {
  const clock = oracleClockParts(clockValue);
  if (clock === undefined) {
    return;
  }
  const candidateMs =
    segment.localMidnightMs +
    (clock.hour * 60 + clock.minute) * MINUTE_MS;
  if (candidateMs > startMs && candidateMs < endMs) {
    boundaries.add(candidateMs);
  }
}


function isInstantLocallyAvailable(
  input: ScheduleInput,
  epochMs: number,
): boolean {
  const zoned = Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(input.timeZone);
  const date = zoned.toPlainDate().toString();
  const weekday = zoned.dayOfWeek;
  const seconds =
    zoned.hour * 3600 +
    zoned.minute * 60 +
    zoned.second +
    zoned.millisecond / 1000 +
    zoned.microsecond / 1_000_000 +
    zoned.nanosecond / 1_000_000_000;

  const exceptions = input.exceptions.filter(
    (exception) => exception.date === date,
  );
  if (
    exceptions.some(
      (exception) =>
        exception.kind === 'off' &&
        exception.startLocal === undefined &&
        exception.endLocal === undefined,
    )
  ) {
    return false;
  }

  const fromRule = input.availability.some(
    (rule) =>
      rule.weekday === weekday &&
      oracleRangeContains(rule.startLocal, rule.endLocal, seconds),
  );
  const fromExtra = exceptions.some(
    (exception) =>
      exception.kind === 'extra' && oracleExceptionContains(exception, seconds),
  );
  const fromOff = exceptions.some(
    (exception) =>
      exception.kind === 'off' && oracleExceptionContains(exception, seconds),
  );
  return (fromRule || fromExtra) && !fromOff;
}

function oracleExceptionContains(
  exception: ExceptionWindow,
  seconds: number,
): boolean {
  if (exception.startLocal === undefined && exception.endLocal === undefined) {
    return true;
  }
  if (exception.startLocal === undefined || exception.endLocal === undefined) {
    return false;
  }
  return oracleRangeContains(exception.startLocal, exception.endLocal, seconds);
}

function oracleRangeContains(
  startLocal: string,
  endLocal: string,
  seconds: number,
): boolean {
  const start = oracleClockParts(startLocal);
  const end = oracleClockParts(endLocal);
  if (start === undefined || end === undefined) {
    return false;
  }
  const startSeconds = start.hour * 3600 + start.minute * 60;
  const endSeconds = end.hour * 3600 + end.minute * 60;
  return endSeconds > startSeconds && seconds >= startSeconds && seconds < endSeconds;
}

function oracleClockParts(
  value: string,
): { hour: number; minute: number } | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    minute > 59 ||
    hour < 0 ||
    hour > 24 ||
    (hour === 24 && minute !== 0)
  ) {
    return undefined;
  }
  return { hour, minute };
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
          messageCode: 'h3_dependency_order',
          params: { taskId: task.id, dependencyId },
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
          messageCode: 'h4_before_earliest_start',
          params: { taskId: task.id, earliestStartAt: instantToUtc(earliestMs) },
          taskId: task.id,
          blocks: [first.block],
        });
      }
    }

    if (task.dueAt !== undefined) {
      const dueMs = tryParseInstant(task.dueAt);
      const bufferMs = usableBufferMinutes(task) * MINUTE_MS;
      if (dueMs !== undefined && last.endMs > dueMs - bufferMs) {
        const dueAt = instantToUtc(dueMs);
        violations.push({
          code: 'H4',
          ...(bufferMs > 0
            ? {
                message: `Task "${task.id}" ends inside its pre-due buffer.`,
                messageCode: 'h4_inside_due_buffer' as const,
                params: { taskId: task.id, dueAt, bufferMin: bufferMs / MINUTE_MS },
              }
            : {
                message: `Task "${task.id}" ends after its due time.`,
                messageCode: 'h4_after_due' as const,
                params: { taskId: task.id, dueAt },
              }),
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
    const taskBlocks = byTask.get(task.id) ?? [];
    const durations = taskBlocks.map(
      (parsed) => (parsed.endMs - parsed.startMs) / MINUTE_MS,
    );

    if (!task.splittable) {
      const required = taskRequiredMinutes(task, opts.riskLevel);
      if (required === 0) {
        // An in-progress or finished non-splittable task has no forward need:
        // the whole existing block is history (06 §7.1). It needs no new
        // block, and any candidate/locked block would be a duplicate.
        if (taskBlocks.length > 0) {
          violations.push({
            code: 'H5',
            message: `Non-splittable task "${task.id}" has no remaining minutes and must not have a block.`,
            messageCode: 'h5_unsplittable_no_remaining',
            params: { taskId: task.id },
            taskId: task.id,
            blocks: taskBlocks.map((parsed) => parsed.block),
          });
        }
        continue;
      }
      if (required < task.minSessionMin || required > task.maxSessionMin) {
        violations.push({
          code: 'H5',
          message: `Non-splittable task "${task.id}" requires ${required} minutes, outside [${task.minSessionMin}, ${task.maxSessionMin}].`,
          messageCode: 'h5_unsplittable_required_out_of_bounds',
          params: {
            taskId: task.id,
            requiredMin: required,
            minSessionMin: task.minSessionMin,
            maxSessionMin: task.maxSessionMin,
          },
          taskId: task.id,
          ...(taskBlocks.length === 0
            ? {}
            : { blocks: taskBlocks.map((parsed) => parsed.block) }),
        });
        continue;
      }
      const total = durations.reduce((sum, duration) => sum + duration, 0);
      if (taskBlocks.length > 0 && (taskBlocks.length !== 1 || total !== required)) {
        violations.push({
          code: 'H5',
          message: `Non-splittable task "${task.id}" must be one block covering ${required} minutes.`,
          messageCode: 'h5_unsplittable_single_block',
          params: { taskId: task.id, requiredMin: required },
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
        if (parsed === undefined) {
          continue;
        }
        violations.push({
          code: 'H5',
          message: `Task "${task.id}" has a ${duration}-minute session outside [${task.minSessionMin}, ${task.maxSessionMin}].`,
          messageCode: 'h5_session_out_of_bounds',
          params: {
            taskId: task.id,
            durationMin: duration,
            minSessionMin: task.minSessionMin,
            maxSessionMin: task.maxSessionMin,
            startAt: instantToUtc(parsed.startMs),
            endAt: instantToUtc(parsed.endMs),
          },
          taskId: task.id,
          blocks: [parsed.block],
        });
      }
    }
  }
}

function checkH6(
  input: ScheduleInput,
  audited: ParsedBlock[],
  history: ParsedBlock[],
  violations: Violation[],
): void {
  const auditedSet = new Set(audited);
  const byDate = new Map<string, { total: number; audited: number }>();
  for (const parsed of [...audited, ...history]) {
    for (const segment of partitionByLocalDateOracle(
      input.timeZone,
      parsed.startMs,
      parsed.endMs,
    )) {
      const minutes = (segment.endMs - segment.startMs) / MINUTE_MS;
      const entry = byDate.get(segment.date) ?? { total: 0, audited: 0 };
      entry.total += minutes;
      if (auditedSet.has(parsed)) {
        entry.audited += minutes;
      }
      byDate.set(segment.date, entry);
    }
  }

  for (const [date, entry] of byDate) {
    // A day made of history alone is a fact, not a plan violation; history
    // minutes still count on days that contain an audited minute (06 §7.1).
    if (entry.audited > 0 && entry.total > input.prefs.maxDailyFocusMin) {
      violations.push({
        code: 'H6',
        message: `Daily focus on ${date} is ${entry.total} minutes, above ${input.prefs.maxDailyFocusMin}.`,
        messageCode: 'h6_daily_focus_exceeded',
        params: {
          date,
          totalMin: entry.total,
          maxDailyFocusMin: input.prefs.maxDailyFocusMin,
        },
      });
    }
  }

  const breakAfterMs = input.prefs.breakAfterMin * MINUTE_MS;
  const breakMs = input.prefs.breakMin * MINUTE_MS;
  if (breakAfterMs <= 0) {
    return;
  }

  const sortedPlan = [...audited, ...history].sort(
    (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
  );
  let runStart: number | undefined;
  let runEnd: number | undefined;
  let runDate = '';
  let runHasAudited = false;
  const reportRun = (): void => {
    if (
      runHasAudited &&
      runStart !== undefined &&
      runEnd !== undefined &&
      runEnd - runStart > breakAfterMs
    ) {
      violations.push({
        code: 'H6',
        message: `Continuous focus starting on ${runDate} exceeds ${input.prefs.breakAfterMin} minutes without a ${input.prefs.breakMin}-minute break.`,
        messageCode: 'h6_break_missing',
        params: {
          date: runDate,
          breakAfterMin: input.prefs.breakAfterMin,
          breakMin: input.prefs.breakMin,
        },
      });
    }
  };
  for (const interval of sortedPlan) {
    if (runStart === undefined || runEnd === undefined) {
      runStart = interval.startMs;
      runEnd = interval.endMs;
      runHasAudited = auditedSet.has(interval);
      runDate = instantToZoned(runStart, input.timeZone)
        .toPlainDate()
        .toString();
      continue;
    }
    if (interval.startMs - runEnd >= breakMs) {
      reportRun();
      runStart = interval.startMs;
      runEnd = interval.endMs;
      runHasAudited = auditedSet.has(interval);
      runDate = instantToZoned(runStart, input.timeZone)
        .toPlainDate()
        .toString();
    } else {
      runEnd = Math.max(runEnd, interval.endMs);
      runHasAudited = runHasAudited || auditedSet.has(interval);
    }
  }
  reportRun();
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
        ...(placed < required
          ? {
              message: `Task "${task.id}" is short by ${difference} minutes (deficit).`,
              messageCode: 'h7_deficit' as const,
              params: { taskId: task.id, shortMin: difference },
            }
          : {
              message: `Task "${task.id}" is overallocated by ${difference} minutes.`,
              messageCode: 'h7_overallocated' as const,
              params: { taskId: task.id, excessMin: difference },
            }),
        taskId: task.id,
        ...(taskBlocks.length === 0
          ? {}
          : { blocks: taskBlocks.map((parsed) => parsed.block) }),
      });
    }
  }
}

/** Coded params for a finding about one parsed block (UTC instants, FU-62). */
function blockParams(parsed: ParsedBlock): {
  taskId: string;
  startAt: Instant;
  endAt: Instant;
} {
  return {
    taskId: parsed.block.taskId,
    startAt: instantToUtc(parsed.startMs),
    endAt: instantToUtc(parsed.endMs),
  };
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
      messageCode: 'input_invalid_time_zone',
      params: {},
    });
  }

  const horizonStart = tryParseInstant(input.horizon.start);
  const horizonEnd = tryParseInstant(input.horizon.end);
  if (horizonStart === undefined || horizonEnd === undefined) {
    issues.push({
      code: 'invalid_instant',
      message: 'Horizon contains an invalid instant.',
      messageCode: 'input_invalid_horizon_instant',
      params: {},
    });
  } else if (horizonEnd <= horizonStart) {
    issues.push({
      code: 'invalid_window',
      message: 'Horizon end must be after horizon start.',
      messageCode: 'input_horizon_not_increasing',
      params: {},
    });
  } else if (horizonEnd - horizonStart > MAX_HORIZON_MS) {
    issues.push({
      code: 'invalid_input',
      message: `Horizon spans more than ${MAX_HORIZON_DAYS} days, the maximum supported length.`,
      messageCode: 'input_horizon_too_long',
      params: { maxDays: MAX_HORIZON_DAYS },
    });
  }

  if (tryParseInstant(input.now) === undefined) {
    issues.push({
      code: 'invalid_instant',
      message: 'now is not a valid instant.',
      messageCode: 'input_invalid_now',
      params: {},
    });
  }

  const taskIds = new Set<string>();
  for (const task of input.tasks) {
    if (taskIds.has(task.id)) {
      issues.push({
        code: 'duplicate_task',
        message: `Task id "${task.id}" is duplicated.`,
        messageCode: 'input_duplicate_task',
        params: { taskId: task.id },
        taskId: task.id,
      });
    }
    taskIds.add(task.id);
    // Validate every minute-valued field before window/H4 arithmetic can use
    // it (a non-finite buffer would otherwise bypass the deadline).
    const estimateFields = [
      task.estimate.p50Min,
      task.estimate.p90Min,
      ...(task.remainingMin === undefined ? [] : [task.remainingMin]),
    ];
    if (estimateFields.some((value) => !isWholeMinute(value))) {
      issues.push({
        code: 'invalid_estimate',
        message: `Task "${task.id}" has an estimate that is not a whole number of minutes between 0 and ${MAX_INPUT_MINUTES}.`,
        messageCode: 'input_invalid_estimate',
        params: { taskId: task.id, maxMin: MAX_INPUT_MINUTES },
        taskId: task.id,
      });
    }
    if (
      task.bufferBeforeDueMin !== undefined &&
      !isWholeMinute(task.bufferBeforeDueMin)
    ) {
      issues.push({
        code: 'invalid_estimate',
        message: `Task "${task.id}" has a bufferBeforeDueMin that is not a whole number of minutes between 0 and ${MAX_INPUT_MINUTES}.`,
        messageCode: 'input_invalid_buffer',
        params: { taskId: task.id, maxMin: MAX_INPUT_MINUTES },
        taskId: task.id,
      });
    }
    if (
      !isWholeMinute(task.minSessionMin) ||
      !isWholeMinute(task.maxSessionMin)
    ) {
      issues.push({
        code: 'invalid_estimate',
        message: `Task "${task.id}" has a session bound that is not a whole number of minutes between 0 and ${MAX_INPUT_MINUTES}.`,
        messageCode: 'input_invalid_session_minutes',
        params: { taskId: task.id, maxMin: MAX_INPUT_MINUTES },
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
        messageCode: 'input_invalid_session_bounds',
        params: { taskId: task.id },
        taskId: task.id,
      });
    }
    validateTaskWindow(task, issues);
  }

  for (const [name, value] of [
    ['maxDailyFocusMin', input.prefs.maxDailyFocusMin],
    ['breakAfterMin', input.prefs.breakAfterMin],
    ['breakMin', input.prefs.breakMin],
  ] as const) {
    if (!isWholeMinute(value)) {
      issues.push({
        code: 'invalid_input',
        message: `prefs.${name} must be a whole number of minutes between 0 and ${MAX_INPUT_MINUTES}.`,
        messageCode: 'input_invalid_preference',
        params: { field: name, maxMin: MAX_INPUT_MINUTES },
      });
    }
  }

  for (const task of input.tasks) {
    for (const dependency of task.dependsOn) {
      if (!taskIds.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          message: `Task "${task.id}" depends on unknown task "${dependency}".`,
          messageCode: 'input_unknown_dependency',
          params: { taskId: task.id, dependencyId: dependency },
          taskId: task.id,
        });
      }
    }
  }

  if (hasDependencyCycle(input.tasks)) {
    issues.push({
      code: 'dependency_cycle',
      message: 'Task dependencies contain a cycle.',
      messageCode: 'input_dependency_cycle',
      params: {},
    });
  }

  for (const rule of input.availability) {
    if (rule.weekday < 1 || rule.weekday > 7) {
      issues.push({
        code: 'invalid_window',
        message: `Availability weekday ${rule.weekday} is outside 1-7.`,
        messageCode: 'input_invalid_weekday',
        params: {},
      });
      continue;
    }
    if (!isValidClockRange(rule.startLocal, rule.endLocal)) {
      issues.push({
        code: 'invalid_window',
        message: `Availability window ${rule.startLocal}-${rule.endLocal} is invalid.`,
        messageCode: 'input_invalid_availability_window',
        params: { weekday: rule.weekday },
      });
    }
  }

  for (const exception of input.exceptions) {
    if (!isValidDate(exception.date)) {
      issues.push({
        code: 'invalid_window',
        message: `Exception date "${exception.date}" is invalid.`,
        messageCode: 'input_invalid_exception_date',
        params: {},
      });
    }
    const hasStart = exception.startLocal !== undefined;
    const hasEnd = exception.endLocal !== undefined;
    if (hasStart !== hasEnd) {
      issues.push({
        code: 'invalid_window',
        message: `Exception on "${exception.date}" must have both start and end or neither.`,
        messageCode: 'input_exception_partial_window',
        params: {},
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
        messageCode: 'input_invalid_exception_window',
        params: {},
      });
    }
  }

  const horizonUsable =
    horizonStart !== undefined &&
    horizonEnd !== undefined &&
    horizonEnd > horizonStart;
  for (const commitment of input.commitments) {
    validateCommitmentInterval(commitment.start, commitment.end, issues);
    const startMs = tryParseInstant(commitment.start);
    const endMs = tryParseInstant(commitment.end);
    if (startMs === undefined || endMs === undefined) {
      continue;
    }
    // The occupied-span cap exists to bound transition enumeration after
    // clipping. Commitments wholly outside the horizon are irrelevant, and
    // partially overlapping ones only cost their clipped span (FU-43).
    let effectiveSpanMs = endMs - startMs;
    if (horizonUsable) {
      const overlapsHorizon = startMs < horizonEnd && endMs > horizonStart;
      effectiveSpanMs = overlapsHorizon
        ? Math.min(endMs, horizonEnd) - Math.max(startMs, horizonStart)
        : 0;
    }
    if (effectiveSpanMs > MAX_HORIZON_MS) {
      issues.push({
        code: 'invalid_input',
        message: `Commitment spans more than ${MAX_HORIZON_DAYS} days, the maximum supported length.`,
        messageCode: 'input_commitment_too_long',
        params: { maxDays: MAX_HORIZON_DAYS },
      });
    }
  }
  for (const block of [...input.lockedBlocks, ...(input.existingBlocks ?? [])]) {
    if (!taskIds.has(block.taskId)) {
      issues.push({
        code: 'unknown_task',
        message: `Block references unknown task "${block.taskId}".`,
        messageCode: 'input_unknown_block_task',
        params: { taskId: block.taskId },
        taskId: block.taskId,
      });
    }
    let startNs: bigint;
    let endNs: bigint;
    try {
      startNs = instantNanoseconds(block.start);
      endNs = instantNanoseconds(block.end);
    } catch {
      issues.push({
        code: 'invalid_instant',
        message: `Block for task "${block.taskId}" has an invalid instant.`,
        messageCode: 'input_invalid_block_instant',
        params: { taskId: block.taskId },
        taskId: block.taskId,
      });
      continue;
    }
    if (startNs % 1_000_000n !== 0n || endNs % 1_000_000n !== 0n) {
      issues.push({
        code: 'invalid_precision',
        message: `Block for task "${block.taskId}" has sub-millisecond precision.`,
        messageCode: 'input_block_sub_millisecond',
        params: { taskId: block.taskId },
        taskId: block.taskId,
      });
      continue;
    }
    if (startNs % GRID_NS !== 0n || endNs % GRID_NS !== 0n) {
      issues.push({
        code: 'invalid_precision',
        message: `Block for task "${block.taskId}" is not on the 5-minute grid.`,
        messageCode: 'input_block_off_grid',
        params: { taskId: block.taskId },
        taskId: block.taskId,
      });
      continue;
    }
    const startMs = Number(startNs / 1_000_000n);
    const endMs = Number(endNs / 1_000_000n);
    if (endMs <= startMs) {
      issues.push({
        code: 'invalid_window',
        message: `Block for task "${block.taskId}" ends before it starts.`,
        messageCode: 'input_block_end_before_start',
        params: { taskId: block.taskId },
        taskId: block.taskId,
      });
    } else if (endMs - startMs > MAX_HORIZON_MS) {
      issues.push({
        code: 'invalid_input',
        message: `Block for task "${block.taskId}" spans more than ${MAX_HORIZON_DAYS} days, the maximum supported length.`,
        messageCode: 'input_block_too_long',
        params: { taskId: block.taskId, maxDays: MAX_HORIZON_DAYS },
        taskId: block.taskId,
      });
    }
  }

  return issues;
}

/** Whole minutes in `[0, MAX_INPUT_MINUTES]`; rejects NaN and Infinity. */
function isWholeMinute(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_INPUT_MINUTES
  );
}

/** A usable buffer value, or 0 when the input is invalid (rejected earlier). */
function usableBufferMinutes(task: Task): number {
  const value = task.bufferBeforeDueMin;
  return value !== undefined && isWholeMinute(value) ? value : 0;
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
      messageCode: 'input_invalid_task_window_instant',
      params: { taskId: task.id },
      taskId: task.id,
    });
    return;
  }
  if (earliest !== undefined && due !== undefined) {
    const bufferMs = usableBufferMinutes(task) * MINUTE_MS;
    if (earliest > due || earliest >= due - bufferMs) {
      issues.push({
        code: 'invalid_window',
        message: `Task "${task.id}" has earliestStartAt at or after its due window.`,
        messageCode: 'input_task_window_empty',
        params: { taskId: task.id },
        taskId: task.id,
      });
    }
  }
}

function validateCommitmentInterval(
  start: Instant,
  end: Instant,
  issues: InputIssue[],
): void {
  const startMs = tryParseInstant(start);
  const endMs = tryParseInstant(end);
  if (startMs === undefined || endMs === undefined) {
    issues.push({
      code: 'invalid_instant',
      message: 'commitment has an invalid instant.',
      messageCode: 'input_commitment_invalid_instant',
      params: {},
    });
    return;
  }
  if (endMs <= startMs) {
    issues.push({
      code: 'invalid_window',
      message: 'commitment ends before it starts.',
      messageCode: 'input_commitment_end_before_start',
      params: {},
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
