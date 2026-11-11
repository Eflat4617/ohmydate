import type { IntakeError as IntakeErrorDto } from '@ohmydate/contracts';
import type { Id } from '@ohmydate/domain';
import {
  DEFAULT_PROMPT_LIMIT_OVERRIDES,
  DEFAULT_STRUCTURED_TIMEOUT_MS,
  promptLimitsFor,
  type PromptLimitOverrides,
} from '@ohmydate/llm';

/**
 * FU-76: long AI calls inside intake requests.
 *
 * An intake request that calls the LLM (create -> type detection;
 * answers / type confirmation / resume -> decomposition) runs the call inline
 * and keeps going when the client disconnects: a reload or a network blip
 * never cancels the run or causes a second charge. The reloaded client polls
 * `GET /intake-sessions/{id}` instead (in-progress rule below).
 *
 * Cancellation is explicit only: `POST /intake-sessions/{id}:manual` aborts
 * the session's in-flight run through this in-process registry. Graceful
 * shutdown aborts every run through the application shutdown signal and marks
 * the session `ai_interrupted`; `POST :resume` re-runs it (a new charge, by an
 * explicit user action). Runs orphaned by a crash are swept once they are
 * older than `intakeAiRequestBoundMs`.
 */

/** session.error.code: the run was aborted by shutdown/crash; POST :resume retries it. */
export const AI_INTERRUPTED_CODE = 'ai_interrupted';
/** session.error.code: the user cancelled the run (POST :manual); manual mode continues. */
export const AI_CANCELLED_CODE = 'ai_cancelled';

export const AI_INTERRUPTED_ERROR: IntakeErrorDto = Object.freeze({
  code: AI_INTERRUPTED_CODE,
  message: 'the AI run was interrupted (server restart); retry with :resume or continue manually',
});
export const AI_CANCELLED_ERROR: IntakeErrorDto = Object.freeze({
  code: AI_CANCELLED_CODE,
  message: 'the AI run was cancelled by the user; manual mode',
});

/** Backoff between unavailable retries plus scheduling slack inside one call. */
export const AI_CALL_SLACK_MS = 10_000;
/** Policy/ledger round trips and draft persistence around the call. */
export const AI_REQUEST_OVERHEAD_MS = 20_000;
/** How long :manual waits for an aborted run to record its outcome. */
export const AI_CANCEL_SETTLE_WAIT_MS = 5_000;

/**
 * Wall-clock bound for one structured call of `promptId` (runStructured
 * `totalTimeoutMs`): one attempt plus the single repair, plus slack.
 * Decomposition with the defaults: 2 x 120 s + 10 s = 250 s; type detection
 * 2 x 30 s + 10 s = 70 s.
 */
export function aiCallTotalTimeoutMs(
  promptId: string,
  limits: PromptLimitOverrides = DEFAULT_PROMPT_LIMIT_OVERRIDES,
): number {
  const attemptMs = promptLimitsFor(promptId, limits)?.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS;
  return 2 * attemptMs + AI_CALL_SLACK_MS;
}

/**
 * Effective server bound of one intake AI request (one AI call plus its
 * persistence); 270 s with the defaults. The HTTP socket inactivity guard
 * (300 s default) stays above it and the web client never gives up earlier
 * than 315 s (apps/web `AI_REQUEST_CLIENT_BOUND_MS`). A session that still
 * looks in flight after this long, with no run in this process, is orphaned.
 */
export function intakeAiRequestBoundMs(
  limits: PromptLimitOverrides = DEFAULT_PROMPT_LIMIT_OVERRIDES,
): number {
  return (
    Math.max(aiCallTotalTimeoutMs('decomposition', limits), aiCallTotalTimeoutMs('type_detection', limits)) +
    AI_REQUEST_OVERHEAD_MS
  );
}

export type AiRunAbortCause = 'user_cancelled' | 'shutdown';
export type AiRunOutcome = 'completed' | 'cancelled';
export type AiCancelResult = 'none' | AiRunOutcome | 'timeout';

interface RunEntry {
  readonly controller: AbortController;
  readonly done: Promise<AiRunOutcome>;
  readonly resolve: (outcome: AiRunOutcome) => void;
}

export interface AiRunHandle {
  /** Aborted by an explicit cancel or by the ambient shutdown signal. */
  readonly signal: AbortSignal;
  /** Why the run was aborted, if it was. */
  abortCause(): AiRunAbortCause | undefined;
  /** Release the registration; `cancelled` when the run ended because of an abort. */
  finish(outcome: AiRunOutcome): void;
}

function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if (signals.length === 1 && signals[0] !== undefined) return signals[0];
  return AbortSignal.any([...signals]);
}

/**
 * In-process registry of intake AI runs keyed by owner + session. The API is a
 * single process (local-only deploy), so this is the authority for "is this
 * session's run alive"; across a restart the startup sweep takes over.
 */
export class IntakeAiRunRegistry {
  readonly #runs = new Map<string, Set<RunEntry>>();

  #key(ownerId: Id, sessionId: Id): string {
    return `${ownerId}:${sessionId}`;
  }

  start(ownerId: Id, sessionId: Id, ambient?: AbortSignal): AiRunHandle {
    const key = this.#key(ownerId, sessionId);
    const controller = new AbortController();
    let resolve: (outcome: AiRunOutcome) => void = () => undefined;
    const done = new Promise<AiRunOutcome>((settle) => {
      resolve = settle;
    });
    const entry: RunEntry = { controller, done, resolve };
    let entries = this.#runs.get(key);
    if (entries === undefined) {
      entries = new Set<RunEntry>();
      this.#runs.set(key, entries);
    }
    entries.add(entry);
    const signal = anySignal(ambient === undefined ? [controller.signal] : [controller.signal, ambient]);
    let finished = false;
    return {
      signal,
      abortCause: () => {
        if (controller.signal.aborted) return 'user_cancelled';
        if (ambient?.aborted === true) return 'shutdown';
        return undefined;
      },
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        const current = this.#runs.get(key);
        current?.delete(entry);
        if (current !== undefined && current.size === 0) this.#runs.delete(key);
        entry.resolve(outcome);
      },
    };
  }

  isRunning(ownerId: Id, sessionId: Id): boolean {
    return (this.#runs.get(this.#key(ownerId, sessionId))?.size ?? 0) > 0;
  }

  /**
   * Abort every live run of the session and wait (bounded) for each to record
   * its outcome. `none` when nothing was running.
   */
  async cancel(ownerId: Id, sessionId: Id, waitMs: number = AI_CANCEL_SETTLE_WAIT_MS): Promise<AiCancelResult> {
    const entries = [...(this.#runs.get(this.#key(ownerId, sessionId)) ?? [])];
    if (entries.length === 0) return 'none';
    for (const entry of entries) entry.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, waitMs));
    });
    try {
      const outcome = await Promise.race([
        Promise.all(entries.map((entry) => entry.done)).then((outcomes) =>
          outcomes.includes('cancelled') ? ('cancelled' as const) : ('completed' as const),
        ),
        timeout,
      ]);
      return outcome;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
