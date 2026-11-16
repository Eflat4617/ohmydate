import { expect, type APIResponse, type Page } from '@playwright/test';
import type { E2EState } from './state';

export interface AvailabilityDto {
  readonly version: number;
  readonly timeZone: string;
  readonly rules: readonly {
    readonly weekday: number;
    readonly startLocal: string;
    readonly endLocal: string;
    readonly kind: 'work' | 'focus';
  }[];
  readonly exceptions: readonly {
    readonly date: string;
    readonly kind: 'off' | 'extra';
    readonly startLocal?: string;
    readonly endLocal?: string;
  }[];
  readonly prefs: {
    readonly maxDailyFocusMin: number;
    readonly breakAfterMin: number;
    readonly breakMin: number;
    readonly dayStartLocal: string;
    readonly dayEndLocal: string;
    readonly riskLevel: 'p50' | 'p90';
  };
}

export interface IntakeSessionDto {
  readonly id: string;
  readonly goalId?: string;
  readonly state: string;
  readonly version: number;
  readonly questions?: readonly {
    readonly field: string;
    readonly prompt: string;
    readonly required: boolean;
  }[];
  readonly draft?: {
    readonly steps: readonly {
      readonly key: string;
      readonly title: string;
    }[];
  };
}

export interface PlanDto {
  readonly id: string;
  readonly version: number;
  readonly availabilityVersion: number;
  readonly currentVersionId?: string;
  readonly horizon: { readonly start: string; readonly end: string };
  readonly timeZone: string;
  readonly candidates: readonly {
    readonly id: string;
    readonly policy: string;
    readonly feasible: boolean;
    readonly blocks: readonly {
      readonly taskId: string;
      readonly startAt: string;
      readonly endAt: string;
    }[];
  }[];
}

export interface PreviewEditDto {
  readonly feasible: boolean;
  readonly violations: readonly { readonly code: string; readonly message?: string }[];
  readonly deficitMin: number;
}

export interface TaskConstraintsDto {
  readonly id: string;
  readonly dueAt?: string;
  readonly dependsOn: readonly string[];
}

export interface IntervalDto {
  readonly startAt: string;
  readonly endAt: string;
}

async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const cookie = cookies.find((candidate) => candidate.name === 'csrf');
  if (cookie === undefined) throw new Error('csrf cookie is missing');
  return cookie.value;
}

