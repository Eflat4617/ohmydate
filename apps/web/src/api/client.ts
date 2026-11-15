import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, apiErrorFromPayload } from './errors';
import {
  COMMITMENT_PARSE_CLIENT_BOUND_MS,
  TASK_PARSE_CLIENT_BOUND_MS,
  aiRequestSignal,
  type AiRequestOptions,
} from './ai-request';
import type { components, paths } from './schema';

export type Task = components['schemas']['Task'];
export type TaskCreate = components['schemas']['TaskCreate'];
export type TaskPatch = components['schemas']['TaskPatch'];
export type TaskStatus = Task['status'];
export type Project = components['schemas']['Project'];
/** FOLD-01: rename and/or archive a project (a folder of the 할 일 canvas). */
export type ProjectPatch = components['schemas']['ProjectPatch'];
/** FU-98: a planning goal (one wizard session) with the tasks its approval created. */
export type GoalSummary = components['schemas']['GoalSummary'];
export type User = components['schemas']['User'];
export type Today = components['schemas']['Today'];
export type TodayBlock = components['schemas']['TodayBlock'];
export type TodayProposal = components['schemas']['TodayProposal'];
export type TodayAcceptRequest = components['schemas']['TodayAcceptRequest'];
export type TodayShrinkRequest = components['schemas']['TodayShrinkRequest'];
export type TodayRescheduleRequest = components['schemas']['TodayRescheduleRequest'];
export type WorkSession = components['schemas']['WorkSession'];
export type SessionCreate = components['schemas']['SessionCreate'];
export type SessionReviewRequest = components['schemas']['SessionReviewRequest'];
export type EstimationFeedback = components['schemas']['EstimationFeedback'];
export type Notification = components['schemas']['Notification'];
export type NotificationQuery = components['schemas']['NotificationQuery'];
export type PushSubscription = components['schemas']['PushSubscription'];
export type PushSubscriptionCreate = components['schemas']['PushSubscriptionCreate'];
export type Export = components['schemas']['Export'];
export type ExportStartResponse = components['schemas']['ExportStartResponse'];
export type PlanVersion = components['schemas']['PlanVersion'];
export type UserSettingsPatch = components['schemas']['UserSettingsPatch'];
export type Page<T> = { items: T[]; nextCursor: string | null };
export type IntakeInput = components['schemas']['IntakeInput'];
export type IntakeSession = components['schemas']['IntakeSession'];
export type IntakeSessionCreate = components['schemas']['IntakeSessionCreate'];
export type IntakeState = IntakeSession['state'];
export type IntakeDetectedType = components['schemas']['IntakeDetectedType'];
export type PlannedQuestion = components['schemas']['PlannedQuestion'];
export type IntakeAssumption = components['schemas']['IntakeAssumption'];
export type IntakeAnswer = components['schemas']['IntakeAnswer'];
export type IntakeAnswerInput = components['schemas']['IntakeAnswersRequest']['answers'][number];
export type IntakeTypeConfirmation = components['schemas']['IntakeTypeConfirmation'];
export type DecompositionEstimate = components['schemas']['DecompositionEstimate'];
export type DecompositionStep = components['schemas']['DecompositionStep'];
export type DecompositionDraft = components['schemas']['DecompositionDraft'];
export type DecompositionDraftPatch = components['schemas']['DecompositionDraftPatch'];
export type TaskTemplate = components['schemas']['TaskTemplate'];
export type IntakeField = PlannedQuestion['field'];
export type Availability = components['schemas']['Availability'];
export type AvailabilityPut = components['schemas']['AvailabilityPut'];
export type AvailabilityRule = components['schemas']['AvailabilityRule'];
export type AvailabilityException = components['schemas']['AvailabilityException'];
export type AvailabilityPreferences = components['schemas']['AvailabilityPreferences'];
export type Commitment = components['schemas']['Commitment'];
export type CommitmentCreate = components['schemas']['CommitmentCreate'];
export type CommitmentPatch = components['schemas']['CommitmentPatch'];
export type CommitmentOccurrence = components['schemas']['CommitmentOccurrence'];
/** CAL-02: natural-language commitment entry. */
export type CommitmentDraft = components['schemas']['CommitmentDraft'];
export type CommitmentDraftNote = CommitmentDraft['notes'][number];
export type CommitmentParseResponse = components['schemas']['CommitmentParseResponse'];
/** CAL-05: natural-language task entry in the inbox. */
export type TaskDraft = components['schemas']['TaskDraft'];
export type TaskDraftNote = TaskDraft['notes'][number];
export type TaskParseResponse = components['schemas']['TaskParseResponse'];
export type Plan = components['schemas']['Plan'];
export type PlanCandidate = components['schemas']['PlanCandidate'];
export type PlanCreate = components['schemas']['PlanCreate'];
export type PlanBlock = components['schemas']['PlanBlock'];
export type PlanMetrics = components['schemas']['PlanMetrics'];
export type PreviewEditResponse = components['schemas']['PreviewEditResponse'];
export type ScheduleBlock = components['schemas']['ScheduleBlock'];
export type Violation = PreviewEditResponse['violations'][number];
export type ReplanProposal = components['schemas']['ReplanProposal'];
export type ReplanProposalPage = components['schemas']['ReplanProposalPage'];
export type ReplanProposalState = ReplanProposal['state'];
export type ReplanTrigger = components['schemas']['ReplanTrigger'];
export type ReplanTriggerKind = ReplanTrigger['kind'];
export type ReplanReasonCode = ReplanTrigger['reason'];
export type ReplanCandidate = components['schemas']['ReplanCandidate'];
export type ReplanBefore = components['schemas']['ReplanBefore'];
export type ReplanBeforeBlock = ReplanBefore['blocks'][number];
export type ReplanCandidateFlag = ReplanCandidate['flags'][number];
export type ReplanRequest = components['schemas']['ReplanRequest'];
export type EstimationProfile = components['schemas']['EstimationProfile'];
export type EstimationProfileGroup = components['schemas']['EstimationProfileGroup'];
export type EstimationProfileItem = components['schemas']['EstimationProfileItem'];
export type EstimationReset = components['schemas']['EstimationReset'];
export type ContextDocument = components['schemas']['ContextDocument'];
export type ContextDocumentCreate = components['schemas']['ContextDocumentCreate'];
export type ContextDocumentPatch = components['schemas']['ContextDocumentPatch'];
export type ContextDocumentPage = components['schemas']['ContextDocumentPage'];
export type DocumentLink = components['schemas']['DocumentLink'];
export type DocumentLinkCreate = components['schemas']['DocumentLinkCreate'];
export type DocumentTargetKind = DocumentLink['targetKind'];
export type NoteSensitivity = ContextDocument['sensitivity'];
export type NoteAiUsage = components['schemas']['NoteAiUsage'];
export type NoteAiUsagePage = components['schemas']['NoteAiUsagePage'];
export type NoteAiUsageStatus = NoteAiUsage['status'];
export type DecompositionEvidence = components['schemas']['DecompositionEvidence'];
/** CAL-04: Google Calendar integration (CAL-03 contract, 08 §2.11). */
export type GoogleIntegration = components['schemas']['GoogleIntegration'];
export type GoogleIntegrationStatus = GoogleIntegration['status'];
export type GoogleIntegrationSettings = components['schemas']['GoogleIntegrationSettings'];
export type GoogleIntegrationSettingsPut = components['schemas']['GoogleIntegrationSettingsPut'];
export type GoogleCalendarEntry = components['schemas']['GoogleCalendarEntry'];
export type GoogleConnectResponse = components['schemas']['GoogleConnectResponse'];
export type GoogleSyncResult = components['schemas']['GoogleSyncResult'];
export type GoogleSyncErrorCode = NonNullable<GoogleIntegration['lastError']>;
export type CalendarDayEvent = components['schemas']['CalendarDayEvent'];
export type CommitmentSource = Commitment['source'];

