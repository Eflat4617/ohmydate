import { ApiError, type ApiErrorCode } from '../api/errors';
import { t } from './index';

/**
 * User-facing text for API failures. The server's `title`/`detail` are
 * developer English and never reach the screen; the stable `code` picks a
 * Korean message from the catalog (every code of the exhaustive problem map
 * has one, which the catalog's `satisfies Record<ApiErrorCode, string>` and
 * the catalog test enforce).
 */

/** An error whose `message` is already localized copy for the user. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

export function problemMessage(code: ApiErrorCode): string {
  return t(`problem.${code}`);
}

export function apiErrorMessage(error: ApiError): string {
  if (error.code === 'rate_limited' && error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0) {
    return t('errors.rateLimitedRetry', { seconds: Math.ceil(error.retryAfterSeconds) });
  }
  if (error.code === 'unknown') {
    if (error.status >= 500) return problemMessage('internal_error');
    if (error.status === 401) return problemMessage('unauthenticated');
    if (error.status === 403) return problemMessage('forbidden');
    if (error.status === 404) return problemMessage('not_found');
    if (error.status > 0) return t('errors.unknownStatus', { status: error.status });
  }
  return problemMessage(error.code);
}

/**
 * Message for anything a request can throw: API problems by code, localized
 * client errors as-is, network failures (`fetch` rejects with `TypeError`)
 * as a connection hint, and everything else as `fallback`.
 */
export function errorMessage(cause: unknown, fallback: string = t('errors.generic')): string {
  if (cause instanceof ApiError) return apiErrorMessage(cause);
  if (cause instanceof UserFacingError) return cause.message;
  if (cause instanceof TypeError) return t('errors.network');
  return fallback;
}