export async function apiFetch(
  page: Page,
  state: E2EState,
  path: string,
  options: {
    readonly method?: string;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
  } = {},
): Promise<APIResponse> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = await csrfToken(page);
    if (options.body !== undefined) headers['content-type'] = 'application/json';
  }
  return page.request.fetch(`${state.apiUrl}/api/v1${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { data: options.body }),
  });
}

export function idempotencyKey(): string {
  return crypto.randomUUID();
}

export async function expectOk(response: APIResponse, describe: string): Promise<unknown> {
  const body = await response.text();
  expect(response.ok(), `${describe} -> ${response.status()}: ${body}`).toBeTruthy();
  return body.length === 0 ? null : (JSON.parse(body) as unknown);
}

export async function getAvailability(
  page: Page,
  state: E2EState,
): Promise<AvailabilityDto> {
  const response = await apiFetch(page, state, '/availability');
  return (await expectOk(response, 'GET /availability')) as AvailabilityDto;
}

export async function setWeeklyAvailability(
  page: Page,
  state: E2EState,
): Promise<AvailabilityDto> {
  const current = await getAvailability(page, state);
  const rules = Array.from({ length: 5 }, (_, index) => index + 1).flatMap((weekday) => [
    {
      weekday,
      startLocal: '09:00',
      endLocal: '11:00',
      kind: 'work' as const,
    },
    {
      weekday,
      startLocal: '14:00',
      endLocal: '16:00',
      kind: 'work' as const,
    },
  ]);
  const response = await apiFetch(page, state, '/availability', {
    method: 'PUT',
    headers: {
      'If-Match': `W/"availability:${current.version}"`,
      'Idempotency-Key': idempotencyKey(),
    },
    body: {
      timeZone: 'UTC',
      rules,
      exceptions: [],
      prefs: {
        maxDailyFocusMin: 240,
        breakAfterMin: 600,
        breakMin: 15,
        dayStartLocal: '08:00',
        dayEndLocal: '22:00',
        riskLevel: 'p50',
      },
    },
  });
  return (await expectOk(response, 'PUT /availability')) as AvailabilityDto;
}

export async function createIntakeGoal(
  page: Page,
  state: E2EState,
  input: {
    readonly title: string;
    readonly description?: string;
    readonly dueAt?: string;
    readonly estimatedScope?: 'small' | 'medium' | 'large';
    readonly maxFocusMinutes?: number;
  },
): Promise<IntakeSessionDto> {
  const response = await apiFetch(page, state, '/intake-sessions', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { input },
  });
  return (await expectOk(response, 'POST /intake-sessions')) as IntakeSessionDto;
}

export async function answerIntakeWithSkip(
  page: Page,
  state: E2EState,
  initial: IntakeSessionDto,
): Promise<IntakeSessionDto> {
  let session = initial;
  for (let round = 0; round < 6; round += 1) {
    const questions = session.questions ?? [];
    if (questions.length === 0) return session;
    const response = await apiFetch(page, state, `/intake-sessions/${session.id}/answers`, {
      method: 'POST',
      headers: {
        'If-Match': `W/"${session.version}"`,
        'Idempotency-Key': idempotencyKey(),
      },
      body: {
        answers: questions.map((question) => ({
          questionKey: question.field,
          action: 'skip',
        })),
      },
    });
    session = (await expectOk(response, 'POST /intake-sessions/{id}/answers')) as IntakeSessionDto;
  }
  throw new Error('intake interview did not finish within six rounds');
}

export async function replaceIntakeDraftWithSteps(
  page: Page,
  state: E2EState,
  session: IntakeSessionDto,
  steps: readonly Record<string, unknown>[],
): Promise<IntakeSessionDto> {
  const response = await apiFetch(page, state, `/intake-sessions/${session.id}/draft`, {
    method: 'PATCH',
    headers: {
      'If-Match': `W/"${session.version}"`,
      'Idempotency-Key': idempotencyKey(),
    },
    body: { steps },
  });
  await expectOk(response, 'PATCH /intake-sessions/{id}/draft');
  const etag = response.headers()['etag'] ?? '';
  const match = /W\/"(\d+)"/.exec(etag);
  if (match?.[1] === undefined) throw new Error(`draft PATCH returned no version ETag: ${etag}`);
  return { ...session, version: Number(match[1]) };
}

export async function replaceIntakeDraftWithIndependentSteps(
  page: Page,
  state: E2EState,
  session: IntakeSessionDto,
): Promise<IntakeSessionDto> {
  const steps = [
    {
      key: 's1',
      title: 'Collect the inputs',
      deliverable: 'Inputs',
      doneCriteria: 'Inputs collected',
      kind: 'prep',
      estimate: { p50Minutes: 60, p90Minutes: 90 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's2',
      title: 'Draft the deliverable',
      deliverable: 'Draft',
      doneCriteria: 'Draft exists',
      kind: 'work',
      estimate: { p50Minutes: 120, p90Minutes: 180 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's3',
      title: 'Polish the detail',
      deliverable: 'Polished draft',
      doneCriteria: 'Detail review complete',
      kind: 'work',
      estimate: { p50Minutes: 90, p90Minutes: 120 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's4',
      title: 'Review the result',
      deliverable: 'Reviewed result',
      doneCriteria: 'Review notes resolved',
      kind: 'review',
      estimate: { p50Minutes: 30, p90Minutes: 60 },
      dependsOn: [],
      splittable: false,
    },
  ];
  return replaceIntakeDraftWithSteps(page, state, session, steps);
}

export async function approveIntakeDraft(
  page: Page,
  state: E2EState,
  session: IntakeSessionDto,
): Promise<IntakeSessionDto> {  const response = await apiFetch(page, state, `/intake-sessions/${session.id}/draft:approve`, {
    method: 'POST',
    headers: {
      'If-Match': `W/"${session.version}"`,
      'Idempotency-Key': idempotencyKey(),
    },
  });
  return (await expectOk(
    response,
    'POST /intake-sessions/{id}/draft:approve',
  )) as IntakeSessionDto;
}

export async function createApprovedGoal(
  page: Page,
  state: E2EState,
  title: string,
  options: {
    readonly estimatedScope?: 'small' | 'medium' | 'large';
    readonly independentDraft?: boolean;
    /** "Now" for the due date; pass the simulated clock when E2E_FAKE_NOW is used. */
    readonly nowMs?: number;
  } = {},
): Promise<IntakeSessionDto> {
  const dueAt = new Date((options.nowMs ?? Date.now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const created = await createIntakeGoal(page, state, {
    title,
    description: 'E2E planning goal seeded for the comparison flow.',
    dueAt,
    ...(options.estimatedScope === undefined ? {} : { estimatedScope: options.estimatedScope }),
  });
  const answered = await answerIntakeWithSkip(page, state, created);
  const prepared =
    options.independentDraft === true
      ? await replaceIntakeDraftWithIndependentSteps(page, state, answered)
      : answered;
  const approved = await approveIntakeDraft(page, state, prepared);
  expect(approved.goalId, 'approved intake session should expose its goal id').toBeTruthy();
  return approved;
}

export async function createApprovedGoalWithSingleStep(
  page: Page,
  state: E2EState,
  title: string,
  options: { readonly nowMs?: number } = {},
): Promise<IntakeSessionDto> {
  const dueAt = new Date((options.nowMs ?? Date.now()) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const created = await createIntakeGoal(page, state, {
    title,
    description: 'E2E single-block goal for the two-plan regression.',
    dueAt,
    estimatedScope: 'small',
    maxFocusMinutes: 30,
  });
  const answered = await answerIntakeWithSkip(page, state, created);
  const prepared = await replaceIntakeDraftWithSteps(page, state, answered, [
    {
      key: 's1',
      title: `${title} prep`,
      deliverable: 'Inputs',
      doneCriteria: 'Inputs collected',
      kind: 'prep',
      estimate: { p50Minutes: 15, p90Minutes: 25 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's2',
      title: `${title} work`,
      deliverable: 'Deliverable',
      doneCriteria: 'Deliverable exists',
      kind: 'work',
      estimate: { p50Minutes: 15, p90Minutes: 25 },
      dependsOn: [],
      splittable: true,
    },
    {
      key: 's3',
      title: `${title} review`,
      deliverable: 'Review',
      doneCriteria: 'Review complete',
      kind: 'review',
      estimate: { p50Minutes: 15, p90Minutes: 25 },
      dependsOn: [],
      splittable: false,
    },
  ]);
  const approved = await approveIntakeDraft(page, state, prepared);
  expect(approved.goalId, 'approved intake session should expose its goal id').toBeTruthy();
  return approved;
}

export async function createPlanFromGoal(
  page: Page,
  state: E2EState,
  goalId: string,
  options: { readonly nowMs?: number } = {},
): Promise<PlanDto> {
  const start = new Date(options.nowMs ?? Date.now());
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);
  const response = await apiFetch(page, state, '/plans', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: {
      scope: { goalId },
      horizon: { start: start.toISOString(), end: end.toISOString() },
      policies: ['front_loaded', 'balanced', 'focus_blocked'],
    },
  });
  return (await expectOk(response, 'POST /plans')) as PlanDto;
}

export async function createOverlappingCommitment(
  page: Page,
  state: E2EState,
  startAt: string,
  endAt: string,
  title: string,
): Promise<void> {
  const response = await apiFetch(page, state, '/commitments', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey() },
    body: { title, startAt, endAt, timeZone: 'UTC' },
  });
  await expectOk(response, 'POST /commitments');
}

export interface ApprovedBlockDto {
  readonly id: string;
  readonly planVersionId: string;
  readonly taskId: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly status: string;
  readonly locked: boolean;
  readonly version: number;
}

export interface PlanVersionDto {
  readonly id: string;
  readonly planId: string;
  readonly seq: number;
  readonly availabilityVersion: number;
  readonly version: number;
  readonly blocks: readonly ApprovedBlockDto[];
}

export interface WorkSessionDto {
  readonly id: string;
  readonly taskId: string;
  readonly blockId?: string;
  readonly state: 'active' | 'paused' | 'completed' | 'abandoned';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly focusedSec: number;
  readonly pausedSec: number;
  readonly clientId: string;
  readonly version: number;
}

export interface NotificationDto {
  readonly id: string;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly scheduledAt: string;
  readonly sentAt?: string;
  readonly channel: string;
  readonly state: string;
  readonly version: number;
}

export async function setContinuousWeeklyAvailability(
  page: Page,
  state: E2EState,
  maxDailyFocusMin = 600,
  timeZone = 'UTC',
): Promise<AvailabilityDto> {
  const current = await getAvailability(page, state);
  const rules = Array.from({ length: 7 }, (_, index) => index + 1).map((weekday) => ({
    weekday,
    startLocal: '00:00',
    endLocal: '24:00',
    kind: 'work' as const,
  }));
  const response = await apiFetch(page, state, '/availability', {
    method: 'PUT',
    headers: {
      'If-Match': `W/"availability:${current.version}"`,
      'Idempotency-Key': idempotencyKey(),
    },
    body: {
      timeZone,
      rules,
      exceptions: [],
      prefs: {
        maxDailyFocusMin,
        breakAfterMin: 600,
        breakMin: 15,
        dayStartLocal: '00:00',
        dayEndLocal: '24:00',
        riskLevel: 'p50',
      },
    },
  });
  return (await expectOk(response, 'PUT /availability')) as AvailabilityDto;
}

export function editableBlocksForToday(
  plan: PlanDto,
  now: number = Date.now(),
): readonly { taskId: string; startAt: string; endAt: string }[] {
  const candidate = plan.candidates.find((entry) => entry.feasible) ?? plan.candidates[0];
  if (candidate === undefined) throw new Error('plan has no candidate to approve');
  const sorted = [...candidate.blocks].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  const grid = 5 * 60_000;
  let cursor = Math.ceil((now + 5 * 60_000) / grid) * grid;
  return sorted.map((block) => {
    const duration = Date.parse(block.endAt) - Date.parse(block.startAt);
    const startAt = cursor;
    cursor += duration + grid;
    return {
      taskId: block.taskId,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(startAt + duration).toISOString(),
    };
  });
}

const SLOT_GRID_MS = 5 * 60_000;
/**
 * Lead before the notification carrier block. It is rounded UP to the
 * scheduler's 5-minute grid, which keeps it within the 10-minute notification
 * window while starting after the API's now.
 */
const NOTIFICATION_LEAD_MS = 3 * 60_000;

/**
 * FU-79: approval blocks for a spec whose UI runs at `dayNowMs` while the API
 * runs at `apiNowMs`. The first block (the notification/dedupe carrier) starts
 * a few minutes after the API's now, so the leader sweep always sees it; the
 * remaining blocks sit on the simulated day the browser clock shows, so Today
 * always has three cards even when the suite runs at 21:50, 23:59 or 00:01.
 */
export function editableBlocksForSimulatedToday(
  plan: PlanDto,
  apiNowMs: number,
  dayNowMs: number,
): readonly { taskId: string; startAt: string; endAt: string }[] {
  const candidate = plan.candidates.find((entry) => entry.feasible) ?? plan.candidates[0];
  if (candidate === undefined) throw new Error('plan has no candidate to approve');
  const sorted = [...candidate.blocks].sort(
    (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
  );
  const [carrier, ...rest] = sorted;
  if (carrier === undefined) throw new Error('plan has no blocks to approve');

  const carrierStart =
    Math.ceil((apiNowMs + NOTIFICATION_LEAD_MS) / SLOT_GRID_MS) * SLOT_GRID_MS;
  const carrierDuration = Date.parse(carrier.endAt) - Date.parse(carrier.startAt);
  const blocks = [
    {
      taskId: carrier.taskId,
      startAt: new Date(carrierStart).toISOString(),
      endAt: new Date(carrierStart + carrierDuration).toISOString(),
    },
  ];

  let cursor = Math.ceil((dayNowMs + SLOT_GRID_MS) / SLOT_GRID_MS) * SLOT_GRID_MS;
  const carrierEnd = carrierStart + carrierDuration;
  for (const block of rest) {
    if (cursor < carrierEnd + SLOT_GRID_MS && cursor >= carrierStart) {
      cursor = Math.ceil((carrierEnd + SLOT_GRID_MS) / SLOT_GRID_MS) * SLOT_GRID_MS;
    }
    const duration = Date.parse(block.endAt) - Date.parse(block.startAt);
    blocks.push({
      taskId: block.taskId,
      startAt: new Date(cursor).toISOString(),
      endAt: new Date(cursor + duration).toISOString(),
    });
    cursor += duration + SLOT_GRID_MS;
  }
  return blocks;
}

export async function approveCandidateWithBlocks(
  page: Page,
  state: E2EState,
  plan: PlanDto,
  editedBlocks: readonly { taskId: string; startAt: string; endAt: string }[],
): Promise<PlanVersionDto> {
  const candidate = plan.candidates.find((entry) => entry.feasible) ?? plan.candidates[0];
  if (candidate === undefined) throw new Error('plan has no candidate to approve');
  const response = await apiFetch(
    page,
    state,
    `/plans/${plan.id}/candidates/${candidate.id}:approve`,
    {
      method: 'POST',
      headers: {
        'If-Match': `W/"availability:${plan.availabilityVersion}"`,
        'Idempotency-Key': idempotencyKey(),
      },
      body: { editedBlocks },
    },
  );
  return (await expectOk(
    response,
    'POST /plans/{id}/candidates/{cid}:approve',
  )) as PlanVersionDto;
}

export async function getWorkSession(
  page: Page,
  state: E2EState,
  sessionId: string,
): Promise<WorkSessionDto> {
  const response = await apiFetch(page, state, `/sessions/${sessionId}`);
  return (await expectOk(response, 'GET /sessions/{id}')) as WorkSessionDto;
}

export async function listNotifications(
  page: Page,
  state: E2EState,
): Promise<readonly NotificationDto[]> {
  const response = await apiFetch(page, state, '/notifications?limit=100');
  const body = (await expectOk(response, 'GET /notifications')) as {
    items: NotificationDto[];
  };
  return body.items;
}

export async function getTaskConstraints(
  page: Page,
  state: E2EState,
  taskId: string,
): Promise<TaskConstraintsDto> {
  const response = await apiFetch(page, state, `/tasks/${taskId}`);
  const task = (await expectOk(response, 'GET /tasks/{id}')) as {
    readonly id: string;
    readonly dueAt?: string | null;
    readonly dependsOn?: readonly string[];
  };
  return {
    id: task.id,
    ...(typeof task.dueAt === 'string' ? { dueAt: task.dueAt } : {}),
    dependsOn: task.dependsOn ?? [],
  };
}

/** A folder (a project) as the planner API lists it (HOLO-06). */
export interface ProjectDto {
  readonly id: string;
  readonly title: string;
  readonly kind: 'inbox' | 'normal';
  readonly archived: boolean;
  readonly version: number;
}

/** A to-do as the planner API answers it: where it is, and whether it is finished or deleted. */
export interface TaskDto {
  readonly id: string;
  readonly title: string;
  readonly status: 'todo' | 'in_progress' | 'done';
  readonly projectId: string;
  readonly version: number;
  readonly deletedAt?: string;
  readonly external?: readonly { readonly provider: string; readonly externalId: string }[];
}

/** Every project the API lists for the signed-in owner (the live API leaves archived ones out). */
export async function listProjects(page: Page, state: E2EState): Promise<ProjectDto[]> {
  return listPaged<ProjectDto>(page, state, '/projects', { limit: '100' }, 'GET /projects');
}

/** The owner's to-dos — all of them, or those of one project. */
export async function listTasks(
  page: Page,
  state: E2EState,
  projectId?: string,
): Promise<TaskDto[]> {
  return listPaged<TaskDto>(
    page,
    state,
    '/tasks',
    { limit: '100', ...(projectId === undefined ? {} : { projectId }) },
    'GET /tasks',
  );
}

export async function getTask(page: Page, state: E2EState, taskId: string): Promise<TaskDto> {
  const response = await apiFetch(page, state, `/tasks/${taskId}`);
  return (await expectOk(response, 'GET /tasks/{id}')) as TaskDto;
}

async function listPaged<T>(
  page: Page,
  state: E2EState,
  path: string,
  query: Record<string, string>,
  describe: string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let round = 0; round < 50; round += 1) {
    const params = new URLSearchParams(query);
    if (cursor !== null) params.set('cursor', cursor);
    const response = await apiFetch(page, state, `${path}?${params.toString()}`);
    const body = (await expectOk(response, describe)) as {
      items: T[];
      nextCursor: string | null;
    };
    items.push(...body.items);
    cursor = body.nextCursor;
    if (cursor === null) return items;
  }
  throw new Error(`${describe} did not finish paging`);
}

/** Commitment occurrences overlapping [from, to), expanded by the API. */
export async function listCommitmentIntervals(
  page: Page,
  state: E2EState,
  from: string,
  to: string,
): Promise<IntervalDto[]> {
  const commitments = await listPaged<{
    startAt: string;
    endAt: string;
    occurrences?: readonly IntervalDto[];
  }>(page, state, '/commitments', { from, to, limit: '100' }, 'GET /commitments');
  return commitments.flatMap((commitment) =>
    commitment.occurrences !== undefined && commitment.occurrences.length > 0
      ? commitment.occurrences.map((occurrence) => ({
          startAt: occurrence.startAt,
          endAt: occurrence.endAt,
        }))
      : [{ startAt: commitment.startAt, endAt: commitment.endAt }],
  );
}

/** Approved schedule blocks overlapping [from, to) (superseded ones excluded). */
export async function listScheduleBlockIntervals(
  page: Page,
  state: E2EState,
  from: string,
  to: string,
): Promise<IntervalDto[]> {
  const blocks = await listPaged<{ startAt: string; endAt: string; status: string }>(
    page,
    state,
    '/schedule-blocks',
    { from, to, limit: '500' },
    'GET /schedule-blocks',
  );
  return blocks
    .filter((block) => block.status !== 'superseded')
    .map((block) => ({ startAt: block.startAt, endAt: block.endAt }));
}
