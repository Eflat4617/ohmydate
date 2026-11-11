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
}

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

function callWithTimeout(
  port: LlmPort,
  request: Parameters<LlmPort['complete']>[0],
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<LlmCompleteResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeOuterListener: (() => void) | undefined;

  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abortWith = (reason: Error): void => {
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

  const call = port.complete({ ...request, signal: controller.signal });
  return Promise.race([call, abortPromise]).finally(() => {
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
            ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
            ...(forwardTimeout ? { timeoutMs } : {}),
          },
          timeoutMs,
          options.signal,
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
