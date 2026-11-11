import type { BudgetGuard } from './budget.js';
import {
  BudgetExceeded,
  LlmError,
  LlmTimeoutError,
  LlmUnavailable,
  SchemaViolation,
} from './errors.js';
import { renderOutputContract } from './output-contract.js';
import type { LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';
import {
  DEFAULT_PROMPT_LIMIT_OVERRIDES,
  DEFAULT_STRUCTURED_TIMEOUT_MS,
  promptLimitsFor,
  type PromptLimitOverrides,
} from './prompt-limits.js';
import { hasSchema, validateOutput } from './schema-registry.js';

export interface StructuredLlmRequest {
  readonly promptId: string;
  readonly version: string;
  readonly input: unknown;
  readonly schemaId: string;
  /** Propagated to the provider so consent/budget are resolved per owner. */
  readonly ownerId?: string;
  /** Intake session id; adapters may derive a non-identifying session header. */
  readonly sessionKey?: string;
  readonly budget?: import('./port.js').LlmBudget;
  /** Forwarded to the port on every attempt (see `LlmCompleteRequest.onDispatch`). */
  readonly onDispatch?: () => void;
  /** Explicit per-call output bound; otherwise the prompt's limit override (if any). */
  readonly maxOutputTokens?: number;
  /** Forwarded to the port: the ledger rows of every attempt link to this run. */
  readonly agentRunId?: string;
}

export interface RunStructuredOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  /** Retries after an `LlmUnavailable` (default 2, per 05 §8). */
  readonly maxUnavailableRetries?: number;
  readonly backoffBaseMs?: number;
  /** Explicit per-call timeout; otherwise the prompt's override, else 30 s. */
  readonly timeoutMs?: number;
  /** Per-prompt limits (default: DEFAULT_PROMPT_LIMIT_OVERRIDES, decomposition 8000 / 120 s). */
  readonly promptLimits?: PromptLimitOverrides;
  readonly budgetGuard?: BudgetGuard;
  /** Explicit opt-out for tests only (FakeLlm); production calls require a guard. */
  readonly allowUnbudgeted?: boolean;
  readonly estimatedCostUsd?: number;
  readonly signal?: AbortSignal;
  /**
   * FU-76: wall-clock bound for the whole call (every attempt, retry backoff
   * and the single repair). Each attempt's timer is the smaller of its
   * per-attempt timeout and the time left; with nothing left the call fails as
   * `LlmTimeoutError` before another attempt is reserved. Absent -> unbounded
   * chain (each attempt still has its own timer).
   */
  readonly totalTimeoutMs?: number;
  /**
   * FU-54: after a timeout or caller abort wins the race against an attempt
   * whose billing policy already reported a charge, wait at most this long for
   * the attempt to settle so the policy's final charge is recorded. Default 1000.
   */
  readonly abortSettleGraceMs?: number;
  /** Test seam for the total-deadline clock (default `Date.now`). */
  readonly now?: () => number;
}

/** Default FU-54 grace for an aborted, already-charged attempt to settle. */
export const DEFAULT_ABORT_SETTLE_GRACE_MS = 1_000;

export interface RunStructuredResult {
  readonly output: unknown;
  readonly usage: LlmUsage;
  readonly model: string;
  /** Provider id for agent_run metadata (defaults to the adapter's response). */
  readonly provider?: string;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly repairs: number;
  readonly schemaId: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Append validation errors to the input for the single repair attempt. With a
 * `schemaId` the rendered output contract is repeated next to the errors (it is
 * also in the system message). Exported so tests can register the exact repaired
 * fixture in `FakeLlm`.
 */
export function appendValidationErrors(
  input: unknown,
  errors: readonly string[],
  schemaId?: string,
): unknown {
  const repair = {
    schemaValidationErrors: [...errors],
    ...(schemaId !== undefined && hasSchema(schemaId)
      ? { outputContract: renderOutputContract(schemaId) }
      : {}),
  };
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), ...repair };
  }
  return { input, ...repair };
}

