import {
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
  type ValidationIssue,
} from '@ohmydate/domain';

/**
 * Minimal typed client for the Vikunja v2.8.0 endpoints used by the planner.
 *
 * The client was written from the published OpenAPI document
 * (`docs/blueprint/vendor/vikunja-v2.8.0-openapi.json`); no upstream source was
 * copied. See `docs/blueprint/vendor/vikunja-v2.8.0-capabilities.md` for the
 * observed behaviour that shapes the error and retry rules below.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VikunjaClientOptions {
  readonly baseUrl: string;
  readonly token?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface VikunjaProblem {
  readonly status?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly code?: number;
  readonly errors?: readonly {
    readonly location?: string;
    readonly message?: string;
  }[];
}

export interface VikunjaUser {
  readonly id: number;
  readonly username?: string;
}

/**
 * The subset of the current user's general settings the adapter needs. Vikunja
 * stores the Inbox as the user's `default_project_id` (ADR-018).
 */
export interface VikunjaGeneralSettings {
  readonly default_project_id?: number;
}

export interface VikunjaUserInfo {
  readonly id: number;
  readonly username?: string;
  readonly settings?: VikunjaGeneralSettings;
}

export interface VikunjaTask {
  readonly id: number;
  readonly project_id?: number;
  readonly title: string;
  readonly description?: string;
  readonly done?: boolean;
  readonly due_date?: string;
  readonly created?: string;
  readonly updated?: string;
  readonly deleted_at?: string;
  readonly related_tasks?: Record<string, readonly VikunjaTask[] | null> | null;
}

export interface VikunjaProject {
  readonly id: number;
  readonly title: string;
  readonly is_archived?: boolean;
  readonly created?: string;
  readonly updated?: string;
  readonly deleted_at?: string;
  readonly owner?: VikunjaUser;
  readonly parent_project_id?: number | null;
}

export interface Paginated<T> {
  readonly items?: readonly T[] | null;
  readonly total?: number;
  readonly page?: number;
  readonly per_page?: number;
  readonly total_pages?: number;
}

export interface LoginResult {
  readonly token: string;
}

export interface CreateTokenInput {
  readonly title: string;
  readonly expiresAt: string;
  readonly permissions: Readonly<Record<string, readonly string[]>>;
}

export interface CreatedToken {
  readonly id: number;
  readonly token: string;
}

export interface ResponseEnvelope<T> {
  readonly data: T;
  readonly etag: string | null;
  readonly status: number;
}

export interface RequestOptions {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: unknown;
  readonly contentType?: string;
  readonly ifMatch?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 2;
const JSON_CONTENT_TYPE = 'application/json';
const MERGE_PATCH_CONTENT_TYPE = 'application/merge-patch+json';

/**
 * Stable Vikunja numeric error codes observed on the v2.8.0 instance. Only the
 * codes the adapter actually needs to distinguish are listed; the HTTP status
 * remains the primary discriminator.
 */
export const VIKUNJA_ERROR_CODES = {
  validation: 2002,
  taskNotFound: 4002,
  taskInTrash: 4040,
  projectNotFound: 3001,
  badTokenPermission: 14002,
} as const;

export function toValidationIssues(problem: VikunjaProblem | undefined): ValidationIssue[] {
  const issues = problem?.errors ?? [];
  if (issues.length > 0) {
    return issues.map((issue) => ({
      path: issue.location ?? 'body',
      message: issue.message ?? 'invalid value',
    }));
  }
  return [{ path: 'body', message: problem?.detail ?? problem?.title ?? 'validation failed' }];
}

/** Map a Vikunja HTTP failure to the planner domain error hierarchy. */
export function mapVikunjaError(status: number, problem?: VikunjaProblem): Error {
  const code = problem?.code;
  if (
    status === 404 ||
    code === VIKUNJA_ERROR_CODES.taskNotFound ||
    code === VIKUNJA_ERROR_CODES.taskInTrash ||
    code === VIKUNJA_ERROR_CODES.projectNotFound
  ) {
    return new NotFoundError('vikunja resource', String(problem?.detail ?? status));
  }
  if (status === 400 || status === 422 || code === VIKUNJA_ERROR_CODES.validation) {
    return new ValidationFailedError(toValidationIssues(problem));
  }
  if (status === 403) {
    // Vikunja hides foreign resources behind both 403 and 404. The repository
    // additionally filters by owner mapping, but treating 403 as NotFound keeps
    // owner isolation free of information leaks.
    return new NotFoundError('vikunja resource', String(problem?.detail ?? status));
  }
  if (status === 401) {
    return new ProviderUnavailableError('vikunja');
  }
  return new ProviderUnavailableError('vikunja');
}

function parseProblem(text: string): VikunjaProblem | undefined {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as VikunjaProblem;
  } catch {
    return undefined;
  }
}

