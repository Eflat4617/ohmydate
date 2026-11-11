/**
 * Per-prompt call limits (M6-01 fix round 1 addendum).
 *
 * Live decomposition answers are long (reasoning tokens count against
 * `max_tokens`) and slow (20-95 s), so one global 2000-token / 30 s limit truncates
 * them. Limits are resolved per prompt id:
 *
 * - `runStructured` uses the prompt's `timeoutMs` for its own per-call timer (an
 *   explicit `options.timeoutMs` still wins) and forwards `maxOutputTokens` and
 *   `timeoutMs` on the port request;
 * - `PolicyLlm` reserves spend with the per-call `maxOutputTokens`;
 * - `OpenAICompatibleLlm` sends it as `max_tokens` and uses `timeoutMs` per attempt.
 *
 * Prompts without an override keep the adapter/policy configuration and the
 * historical 30 s runStructured default (type_detection keeps its values).
 */

export interface PromptLimits {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

/** Overrides keyed by prompt id (all versions of the prompt share them). */
export type PromptLimitOverrides = Readonly<Record<string, PromptLimits>>;

export const DEFAULT_DECOMPOSITION_MAX_OUTPUT_TOKENS = 8_000;
export const DEFAULT_DECOMPOSITION_TIMEOUT_MS = 120_000;
/** runStructured's per-call timer for prompts without an override (05 §8). */
export const DEFAULT_STRUCTURED_TIMEOUT_MS = 30_000;
/** Hard ceiling for any per-call output bound; keeps a bad value from reserving unbounded spend. */
export const MAX_OUTPUT_TOKENS_CEILING = 32_768;

export const DEFAULT_PROMPT_LIMIT_OVERRIDES: PromptLimitOverrides = Object.freeze({
  decomposition: Object.freeze({
    maxOutputTokens: DEFAULT_DECOMPOSITION_MAX_OUTPUT_TOKENS,
    timeoutMs: DEFAULT_DECOMPOSITION_TIMEOUT_MS,
  }),
});

function assertLimits(promptId: string, limits: PromptLimits): PromptLimits {
  if (
    !Number.isInteger(limits.maxOutputTokens) ||
    limits.maxOutputTokens <= 0 ||
    limits.maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING
  ) {
    throw new RangeError(
      `maxOutputTokens for ${promptId} must be an integer in 1..${MAX_OUTPUT_TOKENS_CEILING}`,
    );
  }
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs <= 0) {
    throw new RangeError(`timeoutMs for ${promptId} must be a positive integer`);
  }
  return limits;
}

/** The override for `promptId`, validated, or undefined when the prompt has none. */
export function promptLimitsFor(
  promptId: string,
  overrides: PromptLimitOverrides = DEFAULT_PROMPT_LIMIT_OVERRIDES,
): PromptLimits | undefined {
  if (!Object.hasOwn(overrides, promptId)) return undefined;
  return assertLimits(promptId, overrides[promptId] as PromptLimits);
}

/** Longest per-call timeout across overrides (for stale-reservation recovery). */
export function maxPromptTimeoutMs(
  overrides: PromptLimitOverrides = DEFAULT_PROMPT_LIMIT_OVERRIDES,
  floorMs: number = DEFAULT_STRUCTURED_TIMEOUT_MS,
): number {
  return Object.entries(overrides).reduce(
    (max, [promptId, limits]) => Math.max(max, assertLimits(promptId, limits).timeoutMs),
    floorMs,
  );
}

/**
 * The output bound actually used for one call: the request's per-call value when it
 * is a valid integer within the ceiling, otherwise the configured fallback. Policy
 * (reservation) and adapter (`max_tokens`) call this with the same inputs, so the
 * reservation always covers what is requested.
 */
export function effectiveMaxOutputTokens(requested: number | undefined, fallback: number): number {
  if (
    requested !== undefined &&
    Number.isInteger(requested) &&
    requested > 0 &&
    requested <= MAX_OUTPUT_TOKENS_CEILING
  ) {
    return requested;
  }
  return fallback;
}