/** Resolves when `call` settles (either way) or after `graceMs`, whichever is first. */
async function settledWithin(call: Promise<unknown>, graceMs: number): Promise<void> {
  if (graceMs <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      call.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function callWithTimeout(
  port: LlmPort,
  request: Parameters<LlmPort['complete']>[0],
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  settleGraceMs: number,
): Promise<LlmCompleteResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeOuterListener: (() => void) | undefined;
  let raceError: LlmError | undefined;
  // FU-54: the latest charge the policy reported for THIS attempt (its
  // reservation as soon as it is made, then the settled amount).
  let charge: LlmUsage | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortWith = (reason: LlmError): void => {
      raceError = reason;
      reject(reason);
      controller.abort(reason);
    };

    if (outerSignal?.aborted === true) {
      abortWith(new LlmUnavailable('llm call aborted by caller', 'aborted'));
      return;
    }

    timer = setTimeout(() => {
      abortWith(new LlmTimeoutError(timeoutMs));
    }, timeoutMs);

    if (outerSignal !== undefined) {
      const onAbort = (): void => {
        abortWith(new LlmUnavailable('llm call aborted by caller', 'aborted'));
      };
      outerSignal.addEventListener('abort', onAbort, { once: true });
      removeOuterListener = () => outerSignal.removeEventListener('abort', onAbort);
    }
  });

  // A pre-aborted signal never dispatches the attempt (no reservation, no charge).
  if (raceError !== undefined) {
    // The abort promise already rejected; observe it so it is not reported as unhandled.
    abortPromise.catch(() => undefined);
    return Promise.reject(raceError);
  }

  const upstreamCharge = request.onCharge;
  const call = port.complete({
    ...request,
    signal: controller.signal,
    onCharge: (usage) => {
      charge = usage;
      upstreamCharge?.(usage);
    },
  });
  return Promise.race([call, abortPromise])
    .catch(async (error: unknown) => {
      // FU-54: the timer or the caller abort beat the attempt, so the attempt's
      // own error (with the usage its policy settled) is never seen here. When a
      // billing policy has reported a charge for this attempt, give the aborted
      // attempt a bounded moment to settle (the transport aborts at once) and
      // carry the policy's final charge, so agent_run cost matches the ledger.
      // An attempt with no reported charge (no policy, or aborted before its
      // reservation) is not waited for.
      if (error === raceError && raceError !== undefined && charge !== undefined) {
        await settledWithin(call, settleGraceMs);
        raceError.usage = charge;
      }
      throw error;
    })
    .finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      removeOuterListener?.();
    });
}