function sleepDefault(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class TransportFailure extends Error {
  constructor(
    readonly domainError: Error,
    readonly retryable: boolean,
  ) {
    super(domainError.message, { cause: domainError });
    this.name = 'TransportFailure';
  }
}

function buildQuery(
  query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized.length === 0 ? '' : `?${serialized}`;
}

export class VikunjaClient {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  #token: string | undefined;

  constructor(options: VikunjaClientOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = options.retries ?? DEFAULT_RETRIES;
    this.#sleep = options.sleep ?? sleepDefault;
    this.#token = options.token;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  setToken(token: string | undefined): void {
    this.#token = token;
  }

  async register(input: {
    readonly username: string;
    readonly email: string;
    readonly password: string;
  }): Promise<VikunjaUser> {
    const { data } = await this.request<VikunjaUser>('POST', '/register', {
      body: input,
    });
    return data;
  }

  /**
   * API tokens cannot read `/user/settings/*`, but the `other:user` permission
   * exposes the same settings through `GET /user` (ADR-018).
   */
  async getGeneralSettings(): Promise<VikunjaGeneralSettings> {
    const { data } = await this.request<VikunjaUserInfo>('GET', '/user');
    return data.settings ?? {};
  }

  async updateGeneralSettings(
    patch: Readonly<{ default_project_id: number }>,
  ): Promise<VikunjaGeneralSettings> {
    const { data } = await this.request<VikunjaGeneralSettings>(
      'PATCH',
      '/user/settings/general',
      { body: patch, contentType: MERGE_PATCH_CONTENT_TYPE },
    );
    return data;
  }

  async login(username: string, password: string): Promise<string> {
    const { data } = await this.request<LoginResult>('POST', '/login', {
      body: { username, password },
    });
    if (typeof data.token !== 'string' || data.token.length === 0) {
      throw new ProviderUnavailableError('vikunja');
    }
    return data.token;
  }

  /**
   * Create a scoped API token. This endpoint is JWT-only, so callers bootstrap
   * with `login()` first (ADR-016 §6) and then switch the client to the
   * returned `tk_...` token.
   */
  async createApiToken(input: CreateTokenInput): Promise<CreatedToken> {
    const { data } = await this.request<CreatedToken>('POST', '/tokens', {
      body: {
        title: input.title,
        expires_at: input.expiresAt,
        permissions: input.permissions,
      },
    });
    return data;
  }

  async createProject(title: string): Promise<VikunjaProject> {
    const { data } = await this.request<VikunjaProject>('POST', '/projects', {
      body: { title },
    });
    return data;
  }

  async getProject(externalId: string): Promise<ResponseEnvelope<VikunjaProject>> {
    return this.request<VikunjaProject>('GET', `/projects/${encodeURIComponent(externalId)}`);
  }

  async listProjects(page: number, perPage: number): Promise<Paginated<VikunjaProject>> {
    const { data } = await this.request<Paginated<VikunjaProject>>('GET', '/projects', {
      query: { page, per_page: perPage },
    });
    return data;
  }

  async updateProject(
    externalId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<VikunjaProject> {
    await this.request<unknown>('PATCH', `/projects/${encodeURIComponent(externalId)}`, {
      body: patch,
      contentType: MERGE_PATCH_CONTENT_TYPE,
    });
    const { data } = await this.getProject(externalId);
    return data;
  }

  async deleteProject(externalId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/projects/${encodeURIComponent(externalId)}`);
  }

  async permanentDeleteProject(externalId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/projects/${encodeURIComponent(externalId)}/permanent`,
    );
  }

  async createTask(
    externalProjectId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<VikunjaTask> {
    const { data } = await this.request<VikunjaTask>(
      'POST',
      `/projects/${encodeURIComponent(externalProjectId)}/tasks`,
      { body },
    );
    return data;
  }

  async getTask(externalId: string): Promise<ResponseEnvelope<VikunjaTask>> {
    return this.request<VikunjaTask>('GET', `/tasks/${encodeURIComponent(externalId)}`);
  }

  async patchTask(
    externalId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<VikunjaTask> {
    const { data } = await this.request<VikunjaTask>(
      'PATCH',
      `/tasks/${encodeURIComponent(externalId)}`,
      { body: patch, contentType: MERGE_PATCH_CONTENT_TYPE },
    );
    return data;
  }

  async deleteTask(externalId: string): Promise<void> {
    await this.request<unknown>('DELETE', `/tasks/${encodeURIComponent(externalId)}`);
  }

  async permanentDeleteTask(externalId: string): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/tasks/${encodeURIComponent(externalId)}/permanent`,
    );
  }

  async listTasksPage(
    query: Readonly<Record<string, string | number | undefined>>,
  ): Promise<Paginated<VikunjaTask>> {
    const { data } = await this.request<Paginated<VikunjaTask>>('GET', '/tasks', {
      query,
    });
    return data;
  }

  async listProjectTasksPage(
    externalProjectId: string,
    page: number,
    perPage: number,
  ): Promise<Paginated<VikunjaTask>> {
    const { data } = await this.request<Paginated<VikunjaTask>>(
      'GET',
      `/projects/${encodeURIComponent(externalProjectId)}/tasks`,
      { query: { page, per_page: perPage } },
    );
    return data;
  }

  async listDeletedTasksPage(
    page: number,
    perPage: number,
  ): Promise<Paginated<VikunjaTask>> {
    const { data } = await this.request<Paginated<VikunjaTask>>('GET', '/tasks/deleted', {
      query: { page, per_page: perPage },
    });
    return data;
  }

  async listAllTasks(
    query: Readonly<Record<string, string | number | undefined>> = {},
  ): Promise<readonly VikunjaTask[]> {
    return this.#listAll((page, perPage) =>
      this.listTasksPage({ ...query, page, per_page: perPage }),
    );
  }

  async listAllProjectTasks(externalProjectId: string): Promise<readonly VikunjaTask[]> {
    return this.#listAll((page, perPage) =>
      this.listProjectTasksPage(externalProjectId, page, perPage),
    );
  }

  async listAllDeletedTasks(): Promise<readonly VikunjaTask[]> {
    return this.#listAll((page, perPage) => this.listDeletedTasksPage(page, perPage));
  }

  async listAllProjects(): Promise<readonly VikunjaProject[]> {
    return this.#listAll((page, perPage) => this.listProjects(page, perPage));
  }

  async createRelation(
    externalTaskId: string,
    otherTaskId: string,
    relationKind: string,
  ): Promise<void> {
    await this.request<unknown>(
      'POST',
      `/tasks/${encodeURIComponent(externalTaskId)}/relations`,
      { body: { other_task_id: Number(otherTaskId), relation_kind: relationKind } },
    );
  }

  async deleteRelation(
    externalTaskId: string,
    relationKind: string,
    otherTaskId: string,
  ): Promise<void> {
    await this.request<unknown>(
      'DELETE',
      `/tasks/${encodeURIComponent(externalTaskId)}/relations/${encodeURIComponent(
        relationKind,
      )}/${encodeURIComponent(otherTaskId)}`,
    );
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ResponseEnvelope<T>> {
    const url = `${this.#baseUrl}/api/v2${path}${buildQuery(options.query)}`;
    const idempotent = method === 'GET';
    const maxAttempts = idempotent ? this.#retries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.#attempt<T>(method, url, options);
      } catch (error) {
        if (error instanceof TransportFailure) {
          lastError = error.domainError;
          const retryable = idempotent && error.retryable;
          if (!retryable || attempt + 1 >= maxAttempts) break;
        } else {
          lastError = error;
          const retryable = idempotent && isNetworkError(error);
          if (!retryable || attempt + 1 >= maxAttempts) break;
        }
        await this.#sleep(100 * 2 ** attempt);
      }
    }

    if (isNetworkError(lastError)) throw new ProviderUnavailableError('vikunja');
    if (lastError instanceof Error) throw lastError;
    throw new ProviderUnavailableError('vikunja');
  }

  async #attempt<T>(
    method: string,
    url: string,
    options: RequestOptions,
  ): Promise<ResponseEnvelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const headers: Record<string, string> = {
      Accept: JSON_CONTENT_TYPE,
      ...options.headers,
    };
    if (this.#token !== undefined) headers.Authorization = `Bearer ${this.#token}`;
    if (options.body !== undefined) {
      headers['Content-Type'] = options.contentType ?? JSON_CONTENT_TYPE;
    }
    if (options.ifMatch !== undefined) headers['If-Match'] = options.ifMatch;

    let response: Response;
    let text: string;
    try {
      // Keep the abort timer active through body consumption: a provider that
      // sends headers quickly but stalls the body must still time out.
      response = await this.#fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      text = await response.text();
    } catch (error) {
      if (isAbortError(error)) {
        throw new TransportFailure(new ProviderUnavailableError('vikunja'), true);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    // Vikunja answers a merge-patch that changes nothing with 304 Not Modified.
    // For the planner that is a successful no-op write (for example a
    // status-only update that maps to the same `done` value), not an outage;
    // there is no body to parse and the caller re-reads the task when needed.
    if (response.status === 304 && method !== 'GET') {
      return {
        data: undefined as T,
        etag: response.headers.get('etag'),
        status: response.status,
      };
    }

    if (response.status >= 200 && response.status < 300) {
      let data: T | undefined;
      if (text.length > 0) {
        try {
          data = JSON.parse(text) as T;
        } catch {
          // A proxy or misbehaving gateway can return HTML with a 2xx status.
          // Never leak the raw SyntaxError across the domain boundary.
          throw new ProviderUnavailableError('vikunja');
        }
      }
      return {
        data: data as T,
        etag: response.headers.get('etag'),
        status: response.status,
      };
    }

    const problem = parseProblem(text);
    throw new TransportFailure(
      mapVikunjaError(response.status, problem),
      response.status >= 500,
    );
  }

  async #listAll<T>(
    fetchPage: (page: number, perPage: number) => Promise<Paginated<T>>,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const response = await fetchPage(page, 50);
      items.push(...(response.items ?? []));
      const totalPages = response.total_pages ?? 1;
      if (page >= totalPages) break;
      page += 1;
    }
    return items;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}
