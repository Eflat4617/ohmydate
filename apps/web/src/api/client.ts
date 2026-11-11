import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, apiErrorFromPayload } from './errors';
import type { components, paths } from './schema';

export type Task = components['schemas']['Task'];
export type TaskCreate = components['schemas']['TaskCreate'];
export type TaskPatch = components['schemas']['TaskPatch'];
export type TaskStatus = Task['status'];
export type Project = components['schemas']['Project'];
export type User = components['schemas']['User'];
export type Page<T> = { items: T[]; nextCursor: string | null };
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
export type PlanVersion = components['schemas']['PlanVersion'];
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
  }

  async logout(): Promise<void> {
    const { error, response } = await this.client.POST('/auth/logout');
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
  }

  async getMe(): Promise<User> {
    const { data, error, response } = await this.client.GET('/me');
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty user response');
    this.remember('user', data.version, response.headers.get('ETag'));
    return data;
  }

  async listProjects(options: { cursor?: string; limit?: number } = {}): Promise<Page<Project>> {
    const { data, error, response } = await this.client.GET('/projects', {
      params: { query: pageQuery(options) },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task page');
    for (const task of data.items) this.remember(`task:${task.id}`, task.version);
    return data;
  }

  async getTask(taskId: string, options: { fresh?: boolean } = {}): Promise<Task> {
    const { data, error, response } = await this.client.GET('/tasks/{id}', {
      params: { path: { id: taskId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty task response');
    this.remember(`task:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async createTask(input: TaskCreate, idempotencyKey: string): Promise<Task> {
    const { data, error, response } = await this.client.POST('/tasks', {
      body: input,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    this.versions.delete(`commitment:${commitmentId}`);
  }

  async createPlan(input: PlanCreate, idempotencyKey: string): Promise<Plan> {
    const { data, error, response } = await this.client.POST('/plans', {
      body: input,
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) throw new ApiError(response.status, 'unknown', 'Empty plan response');
    this.remember(`plan:${data.id}`, data.version, response.headers.get('ETag'));
    return data;
  }

  async getPlan(planId: string, options: { fresh?: boolean } = {}): Promise<Plan> {
    const { data, error, response } = await this.client.GET('/plans/{id}', {
      params: { path: { id: planId } },
      ...(options.fresh === true ? { cache: 'no-store' as RequestCache } : {}),
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
