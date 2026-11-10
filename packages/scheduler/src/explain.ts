import type {
  DeficitReport,
  ScheduleInput,
  Task,
  TaskDeficit,
} from './types.js';
import { computeAvailableSlots } from './slots.js';
import { taskRequiredMinutes } from './requirements.js';
import { MINUTE_MS, overlapMs, parseInstant } from './time.js';

interface SlotMs {
  startMs: number;
  endMs: number;
}

interface LockedInterval {
  startMs: number;
  endMs: number;
}

interface Consumption {
  completionMs: number;
}

/**
 * Per-task capacity accounting before generation.
 *
 * Locked blocks are treated as already placed work: their minutes are credited
 * against the task requirement, and their latest end contributes to the
 * readiness of successors. For the remaining work, availability is measured
 * inside each task's own effective window, then an optimistic completion is
 * found by consuming real available intervals in order. Successors start after
 * the predecessor's optimistic completion (or locked completion, if later).
 *
 * Per-task availability ignores contention between independent tasks, so
 * `total` is the sum of per-task values and remains an explanatory upper bound.
 */
export function deficit(input: ScheduleInput): DeficitReport {
  const riskLevel = input.prefs.riskLevel;
  const horizonStartMs = parseInstant(input.horizon.start);
  const horizonEndMs = parseInstant(input.horizon.end);
  const slots: SlotMs[] = computeAvailableSlots(input).map((slot) => ({
    startMs: parseInstant(slot.start),
    endMs: parseInstant(slot.end),
  }));

  const requiredById = new Map<string, number>();
  for (const task of input.tasks) {
    requiredById.set(task.id, taskRequiredMinutes(task, riskLevel));
  }

  const lockedByTask = new Map<string, LockedInterval[]>();
  for (const block of input.lockedBlocks) {
    const startMs = tryParseInstant(block.start);
    const endMs = tryParseInstant(block.end);
    if (startMs === undefined || endMs === undefined || endMs <= startMs) {
      continue;
    }
    const list = lockedByTask.get(block.taskId) ?? [];
    list.push({ startMs, endMs });
    lockedByTask.set(block.taskId, list);
  }

  const order = topologicalOrder(input.tasks);
  const completionById = new Map<string, number>();
  const results: TaskDeficit[] = [];

  for (const task of order) {
    const requiredMin = requiredById.get(task.id) ?? 0;
    const locked = lockedByTask.get(task.id) ?? [];
    const lockedMin = locked.reduce(
      (sum, interval) => sum + (interval.endMs - interval.startMs) / MINUTE_MS,
      0,
    );
    const lockedCompletionMs = locked.reduce(
      (latest, interval) => Math.max(latest, interval.endMs),
      Number.NEGATIVE_INFINITY,
    );
    const remainingMin = Math.max(0, requiredMin - lockedMin);

    const earliestMs =
      task.earliestStartAt === undefined
        ? horizonStartMs
        : parseInstant(task.earliestStartAt);

    let dependencyReadyMs = horizonStartMs;
    for (const dependencyId of task.dependsOn) {
      const dependencyCompletion = completionById.get(dependencyId);
      if (dependencyCompletion !== undefined) {
        dependencyReadyMs = Math.max(dependencyReadyMs, dependencyCompletion);
      }
    }

    const windowStartMs = Math.max(horizonStartMs, earliestMs, dependencyReadyMs);
    const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
    const windowEndMs =
      task.dueAt === undefined
        ? horizonEndMs
        : parseInstant(task.dueAt) - bufferMs;

    let freeAvailableMs = 0;
    if (windowEndMs > windowStartMs) {
      for (const slot of slots) {
        freeAvailableMs += overlapMs(
          windowStartMs,
          windowEndMs,
          slot.startMs,
          slot.endMs,
        );
      }
    }

    const availableBeforeDueMin = freeAvailableMs / MINUTE_MS + lockedMin;
    const deficitMin = Math.max(0, requiredMin - availableBeforeDueMin);

    let completionMs = Math.max(windowStartMs, lockedCompletionMs);
    if (remainingMin > 0) {
      const consumed = consumeAvailable(
        slots,
        windowStartMs,
        windowEndMs,
        remainingMin,
      );
      completionMs = Math.max(completionMs, consumed.completionMs);
    }
    completionById.set(task.id, completionMs);

    results.push({
      taskId: task.id,
      requiredMin,
      availableBeforeDueMin,
      deficitMin,
    });
  }

  const total = results.reduce(
    (sum, result) => ({
      requiredMin: sum.requiredMin + result.requiredMin,
      availableBeforeDueMin:
        sum.availableBeforeDueMin + result.availableBeforeDueMin,
      deficitMin: sum.deficitMin + result.deficitMin,
    }),
    { requiredMin: 0, availableBeforeDueMin: 0, deficitMin: 0 },
  );

  return { riskLevel, tasks: results, total };
}

function consumeAvailable(
  slots: SlotMs[],
  startMs: number,
  endMs: number,
  minutes: number,
): Consumption {
  if (minutes <= 0 || endMs <= startMs) {
    return { completionMs: Math.max(startMs, endMs) };
  }
  let remaining = minutes;
  let completionMs = startMs;
  for (const slot of slots) {
    const slotStart = Math.max(startMs, slot.startMs);
    const slotEnd = Math.min(endMs, slot.endMs);
    if (slotEnd <= slotStart) {
      continue;
    }
    const take = Math.min(remaining, (slotEnd - slotStart) / MINUTE_MS);
    remaining -= take;
    completionMs = slotStart + take * MINUTE_MS;
    if (remaining <= 0) {
      return { completionMs };
    }
  }
  return { completionMs: Math.max(completionMs, endMs) };
}

function tryParseInstant(value: string): number | undefined {
  try {
    return parseInstant(value);
  } catch {
    return undefined;
  }
}

function topologicalOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const task of tasks) {
    const knownDependencies = task.dependsOn.filter((id) => byId.has(id));
    indegree.set(task.id, knownDependencies.length);
    for (const dependencyId of knownDependencies) {
      const list = dependents.get(dependencyId) ?? [];
      list.push(task.id);
      dependents.set(dependencyId, list);
    }
  }

  const queue = tasks
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .map((task) => task.id);
  const ordered: Task[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const task = byId.get(id);
    if (task !== undefined) {
      ordered.push(task);
    }
    for (const dependentId of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining === 0) {
        queue.push(dependentId);
      }
    }
  }

  for (const task of tasks) {
    if (!seen.has(task.id)) {
      ordered.push(task);
    }
  }
  return ordered;
}