export async function runStructured(
  port: LlmPort,
  request: StructuredLlmRequest,
  options: RunStructuredOptions = {},
): Promise<RunStructuredResult> {
  const sleep = options.sleep ?? defaultSleep;
  const maxUnavailableRetries = Math.max(0, options.maxUnavailableRetries ?? 2);
  const backoffBaseMs = Math.max(0, options.backoffBaseMs ?? 250);
  const limits = promptLimitsFor(
    request.promptId,
    options.promptLimits ?? DEFAULT_PROMPT_LIMIT_OVERRIDES,
  );
  const timeoutMs = options.timeoutMs ?? limits?.timeoutMs ?? DEFAULT_STRUCTURED_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const settleGraceMs = Math.max(0, options.abortSettleGraceMs ?? DEFAULT_ABORT_SETTLE_GRACE_MS);
  const totalTimeoutMs =
    options.totalTimeoutMs !== undefined &&
    Number.isFinite(options.totalTimeoutMs) &&
    options.totalTimeoutMs > 0
      ? options.totalTimeoutMs
      : undefined;
  const deadline = totalTimeoutMs === undefined ? undefined : now() + totalTimeoutMs;
  const maxOutputTokens = request.maxOutputTokens ?? limits?.maxOutputTokens;
  // Forward the timeout to the adapter only when it is not the historical default,
  // so the adapter's own per-attempt timer never undercuts a longer call budget.
  const forwardTimeout = options.timeoutMs !== undefined || limits !== undefined;
  const budgetGuard = options.budgetGuard;

  if (budgetGuard === undefined && options.allowUnbudgeted !== true) {
    throw new BudgetExceeded('daily', 0, 0, 'not_configured');
  }

  let input = request.input;
  let attempts = 0;
  let unavailableRetries = 0;
  let repairs = 0;
  const totalUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    costUsd?: number;
  } = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

  const addUsage = (usage: LlmUsage): void => {
    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.outputTokens += usage.outputTokens;
    if (usage.cachedInputTokens !== undefined) {
      totalUsage.cachedInputTokens =
        (totalUsage.cachedInputTokens ?? 0) + usage.cachedInputTokens;
    }
    if (usage.costUsd !== undefined) {
      totalUsage.costUsd = (totalUsage.costUsd ?? 0) + usage.costUsd;
    }
  };

  const assertNotAborted = (): void => {
    if (options.signal?.aborted === true) {
      throw new LlmUnavailable('llm call aborted by caller', 'aborted');
    }
  };

  try {
    for (;;) {
      assertNotAborted();
      // FU-76: never start (or reserve) an attempt the total bound cannot cover.
      const remainingMs = deadline === undefined ? timeoutMs : deadline - now();
      if (remainingMs <= 0) throw new LlmTimeoutError(totalTimeoutMs ?? timeoutMs);
      const attemptTimeoutMs = Math.min(timeoutMs, Math.ceil(remainingMs));
      budgetGuard?.assertCanSpend(options.estimatedCostUsd ?? 0);
      attempts += 1;

      let response: LlmCompleteResponse;
      try {
        response = await callWithTimeout(
          port,
          {
            promptId: request.promptId,
            version: request.version,
            input,
            schemaId: request.schemaId,
            ...(request.ownerId === undefined ? {} : { ownerId: request.ownerId }),
            ...(request.sessionKey === undefined ? {} : { sessionKey: request.sessionKey }),
            ...(request.budget === undefined ? {} : { budget: request.budget }),
            ...(request.onDispatch === undefined ? {} : { onDispatch: request.onDispatch }),
            ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            ...(forwardTimeout || attemptTimeoutMs < timeoutMs
              ? { timeoutMs: attemptTimeoutMs }
              : {}),
          },
          attemptTimeoutMs,
          options.signal,
          settleGraceMs,
        );
      } catch (error) {
        // A failed attempt can still be billable (e.g. PolicyLlm settles the
        // reservation); keep that usage before deciding whether to retry.
        if (error instanceof LlmError && error.usage !== undefined) addUsage(error.usage);
        if (!(error instanceof LlmUnavailable)) throw error;
        // Caller aborts and timeouts are never retried (05 §8: only 429/5xx outages).
        if (error.reason === 'aborted') throw error;
        if (error instanceof LlmTimeoutError) throw error;
        // The adapter already exhausted its own 429/5xx retries, or the failure
        // was a non-retryable 4xx. Never start a second retry loop.
        if (!error.retryable) throw error;
        assertNotAborted();
        if (unavailableRetries < maxUnavailableRetries) {
          unavailableRetries += 1;
          assertNotAborted();
          await sleep(backoffBaseMs * 2 ** (unavailableRetries - 1));
          continue;
        }
        throw error;
      }

      budgetGuard?.record(response.usage, { model: response.model });
      addUsage(response.usage);

      const validation = validateOutput(request.schemaId, response.output);
      if (validation.valid) {
        return {
          output: response.output,
          usage: totalUsage as LlmUsage,
          model: response.model,
          ...(response.provider === undefined ? {} : { provider: response.provider }),
          latencyMs: response.latencyMs,
          attempts,
          repairs,
          schemaId: request.schemaId,
        };
      }

      if (repairs === 0) {
        repairs += 1;
        input = appendValidationErrors(request.input, validation.errors, request.schemaId);
        continue;
      }

      throw new SchemaViolation(request.schemaId, validation.errors);
    }
  } catch (error) {
    // Every terminal LlmError reports the usage of all charged attempts so the
    // caller (intake -> agent_run) persists the full billable total.
    if (error instanceof LlmError) error.usage = { ...totalUsage } as LlmUsage;
    throw error;
  }
}
