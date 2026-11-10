import type { Problem, ProblemCode } from '@ohmydate/contracts';
import {
  DependencyCycleError,
  DomainError,
  IdempotencyMismatchError,
  NotFoundError,
  ProviderUnavailableError,
  ValidationFailedError,
  VersionConflictError,
  type ValidationIssue,
} from '@ohmydate/domain';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface ProblemInit {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail?: string;
  readonly errors?: readonly ValidationIssue[];
}

/**
 * Transport-level failures (authentication, CSRF, pending idempotency key).
 * Domain failures travel as DomainError and are mapped centrally.
 */
export class ProblemError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: readonly ValidationIssue[] | undefined;

  constructor(init: ProblemInit) {
    super(init.detail ?? init.title, init.errors === undefined ? undefined : { cause: init.errors });
    this.name = 'ProblemError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors;
  }
}

function problemBody(
  status: number,
  code: ProblemCode,
  title: string,
  detail: string | undefined,
  errors: readonly ValidationIssue[] | undefined,
  traceId: string | undefined,
): Problem {
  return {
    type: 'about:blank',
    title,
    status,
    code,
    ...(detail === undefined ? {} : { detail }),
    ...(errors === undefined || errors.length === 0
      ? {}
      : { errors: errors.map((issue) => ({ path: issue.path, message: issue.message })) }),
    ...(traceId === undefined ? {} : { traceId }),
  };
}

export function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: ProblemCode,
  title: string,
  detail?: string,
  errors?: readonly ValidationIssue[],
): FastifyReply {
  const traceId = typeof request.id === 'string' ? request.id : undefined;
  return reply
    .code(status)
    .type('application/problem+json')
    .send(problemBody(status, code, title, detail, errors, traceId));
}

interface ValidationErrorLike {
  readonly instancePath?: string;
  readonly message?: string;
  readonly params?: { readonly missingProperty?: string };
}

function toValidationIssues(errors: readonly ValidationErrorLike[]): ValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath === undefined || error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'invalid value',
  }));
}

export function domainErrorToProblem(error: DomainError): ProblemInit {
  if (error instanceof NotFoundError) {
    return { status: 404, code: 'not_found', title: 'Not found', detail: error.message };
  }
  if (error instanceof VersionConflictError) {
    return { status: 412, code: 'version_conflict', title: 'Version precondition failed', detail: error.message };
  }
  if (error instanceof ValidationFailedError) {
    return {
      status: 422,
      code: 'validation_failed',
      title: 'Domain validation failed',
      detail: error.message,
      errors: error.issues,
    };
  }
  if (error instanceof ProviderUnavailableError) {
    return {
      status: 503,
      code: 'provider_unavailable',
      title: 'Provider unavailable',
      detail: error.message,
    };
  }
  if (error instanceof DependencyCycleError) {
    return {
      status: 422,
      code: 'dependency_cycle',
      title: 'Dependency cycle detected',
      detail: error.message,
    };
  }
  if (error instanceof IdempotencyMismatchError) {
    return {
      status: 422,
      code: 'idempotency_mismatch',
      title: 'Idempotency key reuse',
      detail: error.message,
    };
  }
  return { status: 500, code: 'validation_failed', title: 'Internal error', detail: error.message };
}

export interface FastifyValidationError {
  readonly validation?: readonly ValidationErrorLike[];
  readonly statusCode?: number;
  readonly message?: string;
}

export function sendValidationProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  error: FastifyValidationError,
): FastifyReply {
  const issues = toValidationIssues(error.validation ?? []);
  return sendProblem(
    request,
    reply,
    400,
    'validation_failed',
    'Malformed request',
    error.message ?? 'request validation failed',
    issues,
  );
}
