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

  async createIntakeSession(
    input: IntakeInput,
    idempotencyKey: string,
  ): Promise<IntakeSession> {
    const { data, error, response } = await this.client.POST('/intake-sessions', {
      body: { input },
      params: { header: { 'Idempotency-Key': idempotencyKey } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty template page');
    }
    return data;
  }

  async getTaskTemplate(templateId: string): Promise<TaskTemplate> {
    const { data, error, response } = await this.client.GET('/templates/{id}', {
      params: { path: { id: templateId } },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
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
