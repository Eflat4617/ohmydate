import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, apiErrorFromPayload } from './errors';
import type { components, paths } from './schema';

export type Task = components['schemas']['Task'];
export type TaskCreate = components['schemas']['TaskCreate'];
export type TaskPatch = components['schemas']['TaskPatch'];
export type TaskStatus = Task['status'];
export type Project = components['schemas']['Project'];
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
export type Plan = components['schemas']['Plan'];
export type PlanCandidate = components['schemas']['PlanCandidate'];
export type PlanCreate = components['schemas']['PlanCreate'];
export type PlanBlock = components['schemas']['PlanBlock'];
export type PlanMetrics = components['schemas']['PlanMetrics'];
export type PreviewEditResponse = components['schemas']['PreviewEditResponse'];
export type ScheduleBlock = components['schemas']['ScheduleBlock'];
export type Violation = PreviewEditResponse['violations'][number];

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

  async listProjects(options: { cursor?: string; limit?: number } = {}): Promise<Page<Project>> {
    const { data, error, response } = await this.client.GET('/projects', {
      params: { query: pageQuery(options) },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty project page');
    for (const project of data.items) {
      this.remember(`project:${project.id}`, project.version);
    }
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

  async listTasks(
    options: { projectId?: string; status?: TaskStatus; cursor?: string; limit?: number } = {},
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

    const { data, error, response } = await this.client.GET('/tasks', { params: { query } });
    if (!response.ok) throw apiErrorFromPayload(response.status, error, response.headers);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task page');
    for (const task of data.items) this.remember(`task:${task.id}`, task.version);
    return data;
  }

  async getTask(taskId: string, options: { fresh?: boolean } = {}): Promise<Task> {
    const { data, error, response } = await this.client.GET('/tasks/{id}', {
      params: { path: { id: taskId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
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
    options: { from: string; to: string; cursor?: string; limit?: number },
  ): Promise<Page<Commitment>> {
    const query: { from: string; to: string; cursor?: string; limit?: number } = {
      from: options.from,
      to: options.to,
    };
    if (options.cursor !== undefined) query.cursor = options.cursor;
    if (options.limit !== undefined) query.limit = options.limit;
    const { data, error, response } = await this.client.GET('/commitments', {
      params: { query },
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

  async createIntakeSession(
    input: IntakeInput,
    idempotencyKey: string,
  ): Promise<IntakeSession> {
    const { data, error, response } = await this.client.POST('/intake-sessions', {
      body: { input },
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
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
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const { data, error, response } = await this.client.POST('/intake-sessions/{id}/answers', {
      params: {
        path: { id: sessionId },
        header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
      },
      body: { answers: [...answers] },
    });
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
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const { data, error, response } = await this.client.POST(
      '/intake-sessions/{id}/type-confirmation',
      {
        params: {
          path: { id: sessionId },
          header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
        },
        body: confirmation,
      },
    );
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

  async resumeIntakeSession(
    sessionId: string,
    idempotencyKey: string,
    expectedVersion?: number,
  ): Promise<IntakeSession> {
    return this.intakeAction(sessionId, 'resume', idempotencyKey, expectedVersion);
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
  ): Promise<IntakeSession> {
    const version = expectedVersion ?? (await this.resolveIntakeVersion(sessionId));
    const params = {
      path: { id: sessionId },
      header: { 'If-Match': etagForVersion(version), 'Idempotency-Key': idempotencyKey },
    };
    const result =
      action === 'pause'
        ? await this.client.POST('/intake-sessions/{id}:pause', { params })
        : action === 'resume'
          ? await this.client.POST('/intake-sessions/{id}:resume', { params })
          : action === 'cancel'
            ? await this.client.POST('/intake-sessions/{id}:cancel', { params })
            : await this.client.POST('/intake-sessions/{id}:manual', { params });
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
