import {
  ValidationFailedError,
  epochMsToInstant,
  instantToEpochMs,
  isInstant,
  isUuidV7,
  type Id,
  type Instant,
  type SessionWindow,
  type TaskCreate,
  type TaskPatch,
  type TaskPriority,
  type TaskStatus,
} from '@ohmydate/domain';

const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in_progress', 'done']);
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 20_000;

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

function fail(path: string, message: string): never {
  throw new ValidationFailedError([{ path, message }]);
}

export function validateOptionalId(value: unknown, path: string): Id {
  if (!isUuidV7(value)) fail(path, 'expected a UUIDv7 identifier');
  return value;
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

export function validateInstant(value: unknown, path = 'instant'): Instant {
  if (typeof value !== 'string') {
    fail(path, 'expected an ISO-8601 instant including a timezone offset');
  }
  if (isInstant(value)) {
    return epochMsToInstant(instantToEpochMs(value));
  }

  const match = ISO_WITH_ZONE.exec(value);
  if (match === null) {
    fail(path, 'expected an ISO-8601 instant including a timezone offset');
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fraction = '',
    zulu,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined
  ) {
    fail(path, 'expected an ISO-8601 instant including a timezone offset');
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const millisecond = Number(`${fraction}000`.slice(0, 3));

  let offsetMinutes = 0;
  if (zulu === undefined) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) {
      fail(path, 'invalid timezone offset');
    }
    const sign = offsetSign === '-' ? -1 : 1;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    fail(path, 'invalid calendar date-time');
  }

  try {
    return epochMsToInstant(local.getTime() - offsetMinutes * 60_000);
  } catch {
    return fail(path, 'instant outside the supported range');
  }
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
    const id = validateOptionalId(entry, `${path}[${index}]`);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export function validateTaskCreate(input: TaskCreate): NormalizedTaskCreate {
  const projectId =
    input.projectId === undefined ? undefined : validateOptionalId(input.projectId, 'projectId');
  const description =
    input.description === undefined
      ? undefined
      : validateDescription(input.description, 'description');
  const dueAt =
    input.dueAt === undefined ? undefined : validateInstant(input.dueAt, 'dueAt');
  const session =
    input.session === undefined ? undefined : validateSession(input.session, 'session');

  return {
    ...(projectId === undefined ? {} : { projectId }),
    title: validateTitle(input.title),
    ...(description === undefined ? {} : { description }),
    status: input.status === undefined ? 'todo' : validateStatus(input.status),
    ...(dueAt === undefined ? {} : { dueAt }),
    splittable:
      input.splittable === undefined ? false : validateBoolean(input.splittable, 'splittable'),
    ...(session === undefined ? {} : { session }),
    priority: input.priority === undefined ? 2 : validatePriority(input.priority),
    dependsOn:
      input.dependsOn === undefined ? [] : validateDependsOn(input.dependsOn),
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

  if (patch.projectId !== undefined) {
    result.projectId = validateOptionalId(patch.projectId, 'projectId');
  }
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
