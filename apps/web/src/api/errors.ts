import type { components } from './schema';

export type Problem = components['schemas']['Problem'];
export type ProblemCode = Problem['code'];

const PROBLEM_CODES: ReadonlySet<string> = new Set<ProblemCode>([
  'validation_failed',
  'version_conflict',
  'availability_changed',
  'idempotency_mismatch',
  'provider_unavailable',
  'llm_unavailable',
  'budget_exceeded',
  'dependency_cycle',
  'illegal_transition',
  'approval_in_progress',
  'not_found',
  'forbidden',
  'rate_limited',
  'unauthenticated',
  'idempotency_in_progress',
  'internal_error',
]);

export type ApiErrorCode = ProblemCode | 'unknown';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly detail: string;
  readonly problem: Problem | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    detail: string,
    problem?: Problem,
    retryAfterSeconds?: number,
  ) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.problem = problem;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function parseProblem(body: unknown): Problem | null {
  if (body === null || typeof body !== 'object') return null;
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.title !== 'string' ||
    typeof candidate.status !== 'number' ||
    typeof candidate.code !== 'string' ||
    !PROBLEM_CODES.has(candidate.code)
  ) {
    return null;
  }
  return candidate as unknown as Problem;
}

export function apiErrorFromPayload(
  status: number,
  body: unknown,
  headers?: Headers | Record<string, string>,
): ApiError {
  const retryAfter = parseRetryAfter(headers);
  const problem = parseProblem(body);
  if (problem !== null) {
    const detail = problem.detail ?? problem.title;
    return new ApiError(problem.status, problem.code, detail, problem, retryAfter);
  }
  return new ApiError(status, 'unknown', `Request failed with status ${status}`, undefined, retryAfter);
}

function headerValue(
  headers: Headers | Record<string, string> | undefined,
  name: string,
): string | null {
  if (headers === undefined) return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : (record[key] ?? null);
}

function parseRetryAfter(headers: Headers | Record<string, string> | undefined): number | undefined {
  const raw = headerValue(headers, 'Retry-After');
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return apiErrorFromPayload(response.status, body, response.headers);
}
