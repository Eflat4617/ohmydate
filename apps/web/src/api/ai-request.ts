/**
 * FU-76: intake requests that wait for the AI (create -> type detection;
 * answers / type confirmation / :resume -> decomposition).
 *
 * Effective bounds (keep in step with services/api application/intake/ai-runs.ts):
 * - server, one structured call: 2 x attempt timeout + 10 s (decomposition
 *   2 x 120 s + 10 s = 250 s; type detection 70 s)
 * - server, one intake AI request incl. persistence: 270 s
 * - server HTTP socket inactivity guard: 300 s
 * - this client: 315 s. The client never gives up before the server can
 *   still answer; after the bound it stops waiting on the socket and polls the
 *   session instead (it never re-submits), so a dropped response is never a
 *   second run or a second charge.
 */
export const AI_REQUEST_CLIENT_BOUND_MS = 315_000;

export interface AiRequestOptions {
  /** Explicit cancel (the wizard's 취소 / 직접 작성으로 계속). */
  readonly signal?: AbortSignal;
  /** Test seam; defaults to AI_REQUEST_CLIENT_BOUND_MS. */
  readonly boundMs?: number;
}

/** Thrown (as the fetch rejection) when the client bound expires. */
export class AiRequestTimeoutError extends Error {
  constructor(readonly boundMs: number) {
    super(`AI request exceeded the client bound of ${boundMs}ms`);
    this.name = 'AiRequestTimeoutError';
  }
}

/**
 * Signal for one AI-bearing request: aborted by the caller's signal or by the
 * client bound. Built by hand (no AbortSignal.any/timeout) so it works with
 * every fetch implementation the app and its tests use.
 */
export function aiRequestSignal(options: AiRequestOptions = {}): {
  readonly signal: AbortSignal;
  dispose(): void;
} {
  const boundMs = Math.max(1, options.boundMs ?? AI_REQUEST_CLIENT_BOUND_MS);
  const controller = new AbortController();
  const upstream = options.signal;
  const onAbort = (): void => controller.abort(upstream?.reason);
  if (upstream?.aborted === true) controller.abort(upstream.reason);
  else upstream?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new AiRequestTimeoutError(boundMs)), boundMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', onAbort);
    },
  };
}
