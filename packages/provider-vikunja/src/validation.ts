import {
  ValidationFailedError,
  epochMsToInstant,
  isInstant,
  type Id,
  type Instant,
  type SessionWindow,
  type TaskCreate,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from '@ohmydate/domain';

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in_progress', 'done']);
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;

export function fail(path: string, message: string): never {
  throw new ValidationFailedError([{ path, message }]);
}

/**
 * Accepts RFC 3339 with an explicit offset (the contract suite feeds `+09:00`)
 * but rejects timezone-less values and impossible calendar dates. The result is
 * normalised to the domain's UTC `Instant` before it reaches Vikunja.
 */
export function validateInstant(value: unknown, path = 'instant'): Instant {
  if (typeof value !== 'string' || !ISO_WITH_OFFSET.test(value)) {
    fail(path, 'expected an ISO-8601 instant including a timezone offset');
  }
  const match = ISO_WITH_OFFSET.exec(value);
  if (match === null) fail(path, 'invalid date-time');
  const [, year, month, day, hour, minute, second] = match;
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    fail(path, 'invalid date-time');
  }
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const secondNumber = Number(second);
  const localMs = Date.UTC(
    yearNumber,
    monthNumber - 1,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber,
  );
  const local = new Date(localMs);
  if (
    local.getUTCFullYear() !== yearNumber ||
    local.getUTCMonth() !== monthNumber - 1 ||
    local.getUTCDate() !== dayNumber ||
    local.getUTCHours() !== hourNumber ||
    local.getUTCMinutes() !== minuteNumber ||
    local.getUTCSeconds() !== secondNumber
  ) {
    fail(path, 'impossible calendar date-time');
  }
  const offsetMatch = /([+-])(\d{2}):(\d{2})$/.exec(value);
  let offsetMinutes = 0;
  if (offsetMatch !== null) {
    const sign = offsetMatch[1] === '-' ? -1 : 1;
    offsetMinutes = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  }
  const epochMs = localMs - offsetMinutes * 60_000;
  if (Date.parse(value) !== epochMs) fail(path, 'impossible calendar date-time');
  if (!isInstant(epochMsToInstant(epochMs))) fail(path, 'instant outside the supported range');
  return epochMsToInstant(epochMs);
}

export function validateTitle(value: unknown, path = 'title'): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (value.trim().length === 0) fail(path, 'title must not be empty');
  if (value.length > MAX_TITLE_LENGTH) {
    fail(path, `title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return value;
}

export function validateDescription(value: unknown, path = 'description'): string {
  if (typeof value !== 'string') fail(path, 'expected a string');
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    fail(path, `description must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return value;
}

export function validateStatus(value: unknown, path = 'status'): TaskStatus {
  if (typeof value !== 'string' || !TASK_STATUSES.has(value)) {
    fail(path, 'expected one of todo, in_progress, done');
  }
  return value as TaskStatus;
}

export function validateBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean');
  return value;
}

export function validatePriority(value: unknown, path = 'priority'): TaskPriority {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
    fail(path, 'expected an integer priority between 1 and 4');
  }
  return value as TaskPriority;
}

export function validateSession(value: unknown, path = 'session'): SessionWindow {
  if (typeof value !== 'object' || value === null) fail(path, 'expected a session window');
  const candidate = value as { minMinutes?: unknown; maxMinutes?: unknown };
  const min = candidate.minMinutes;
  const max = candidate.maxMinutes;
  if (typeof min !== 'number' || !Number.isInteger(min) || min < 1 || min > 1440) {
    fail(`${path}.minMinutes`, 'expected an integer between 1 and 1440');
  }
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 1440) {
    fail(`${path}.maxMinutes`, 'expected an integer between 1 and 1440');
  }
  if (min > max) fail(path, 'minMinutes must not exceed maxMinutes');
  return { minMinutes: min, maxMinutes: max };
}

export function validateDependsOn(value: unknown, path = 'dependsOn'): readonly Id[] {
  if (!Array.isArray(value)) fail(path, 'expected an array of task identifiers');
  const seen = new Set<string>();
  const ids: Id[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry)) {
      fail(`${path}[${index}]`, 'expected a UUIDv7 identifier');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      ids.push(entry as Id);
    }
  }
  return ids;
}

export interface NormalizedTaskCreate {
  readonly projectId?: Id;
  readonly title: string;
  readonly description?: string;
  readonly status: TaskStatus;
  readonly dueAt?: Instant;
  readonly splittable: boolean;
  readonly session?: SessionWindow;
  readonly priority: TaskPriority;
  readonly dependsOn: readonly Id[];
}

export interface NormalizedTaskPatch {
  readonly projectId?: Id;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskStatus;
  readonly dueAt?: Instant | null;
  readonly splittable?: boolean;
  readonly session?: SessionWindow | null;
  readonly priority?: TaskPriority;
  readonly dependsOn?: readonly Id[];
}

export function validateTaskCreate(input: TaskCreate): NormalizedTaskCreate {
  const description =
    input.description === undefined
      ? undefined
      : validateDescription(input.description, 'description');
  const dueAt =
    input.dueAt === undefined ? undefined : validateInstant(input.dueAt, 'dueAt');
  const session =
    input.session === undefined ? undefined : validateSession(input.session, 'session');

  return {
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    title: validateTitle(input.title),
    ...(description === undefined ? {} : { description }),
    status: input.status === undefined ? 'todo' : validateStatus(input.status),
    ...(dueAt === undefined ? {} : { dueAt }),
    splittable:
      input.splittable === undefined ? false : validateBoolean(input.splittable, 'splittable'),
    ...(session === undefined ? {} : { session }),
    priority: input.priority === undefined ? 2 : validatePriority(input.priority),
    dependsOn: input.dependsOn === undefined ? [] : validateDependsOn(input.dependsOn),
  };
}

export function validateTaskPatch(patch: TaskPatch): NormalizedTaskPatch {
  const result: {
    projectId?: Id;
    title?: string;
    description?: string | null;
    status?: TaskStatus;
    dueAt?: Instant | null;
    splittable?: boolean;
    session?: SessionWindow | null;
    priority?: TaskPriority;
    dependsOn?: readonly Id[];
  } = {};

  if (patch.title !== undefined) result.title = validateTitle(patch.title);
  if (patch.description !== undefined) {
    result.description =
      patch.description === null ? null : validateDescription(patch.description);
  }
  if (patch.status !== undefined) result.status = validateStatus(patch.status);
  if (patch.dueAt !== undefined) {
    result.dueAt = patch.dueAt === null ? null : validateInstant(patch.dueAt, 'dueAt');
  }
  if (patch.splittable !== undefined) {
    result.splittable = validateBoolean(patch.splittable, 'splittable');
  }
  if (patch.session !== undefined) {
    result.session = patch.session === null ? null : validateSession(patch.session);
  }
  if (patch.priority !== undefined) result.priority = validatePriority(patch.priority);
  if (patch.dependsOn !== undefined) {
    result.dependsOn = validateDependsOn(patch.dependsOn);
  }

  return result;
}
