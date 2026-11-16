import { ApiError } from '../api/errors';
import { isDesktop } from './mode';

/**
 * "This place is not ready" (blueprint 15 §1.4, §7.3).
 *
 * The desktop core is being ported one area at a time. An operation it does
 * not serve yet answers 501; that is not a failure of the request and asking
 * again cannot help. So in a desktop bundle a 501 is never retried, the place
 * that asked says calmly that it is not ready, and nothing is thrown.
 *
 * Only in a desktop bundle: the deployed server never answers 501, and there
 * a 5xx keeps meaning what it always meant.
 */
export const NOT_READY_STATUS = 501;

export function isNotReady(cause: unknown): boolean {
  return isDesktop() && cause instanceof ApiError && cause.status === NOT_READY_STATUS;
}

/** Whether any of the causes (query errors; null where there is none) is "not ready". */
export function anyNotReady(...causes: readonly unknown[]): boolean {
  return causes.some((cause) => isNotReady(cause));
}
