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

/**
 * Per-task capacity accounting before generation.
 *
 * Availability is measured inside each task's own effective window. Dependency
 * windows are chained in topological order using the optimistic assumption
 * that a predecessor starts at its window start. Consequently the per-task
 * numbers are an explanation/upper bound, not a contention-aware schedule;
 * `total` is their sum.
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

  const order = topologicalOrder(input.tasks);
  const windowStartById = new Map<string, number>();
  const results: TaskDeficit[] = [];

  for (const task of order) {
    const requiredMin = requiredById.get(task.id) ?? 0;
    const earliestMs =
      task.earliestStartAt === undefined
        ? horizonStartMs
        : parseInstant(task.earliestStartAt);

    let dependencyReadyMs = horizonStartMs;
    for (const dependencyId of task.dependsOn) {
      const dependencyStart = windowStartById.get(dependencyId);
      const dependencyRequired = requiredById.get(dependencyId);
      if (dependencyStart !== undefined && dependencyRequired !== undefined) {
        dependencyReadyMs = Math.max(
          dependencyReadyMs,
          dependencyStart + dependencyRequired * MINUTE_MS,
        );
      }
    }

    const windowStartMs = Math.max(horizonStartMs, earliestMs, dependencyReadyMs);
    const bufferMs = (task.bufferBeforeDueMin ?? 0) * MINUTE_MS;
    const windowEndMs =
      task.dueAt === undefined
        ? horizonEndMs
        : parseInstant(task.dueAt) - bufferMs;

    let availableMs = 0;
    if (windowEndMs > windowStartMs) {
      for (const slot of slots) {
        availableMs += overlapMs(
          windowStartMs,
          windowEndMs,
          slot.startMs,
          slot.endMs,
        );
      }
    }

    const availableBeforeDueMin = availableMs / MINUTE_MS;
    const deficitMin = Math.max(0, requiredMin - availableBeforeDueMin);
    results.push({
      taskId: task.id,
      requiredMin,
      availableBeforeDueMin,
      deficitMin,
    });
    windowStartById.set(task.id, windowStartMs);
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