export interface DocumentListOptions {
  readonly q?: string;
  readonly targetKind?: DocumentTargetKind;
  readonly targetId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly signal?: AbortSignal;
}

export interface PlannerClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly csrfCookieName?: string;
}

export function etagForVersion(version: number): string {
  return `W/"${version}"`;
}

export function versionFromEtag(etag: string | null): number | undefined {
  if (etag === null) return undefined;
  const match = /^W\/"(\d+)"$/.exec(etag);
  return match === null ? undefined : Number(match[1]);
}

/** Availability is versioned user-wide, so its tag carries a prefix (08 §2.4a). */
export function availabilityEtagForVersion(version: number): string {
  return `W/"availability:${version}"`;
}

export function availabilityVersionFromEtag(etag: string | null): number | undefined {
  if (etag === null) return undefined;
  const match = /^W\/"availability:(\d+)"$/.exec(etag);
  return match === null ? undefined : Number(match[1]);
}

/**
 * Owner abort (ADR-023 §1: an owner change stops every request of the previous
 * owner). The session layer registers where to get the signal of whoever is
 * signed in; the API layer itself knows nothing about owners.
 */
let requestOwnerSignal: (() => AbortSignal) | null = null;

export function bindRequestOwnerSignal(source: (() => AbortSignal) | null): void {
  requestOwnerSignal = source;
}

/**
 * One signal that aborts when any of `signals` does, with the first reason.
 * Shared by the owner-abort middleware and callers that add their own bound
 * (the identity revalidation timeout, FU-56/FU-85).
 */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([...signals]);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

/**
 * Runs synchronously inside the client method call (openapi-fetch calls the
 * first `onRequest` before its first await), so the signal is the one of the
 * owner who started the request. If the owner changes before the request is
 * actually sent — the send happens a few microtasks later — it is never sent;
 * if it is in flight, it is aborted. A method needs no `signal` parameter for
 * this.
 */
const ownerAbortMiddleware: Middleware = {
  onRequest({ request }) {
    if (requestOwnerSignal === null) return request;
    return new Request(request, { signal: anySignal([request.signal, requestOwnerSignal()]) });
  },
};

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return decodeURIComponent(trimmed.slice(prefix.length));
    }
  }
  return undefined;
}

