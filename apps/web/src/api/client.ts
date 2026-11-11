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
export type PlanVersion = components['schemas']['PlanVersion'];
export type Page<T> = { items: T[]; nextCursor: string | null };

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

  cachedTodayVersion(): number | undefined {
    return this.versions.get('today');
  }

  cachedSessionVersion(sessionId: string): number | undefined {
    return this.versions.get(`session:${sessionId}`);
  }

  cachedNotificationVersion(notificationId: string): number | undefined {
    return this.versions.get(`notification:${notificationId}`);
  }

  async getToday(date: string): Promise<Today> {
    const { data, error, response } = await this.client.GET('/today', {
      params: { query: { date } },
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
  ): Promise<Today> {
    const { data, error, response } = await this.client.POST('/today:accept', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
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
  ): Promise<TodayProposal> {
    const { data, error, response } = await this.client.POST('/today:shrink', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
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
  ): Promise<TodayProposal> {
    const { data, error, response } = await this.client.POST('/today:reschedule', {
      params: {
        header: { 'If-Match': etagForVersion(expectedVersion), 'Idempotency-Key': idempotencyKey },
      },
      body: input,
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
  ): Promise<PlanVersion> {
    const { data, error, response } = await this.client.POST('/today/proposals/{id}:approve', {
      params: {
        path: { id: proposalId },
        header: { 'If-Match': ifMatch, 'Idempotency-Key': idempotencyKey },
      },
    });
    if (!response.ok) throw apiErrorFromPayload(response.status, error);
    if (data === undefined) {
      throw new ApiError(response.status, 'unknown', 'Empty plan version response');
    }
    return data;
  }

  async createSession(input: SessionCreate, idempotencyKey: string): Promise<WorkSession> {
    const { data, error, response } = await this.client.POST('/sessions', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: input,
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
