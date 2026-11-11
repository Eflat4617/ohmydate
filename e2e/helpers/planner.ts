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
  } = {},
): Promise<IntakeSessionDto> {
  const dueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
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

export async function createPlanFromGoal(
  page: Page,
  state: E2EState,
  goalId: string,
): Promise<PlanDto> {
  const start = new Date();
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