function absoluteBaseUrl(baseUrl: string): string {
  if (/^https?:\/\//.test(baseUrl)) return baseUrl;
  if (typeof location !== 'undefined' && typeof location.href === 'string' && location.href.length > 0) {
    try {
      return new URL(baseUrl, location.href).toString();
    } catch {
      return baseUrl;
    }
  }
  return baseUrl;
}

function pageQuery(options: { cursor?: string; limit?: number }): {
  cursor?: string;
  limit?: number;
} {
  const query: { cursor?: string; limit?: number } = {};
  if (options.cursor !== undefined) query.cursor = options.cursor;
  if (options.limit !== undefined) query.limit = options.limit;
  return query;
}

export class PlannerClient {
  private readonly client: ReturnType<typeof createClient<paths>>;
  private readonly versions = new Map<string, number>();

  constructor(options: PlannerClientOptions = {}) {
    const csrfCookieName = options.csrfCookieName ?? 'csrf';
    const csrfMiddleware: Middleware = {
      onRequest({ request }) {
        const method = request.method.toUpperCase();
        if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
          const token = readCookie(csrfCookieName);
          if (token !== undefined && !request.headers.has('X-CSRF-Token')) {
            request.headers.set('X-CSRF-Token', token);
          }
        }
        return request;
      },
    };

    const fetchImpl: typeof globalThis.fetch =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.client = createClient<paths>({
      baseUrl: absoluteBaseUrl(options.baseUrl ?? '/api/v1'),
      credentials: 'include',
      fetch: fetchImpl,
    });
    // First, so that it runs in the caller's turn (see ownerAbortMiddleware).
    this.client.use(ownerAbortMiddleware);
    this.client.use(csrfMiddleware);
  }

  cachedTaskVersion(taskId: string): number | undefined {
    return this.versions.get(`task:${taskId}`);
  }

  cachedProjectVersion(projectId: string): number | undefined {
    return this.versions.get(`project:${projectId}`);
  }

  async login(email: string, password: string): Promise<void> {
    const { error, response } = await this.client.POST('/auth/login', {
      body: { email, password },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
  }

  async logout(): Promise<void> {
    const { error, response } = await this.client.POST('/auth/logout');
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
  }

  async getMe(signal?: AbortSignal): Promise<User> {
    const { data, error, response } = await this.client.GET('/me', {
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty user response');
    this.remember('user', data.version, response.headers.get('ETag'));
    return data;
  }

  async updateMySettings(
    patch: UserSettingsPatch,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<User> {
    const { data, error, response } = await this.client.PATCH('/me/settings', {
      params: {
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty user response');
    this.remember('user', data.version, response.headers.get('ETag'));
    return data;
  }

  async listProjects(options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<Page<Project>> {
    const { data, error, response } = await this.client.GET('/projects', {
      params: { query: pageQuery(options) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty project page');
    for (const project of data.items) {
      this.remember(`project:${project.id}`, project.version);
    }
    return data;
  }

  /** FU-98: the owner's planning goals, newest first, with their approved task ids. */
  async listGoals(options: { cursor?: string; limit?: number; signal?: AbortSignal } = {}): Promise<Page<GoalSummary>> {
    const { data, error, response } = await this.client.GET('/goals', {
      params: { query: pageQuery(options) },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty goal page');
    return data;
  }

  async createProject(title: string, idempotencyKey: string): Promise<Project> {
    const { data, error, response } = await this.client.POST('/projects', {
      body: { title },
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty project response');
    this.remember(`project:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  /**
   * FOLD-01 (`PATCH /projects/{id}`): rename and/or archive a folder. The
   * answer carries the project's new version, which the next change needs —
   * an archived project is no longer listed, so this is the only place the
   * web learns the version a later `archived: false` must send.
   */
  async updateProject(
    projectId: string,
    patch: ProjectPatch,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<Project> {
    const { data, error, response } = await this.client.PATCH('/projects/{id}', {
      params: {
        path: { id: projectId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty project response');
    this.remember(`project:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async listTasks(
    options: { projectId?: string; status?: TaskStatus; cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Page<Task>> {
    const query: {
      projectId?: string;
      status?: TaskStatus;
      cursor?: string;
      limit?: number;
    } = {};
    if (options.projectId !== undefined) query.projectId = options.projectId;
    if (options.status !== undefined) query.status = options.status;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;

    const { data, error, response } = await this.client.GET('/tasks', {
      params: { query },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task page');
    for (const task of data.items) this.remember(`task:${task.id}`, task.version);
    return data;
  }

  async getTask(taskId: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<Task> {
    const { data, error, response } = await this.client.GET('/tasks/{id}', {
      params: { path: { id: taskId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task response');
    this.remember(`task:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async createTask(input: TaskCreate, idempotencyKey: string): Promise<Task> {
    const { data, error, response } = await this.client.POST('/tasks', {
      body: input,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task response');
    this.remember(`task:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async updateTask(
    taskId: string,
    patch: TaskPatch,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<Task> {
    const version = expectedVersion ?? (await this.resolveTaskVersion(taskId));
    const { data, error, response } = await this.client.PATCH('/tasks/{id}', {
      params: {
        path: { id: taskId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
      body: patch,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task response');
    this.remember(`task:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async completeTask(
    taskId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<Task> {
    const version = expectedVersion ?? (await this.resolveTaskVersion(taskId));
    const { data, error, response } = await this.client.POST('/tasks/{id}:complete', {
      params: {
        path: { id: taskId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task response');
    this.remember(`task:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async deleteTask(taskId: string, idempotencyKey: string, expectedVersion?: number): Promise<void> {
    const version = expectedVersion ?? (await this.resolveTaskVersion(taskId));
    const { error, response } = await this.client.DELETE('/tasks/{id}', {
      params: {
        path: { id: taskId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    this.versions.delete(`task:${taskId}`);
  }

  cachedAvailabilityVersion(): number | undefined {
    return this.versions.get('availability');
  }

  cachedPlanVersion(planId: string): number | undefined {
    return this.versions.get(`plan:${planId}`);
  }

  cachedCommitmentVersion(commitmentId: string): number | undefined {
    return this.versions.get(`commitment:${commitmentId}`);
  }

  async getAvailability(options: { fresh?: boolean } = {}): Promise<Availability> {
    const { data, error, response } = await this.client.GET('/availability', {
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty availability response');
    this.remember('availability', data.version, response.headers.get('ETag'));
    return data;
  }

  async putAvailability(
    input: AvailabilityPut,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<Availability> {
    const version = expectedVersion ?? (await this.resolveAvailabilityVersion());
    const { data, error, response } = await this.client.PUT('/availability', {
      params: {
        header: {
          'If-Match': availabilityEtagForVersion(version),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: input,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty availability response');
    this.remember('availability', data.version, response.headers.get('ETag'));
    return data;
  }

  async listCommitments(
    options: { from: string; to: string; cursor?: string; limit?: number; signal?: AbortSignal },
  ): Promise<Page<Commitment>> {
    const query: { from: string; to: string; cursor?: string; limit?: number } = {
      from: options.from,
      to: options.to,
    };
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/commitments', {
      params: { query },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty commitment page');
    for (const commitment of data.items) {
      this.remember(`commitment:${commitment.id}`, commitment.version);
    }
    return data;
  }

  async createCommitment(input: CommitmentCreate, idempotencyKey: string): Promise<Commitment> {
    const { data, error, response } = await this.client.POST('/commitments', {
      body: input,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty commitment response');
    this.remember(`commitment:${data.id}`, data.version);
    return data;
  }

  /**
   * CAL-02: read a natural-language note into commitment drafts (nothing is
   * saved). The server bound is 50 s (one attempt + one repair + slack); the
   * client gives up a little later. Aborting `signal` (the screen's 취소)
   * closes the request and the server cancels the model call.
   */
  async parseCommitments(
    text: string,
    idempotencyKey: string,
    options: { readonly timeZone?: string; readonly signal?: AbortSignal } = {},
  ): Promise<CommitmentParseResponse> {
    const ai = aiRequestSignal({
      boundMs: COMMITMENT_PARSE_CLIENT_BOUND_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const { data, error, response } = await this.client
      .POST('/commitments:parse', {
        body: { text, ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }) },
        params: { header: { 'Idempotency-Key': idempotencyKey } },
        signal: ai.signal,
      })
      .finally(() => ai.dispose());
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty commitment parse response');
    return data;
  }

  /**
   * CAL-05: read a natural-language to-do note into task drafts (nothing is
   * saved). Same bounds and cancel as parseCommitments: the server bound is
   * 50 s, the client gives up a little later, and aborting `signal` closes the
   * request so the server cancels the model call.
   */
  async parseTasks(
    text: string,
    idempotencyKey: string,
    options: { readonly timeZone?: string; readonly signal?: AbortSignal } = {},
  ): Promise<TaskParseResponse> {
    const ai = aiRequestSignal({
      boundMs: TASK_PARSE_CLIENT_BOUND_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const { data, error, response } = await this.client
      .POST('/tasks:parse', {
        body: { text, ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }) },
        params: { header: { 'Idempotency-Key': idempotencyKey } },
        signal: ai.signal,
      })
      .finally(() => ai.dispose());
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task parse response');
    return data;
  }

  async updateCommitment(
    commitmentId: string,
    patch: CommitmentPatch,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<Commitment> {
    const version = expectedVersion ?? (await this.resolveCommitmentVersion(commitmentId));
    const { data, error, response } = await this.client.PATCH('/commitments/{id}', {
      params: {
        path: { id: commitmentId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
      body: patch,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty commitment response');
    this.remember(`commitment:${data.id}`, data.version);
    return data;
  }

  async deleteCommitment(
    commitmentId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<void> {
    const version = expectedVersion ?? (await this.resolveCommitmentVersion(commitmentId));
    const { error, response } = await this.client.DELETE('/commitments/{id}', {
      params: {
        path: { id: commitmentId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    this.versions.delete(`commitment:${commitmentId}`);
  }

  // ── Google Calendar integration (CAL-03 server, CAL-04 screen) ────────

  cachedGoogleIntegrationVersion(): number | undefined {
    return this.versions.get('google-integration');
  }

  /** Always 200, also when the server is not configured (`status: not_configured`). */
  async getGoogleIntegration(options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<GoogleIntegration> {
    const { data, error, response } = await this.client.GET('/integrations/google', {
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty Google integration response');
    this.remember('google-integration', data.version, response.headers.get('ETag'));
    return data;
  }

  /** The accounts.google.com consent URL; the caller navigates to it at the top level. */
  async connectGoogleIntegration(idempotencyKey: string): Promise<GoogleConnectResponse> {
    const { data, error, response } = await this.client.POST('/integrations/google:connect', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty Google connect response');
    return data;
  }

  /** Full replacement of the import selection and the export settings (If-Match: the connection version). */
  async putGoogleIntegrationSettings(
    input: GoogleIntegrationSettingsPut,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<GoogleIntegration> {
    const { data, error, response } = await this.client.PUT('/integrations/google/settings', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty Google integration response');
    this.remember('google-integration', data.version, response.headers.get('ETag'));
    return data;
  }

  /** One import + export now; the counts of what changed. */
  async syncGoogleIntegration(idempotencyKey: string): Promise<GoogleSyncResult> {
    const { data, error, response } = await this.client.POST('/integrations/google:sync', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty Google sync response');
    return data;
  }

  /** Revoke, forget the token, remove imported data; `removeExported` also deletes the "OhMyDate" calendar at Google. */
  async disconnectGoogleIntegration(
    removeExported: boolean,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<void> {
    const { error, response } = await this.client.DELETE('/integrations/google', {
      params: {
        query: { removeExported: removeExported ? 'true' : 'false' },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    this.versions.delete('google-integration');
  }

  /** Imported all-day events overlapping `from..to` (inclusive civil dates, at most 92 days). */
  async listCalendarDayEvents(options: { from: string; to: string; signal?: AbortSignal }): Promise<CalendarDayEvent[]> {
    const { data, error, response } = await this.client.GET('/calendar-day-events', {
      params: { query: { from: options.from, to: options.to } },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty day event page');
    return data.items;
  }

  async createPlan(input: PlanCreate, idempotencyKey: string): Promise<Plan> {
    const { data, error, response } = await this.client.POST('/plans', {
      body: input,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan response');
    this.remember(`plan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async getPlan(planId: string, options: { fresh?: boolean } = {}): Promise<Plan> {
    const { data, error, response } = await this.client.GET('/plans/{id}', {
      params: { path: { id: planId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan response');
    this.remember(`plan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async previewCandidateEdit(
    planId: string,
    candidateId: string,
    blocks: PlanBlock[],
    idempotencyKey: string,
    expectedPlanVersion?: number,
  ): Promise<PreviewEditResponse> {
    const version = expectedPlanVersion ?? (await this.resolvePlanVersion(planId));
    const { data, error, response } = await this.client.POST(
      '/plans/{id}/candidates/{cid}:preview-edit',
      {
        params: {
          path: { id: planId, cid: candidateId },
          header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
        },
        body: { blocks },
      },
    );
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty preview response');
    return data;
  }

  async approveCandidate(
    planId: string,
    candidateId: string,
    idempotencyKey: string,
    availabilityVersion: number,
    editedBlocks?: PlanBlock[],
  ): Promise<PlanVersion> {
    const { data, error, response } = await this.client.POST(
      '/plans/{id}/candidates/{cid}:approve',
      {
        params: {
          path: { id: planId, cid: candidateId },
          header: {
            'If-Match': availabilityEtagForVersion(availabilityVersion),
            'Idempotency-Key': idempotencyKey,
          },
        },
        body: editedBlocks === undefined ? {} : { editedBlocks },
      },
    );
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan version response');
    return data;
  }

  async regeneratePlan(
    planId: string,
    idempotencyKey: string,
    expectedPlanVersion?: number,
  ): Promise<Plan> {
    const version = expectedPlanVersion ?? (await this.resolvePlanVersion(planId));
    const { data, error, response } = await this.client.POST('/plans/{id}:regenerate', {
      params: {
        path: { id: planId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan response');
    this.remember(`plan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  private async resolveAvailabilityVersion(): Promise<number> {
    const cached = this.versions.get('availability');
    if (cached !== undefined) return cached;
    return (await this.getAvailability({ fresh: true })).version;
  }

  private async resolveCommitmentVersion(commitmentId: string): Promise<number> {
    const cached = this.versions.get(`commitment:${commitmentId}`);
    if (cached !== undefined) return cached;
    throw new ApiError(412, 'version_conflict', 'Commitment version is unknown; reload the list first');
  }

  private async resolvePlanVersion(planId: string): Promise<number> {
    const cached = this.versions.get(`plan:${planId}`);
    if (cached !== undefined) return cached;
    return (await this.getPlan(planId, { fresh: true })).version;
  }

  /**
   * FU-76: waits for AI type detection. Replaying the same key is how a
   * reloaded client resumes (the server answers 409 idempotency_in_progress
   * until the stored result exists); see ai-request.ts for the bound.
   */
  async createIntakeSession(
    input: IntakeInput,
    idempotencyKey: string,
    options: AiRequestOptions = {},
  ): Promise<IntakeSession> {
    const ai = aiRequestSignal(options);
    const { data, error, response } = await this.client
      .POST('/intake-sessions', {
        body: { input },
        params: { header: { 'Idempotency-Key': idempotencyKey } },
        signal: ai.signal,
      })
      .finally(() => ai.dispose());
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(
        response.status,
        'unknown',
        'Intake session is still being prepared. Reload to continue.',
      );
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  async getIntakeSession(
    sessionId: string,
    options: { fresh?: boolean } = {},
  ): Promise<IntakeSession> {
    const { data, error, response } = await this.client.GET('/intake-sessions/{id}', {
      params: { path: { id: sessionId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty intake session response');
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  async answerIntakeQuestions(
    sessionId: string,
    answers: readonly IntakeAnswerInput[],
    idempotencyKey: string,
    expectedVersion?: number,
    options: AiRequestOptions = {},
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const ai = aiRequestSignal(options);
    const { data, error, response } = await this.client
      .POST('/intake-sessions/{id}/answers', {
        params: {
          path: { id: sessionId },
          header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
        },
        body: { answers: [...answers] },
        signal: ai.signal,
      })
      .finally(() => ai.dispose());
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty intake session response');
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  async confirmIntakeType(
    sessionId: string,
    confirmation: IntakeTypeConfirmation,
    idempotencyKey: string,
    expectedVersion?: number,
    options: AiRequestOptions = {},
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const ai = aiRequestSignal(options);
    const { data, error, response } = await this.client
      .POST('/intake-sessions/{id}/type-confirmation', {
        params: {
          path: { id: sessionId },
          header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
        },
        body: confirmation,
        signal: ai.signal,
      })
      .finally(() => ai.dispose());
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty intake session response');
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  async getIntakeDraft(sessionId: string): Promise<DecompositionDraft> {
    const { data, error, response } = await this.client.GET('/intake-sessions/{id}/draft', {
      params: { path: { id: sessionId } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty draft response');
    }
    this.rememberIntakeFromEtag(sessionId, response.headers.get('ETag'));
    return data;
  }

  async updateIntakeDraft(
    sessionId: string,
    patch: DecompositionDraftPatch,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<DecompositionDraft> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const { data, error, response } = await this.client.PATCH('/intake-sessions/{id}/draft', {
      params: {
        path: { id: sessionId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
      body: patch,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty draft response');
    }
    const etagVersion = versionFromEtag(response.headers.get('ETag'));
    this.remember(`intake:${sessionId}`, etagVersion ?? version + 1);
    return data;
  }

  async approveIntakeDraft(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const { data, error, response } = await this.client.POST(
      '/intake-sessions/{id}/draft:approve',
      {
        params: {
          path: { id: sessionId },
          header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
        },
      },
    );
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty intake session response');
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  async pauseIntakeSession(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<IntakeSession> {
    return this.intakeAction(sessionId, 'pause', idempotencyKey, expectedVersion);
  }

  /** FU-76: also "다시 시도" for an interrupted decomposition (waits for the AI). */
  async resumeIntakeSession(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
    options: AiRequestOptions = {},
  ): Promise<IntakeSession> {
    return this.intakeAction(sessionId, 'resume', idempotencyKey, expectedVersion, options);
  }

  async cancelIntakeSession(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<IntakeSession> {
    return this.intakeAction(sessionId, 'cancel', idempotencyKey, expectedVersion);
  }

  async enterManualIntakeMode(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<IntakeSession> {
    return this.intakeAction(sessionId, 'manual', idempotencyKey, expectedVersion);
  }

  async listTaskTemplates(
    options: { query?: string; cursor?: string; limit?: number } = {},
  ): Promise<Page<TaskTemplate>> {
    const query: { query?: string; cursor?: string; limit?: number } = {};
    if (options.query !== undefined) query.query = options.query;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/templates', {
      params: { query },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty template page');
    }
    return data;
  }

  async getTaskTemplate(templateId: string): Promise<TaskTemplate> {
    const { data, error, response } = await this.client.GET('/templates/{id}', {
      params: { path: { id: templateId } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty template response');
    }
    return data;
  }

  private async intakeAction(
    sessionId: string,
    action: 'pause' | 'resume' | 'cancel' | 'manual',
    idempotencyKey: string,
    expectedVersion?: number,
    options?: AiRequestOptions,
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const params = {
      path: { id: sessionId },
      header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
    };
    const ai = options === undefined ? undefined : aiRequestSignal(options);
    const init = ai === undefined ? { params } : { params, signal: ai.signal };
    const result = await (
      action === 'pause'
        ? this.client.POST('/intake-sessions/{id}:pause', init)
        : action === 'resume'
          ? this.client.POST('/intake-sessions/{id}:resume', init)
          : action === 'cancel'
            ? this.client.POST('/intake-sessions/{id}:cancel', init)
            : this.client.POST('/intake-sessions/{id}:manual', init)
    ).finally(() => ai?.dispose());
    const { data, error, response } = result;
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty intake session response');
    }
    this.remember(`intake:${data.id}`, data.version, response.headers.get('ETag'));
    return data as IntakeSession;
  }

  private rememberIntakeFromEtag(sessionId: string, etag: string | null): void {
    const version = versionFromEtag(etag);
    if (version !== undefined) this.remember(`intake:${sessionId}`, version);
  }

  private async resolveIntakeVersion(sessionId: string): Promise<number> {
    const cached = this.versions.get(`intake:${sessionId}`);
    if (cached !== undefined) return cached;
    const session = await this.getIntakeSession(sessionId, { fresh: true });
    return session.version;
  }

  cachedTodayVersion(): number | undefined {
    return this.versions.get('today');
  }

  cachedSessionVersion(sessionId: string): number | undefined {
    return this.versions.get(`session:${sessionId}`);
  }

  cachedNotificationVersion(notificationId: string): number | undefined {
    return this.versions.get(`notification:${notificationId}`);
  }

  async getToday(date: string, signal?: AbortSignal): Promise<Today> {
    const { data, error, response } = await this.client.GET('/today', {
      params: { query: { date } },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty today response');
    this.remember('today', data.version, response.headers.get('ETag'));
    return data;
  }

  async acceptToday(
    input: TodayAcceptRequest,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<Today> {
    const { data, error, response } = await this.client.POST('/today:accept', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty today response');
    this.remember('today', data.version, response.headers.get('ETag'));
    return data;
  }

  async shrinkToday(
    input: TodayShrinkRequest,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<TodayProposal> {
    const { data, error, response } = await this.client.POST('/today:shrink', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty proposal response');
    }
    return data;
  }

  async rescheduleToday(
    input: TodayRescheduleRequest,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<TodayProposal> {
    const { data, error, response } = await this.client.POST('/today:reschedule', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty proposal response');
    }
    return data;
  }

  async approveTodayProposal(
    proposalId: string,
    idempotencyKey: string,
    ifMatch: string,
    signal?: AbortSignal,
  ): Promise<PlanVersion> {
    const { data, error, response } = await this.client.POST('/today/proposals/{id}:approve', {
      params: {
        path: { id: proposalId },
        header: { 'If-Match': ifMatch, 'Idempotency-Key': idempotencyKey },
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty plan version response');
    }
    return data;
  }

  async getSession(
    sessionId: string,
    options: { fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<WorkSession> {
    const { data, error, response } = await this.client.GET('/sessions/{id}', {
      params: { path: { id: sessionId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session response');
    this.remember(`session:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async listSessions(
    options: {
      state?: WorkSession['state'];
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Page<WorkSession>> {
    const query: { state?: WorkSession['state']; cursor?: string; limit?: number } = {};
    if (options.state !== undefined) query.state = options.state;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/sessions', {
      params: { query },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session page');
    for (const session of data.items) {
      this.remember(`session:${session.id}`, session.version);
    }
    return data;
  }

  async listScheduleBlocks(options: {
    from: string;
    to: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<Page<ScheduleBlock>> {
    const query: { from: string; to: string; cursor?: string; limit?: number } = {
      from: options.from,
      to: options.to,
    };
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/schedule-blocks', {
      params: { query },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty schedule block page');
    }
    return data;
  }

  /**
   * FU-71: `POST /schedule-blocks/{id}:lock` / `:unlock`. If-Match is the
   * block version (ScheduleBlock.version); the answer is the block with its
   * new version. A change also moves the plan revision (Today.version).
   */
  async setScheduleBlockLock(
    blockId: string,
    locked: boolean,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ScheduleBlock> {
    const init = {
      params: {
        path: { id: blockId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      ...(signal === undefined ? {} : { signal }),
    };
    const { data, error, response } = locked
      ? await this.client.POST('/schedule-blocks/{id}:lock', init)
      : await this.client.POST('/schedule-blocks/{id}:unlock', init);
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty schedule block response');
    this.remember(`schedule-block:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async createSession(
    input: SessionCreate,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkSession> {
    const { data, error, response } = await this.client.POST('/sessions', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session response');
    this.remember(`session:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async pauseSession(
    sessionId: string,
    clientAt: string,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<WorkSession> {
    const { data, error, response } = await this.client.POST('/sessions/{id}:pause', {
      params: {
        path: { id: sessionId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: { clientAt },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session response');
    this.remember(`session:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async resumeSession(
    sessionId: string,
    clientAt: string,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<WorkSession> {
    const { data, error, response } = await this.client.POST('/sessions/{id}:resume', {
      params: {
        path: { id: sessionId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: { clientAt },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session response');
    this.remember(`session:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async completeSession(
    sessionId: string,
    clientAt: string,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<WorkSession> {
    const { data, error, response } = await this.client.POST('/sessions/{id}:complete', {
      params: {
        path: { id: sessionId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: { clientAt },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty session response');
    this.remember(`session:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async reviewSession(
    sessionId: string,
    review: SessionReviewRequest,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<EstimationFeedback> {
    const { data, error, response } = await this.client.POST('/sessions/{id}/review', {
      params: {
        path: { id: sessionId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: review,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty estimation response');
    }
    return data;
  }

  async listNotifications(
    options: { state?: Notification['state']; cursor?: string; limit?: number } = {},
  ): Promise<Page<Notification>> {
    const query: { state?: Notification['state']; cursor?: string; limit?: number } = {};
    if (options.state !== undefined) query.state = options.state;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/notifications', {
      params: { query },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty notification page');
    for (const item of data.items) this.remember(`notification:${item.id}`, item.version);
    return data;
  }

  async dismissNotification(
    notificationId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<Notification> {
    const { data, error, response } = await this.client.POST('/notifications/{id}:dismiss', {
      params: {
        path: { id: notificationId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty notification response');
    }
    this.remember(`notification:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async createPushSubscription(
    input: PushSubscriptionCreate,
    idempotencyKey: string,
  ): Promise<PushSubscription> {
    const { data, error, response } = await this.client.POST('/push-subscriptions', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty push subscription response');
    }
    return data;
  }

  async deletePushSubscription(
    subscriptionId: string,
    idempotencyKey: string,
    expectedVersion: number,
  ): Promise<void> {
    const { error, response } = await this.client.DELETE('/push-subscriptions/{id}', {
      params: {
        path: { id: subscriptionId },
        header: {
          'If-Match': etagForVersion(expectedVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
  }

  cachedReplanProposalVersion(proposalId: string): number | undefined {
    return this.versions.get(`replan:${proposalId}`);
  }

  async listReplanProposals(
    options: {
      state?: ReplanProposalState;
      cursor?: string;
      limit?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<ReplanProposalPage> {
    const query: { state?: ReplanProposalState; cursor?: string; limit?: number } = {};
    if (options.state !== undefined) query.state = options.state;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/replan-proposals', {
      params: { query },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty replan proposal page');
    for (const item of data.items) this.remember(`replan:${item.id}`, item.version);
    return data;
  }

  async getReplanProposal(
    proposalId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReplanProposal> {
    const { data, error, response } = await this.client.GET('/replan-proposals/{id}', {
      params: { path: { id: proposalId } },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty replan proposal response');
    this.remember(`replan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  /**
   * 08 §2.6 / §2.4: approval pins `If-Match` to the user-wide availability
   * version the proposal was computed against (`W/"availability:<n>"`).
   */
  async approveReplanProposal(
    proposalId: string,
    idempotencyKey: string,
    availabilityVersion: number,
    signal?: AbortSignal,
  ): Promise<PlanVersion> {
    const { data, error, response } = await this.client.POST('/replan-proposals/{id}:approve', {
      params: {
        path: { id: proposalId },
        header: {
          'If-Match': availabilityEtagForVersion(availabilityVersion),
          'Idempotency-Key': idempotencyKey,
        },
      },
      body: {},
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan version response');
    return data;
  }

  /** Rejection pins `If-Match` to the proposal's own version (`W/"<n>"`). */
  async rejectReplanProposal(
    proposalId: string,
    idempotencyKey: string,
    expectedVersion: number,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ReplanProposal> {
    const { data, error, response } = await this.client.POST('/replan-proposals/{id}:reject', {
      params: {
        path: { id: proposalId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: reason === undefined ? {} : { reason },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty replan proposal response');
    this.remember(`replan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  /** `409 replan_suppressed` carries `Retry-After` (seconds) on `ApiError.retryAfterSeconds`. */
  async requestReplanProposal(
    input: ReplanRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ReplanProposal> {
    const { data, error, response } = await this.client.POST('/replan-proposals:request', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty replan proposal response');
    this.remember(`replan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async getEstimationProfile(signal?: AbortSignal): Promise<EstimationProfile> {
    const { data, error, response } = await this.client.GET('/estimation/profile', {
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty estimation profile');
    for (const item of data.items) this.remember(`feedback:${item.feedbackId}`, item.version);
    return data;
  }

  async patchEstimationFeedback(
    feedbackId: string,
    excluded: boolean,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<EstimationProfileItem> {
    const { data, error, response } = await this.client.PATCH('/estimation/feedback/{id}', {
      params: {
        path: { id: feedbackId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: { excluded },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty feedback response');
    this.remember(`feedback:${data.feedbackId}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async resetEstimation(
    input: EstimationReset,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<EstimationProfile> {
    const { data, error, response } = await this.client.POST('/estimation:reset', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty estimation profile');
    return data;
  }

  // ── Notes (ContextDocument, 08 §2.7, M6-01) ──────────────────────────
  // Reads are `no-store`: note bodies are private and must never come back
  // stale from the HTTP cache after an edit in another tab.

  cachedDocumentVersion(documentId: string): number | undefined {
    return this.versions.get(`document:${documentId}`);
  }

  async listDocuments(options: DocumentListOptions = {}): Promise<ContextDocumentPage> {
    const query: {
      q?: string;
      targetKind?: DocumentTargetKind;
      targetId?: string;
      cursor?: string;
      limit?: number;
    } = {};
    if (options.q !== undefined) query.q = options.q;
    if (options.targetKind !== undefined) query.targetKind = options.targetKind;
    if (options.targetId !== undefined) query.targetId = options.targetId;
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/documents', {
      params: { query },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document page');
    for (const item of data.items) this.remember(`document:${item.id}`, item.version);
    return data;
  }

  async getDocument(documentId: string, signal?: AbortSignal): Promise<ContextDocument> {
    const { data, error, response } = await this.client.GET('/documents/{id}', {
      params: { path: { id: documentId } },
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async createDocument(
    input: ContextDocumentCreate,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ContextDocument> {
    const { data, error, response } = await this.client.POST('/documents', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async updateDocument(
    documentId: string,
    patch: ContextDocumentPatch,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ContextDocument> {
    const { data, error, response } = await this.client.PATCH('/documents/{id}', {
      params: {
        path: { id: documentId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: patch,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async deleteDocument(
    documentId: string,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const { error, response } = await this.client.DELETE('/documents/{id}', {
      params: {
        path: { id: documentId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    this.versions.delete(`document:${documentId}`);
  }

  /** If-Match is the NOTE version; the answer is the note at version + 1. */
  async linkDocument(
    documentId: string,
    link: DocumentLinkCreate,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ContextDocument> {
    const { data, error, response } = await this.client.POST('/documents/{id}/links', {
      params: {
        path: { id: documentId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: link,
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async unlinkDocument(
    documentId: string,
    linkId: string,
    idempotencyKey: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ): Promise<ContextDocument> {
    const { data, error, response } = await this.client.DELETE('/documents/{id}/links/{linkId}', {
      params: {
        path: { id: documentId, linkId },
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async listDocumentAiUsage(
    documentId: string,
    options: { cursor?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<NoteAiUsagePage> {
    const { data, error, response } = await this.client.GET('/documents/{id}/ai-usage', {
      params: { path: { id: documentId }, query: pageQuery(options) },
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty AI usage page');
    return data;
  }

  /**
   * 07 §7 "작업 설명을 노트로 승격": If-Match is the TASK version. 409
   * `illegal_transition` means a live promoted note already exists.
   */
  async promoteTaskDescription(
    taskId: string,
    idempotencyKey: string,
    expectedTaskVersion: number,
    signal?: AbortSignal,
  ): Promise<ContextDocument> {
    const { data, error, response } = await this.client.POST('/tasks/{id}:promote-description', {
      params: {
        path: { id: taskId },
        header: { 'If-Match': etagForVersion(expectedTaskVersion), 'Idempotency-Key': idempotencyKey },
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty document response');
    this.remember(`document:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  private async resolveTaskVersion(taskId: string): Promise<number> {
    const cached = this.versions.get(`task:${taskId}`);
    if (cached !== undefined) return cached;
    const task = await this.getTask(taskId, { fresh: true });
    return task.version;
  }

  private remember(key: string, version: number, etag?: string | null): void {
    this.versions.set(key, versionFromEtag(etag ?? null) ?? version);
  }
}

export const plannerClient = new PlannerClient();

export function createPlannerClient(options: PlannerClientOptions = {}): PlannerClient {
  return new PlannerClient(options);
}
