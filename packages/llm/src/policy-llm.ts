import { BudgetExceeded, LlmError, LlmUnavailable } from './errors.js';
import type { LlmPricingPerMillion } from './openai-compatible-llm.js';
import type { LlmBudget, LlmCompleteRequest, LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';
import { getPrompt } from './prompt-registry.js';
import {
  estimateInputTokensUpperBound,
  estimateReservationUsd,
  staleReservationThresholdMs,
  type LlmSpendLedger,
  type LlmSpendSettleReason,
  type LlmSpendTotals,
} from './spend-ledger.js';

/**
 * 05 §12 / ADR-022 access gate. The provider is only usable when the owner has
 * an explicit consent record for this provider id; without it the call fails as
 * `llm_unavailable`, which the intake flow already maps to manual mode.
 *
 * Budget semantics (FU-52R H2/H3, FU-52c S1/S2):
 * - no saved budget -> conservative config defaults
 * - saved `{dailyUsd: 0}` (or monthly 0) -> disabled, no outbound call
 * - saved invalid/partial values -> fail closed, never substitute defaults
 * - every provider attempt reserves an UPPER BOUND of the full outbound prompt
 *   (UTF-8 bytes + fixed overhead) before any network call, then settles with
 *   actual usage (or the reservation on timeout/abort/unpriced)
 * - abandoned reservations are recovered on demand at reservation time and are
 *   never released, because the provider may already have billed them
 */

export interface LlmConsentRecord {
  readonly granted: boolean;
  readonly at: string;
  readonly provider: string;
}

export interface ResolvedLlmAccess {
  readonly consent?: LlmConsentRecord | null;
  /** `'invalid'` means the owner saved a malformed budget and must fail closed. */
  readonly budget?: LlmBudget | 'invalid' | null;
}

export interface PolicyLlmOptions {
  readonly inner: LlmPort;
  /** Provider id this process is configured for (e.g. `deepseek`). */
  readonly providerId: string;
  readonly defaultBudget: LlmBudget;
  readonly resolve: (ownerId: string) => Promise<ResolvedLlmAccess | null>;
  readonly ledger: LlmSpendLedger;
  readonly pricing: LlmPricingPerMillion;
  readonly maxOutputTokens: number;
  readonly newReservationId: () => string;
  readonly now?: () => Date;
  /** Age after which an open reservation is recovered (default timeout x (retries+1) + margin). */
  readonly staleAfterMs?: number;
  /** Bounded retries when the settlement write fails (default 2). */
  readonly settlementRetries?: number;
  /** Base backoff between settlement retries (default 50ms, doubled per retry). */
  readonly settlementBackoffMs?: number;
  /** Test seam for settlement backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function validLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function explicitLimits(value: LlmBudget | 'invalid'): LlmBudget {
  if (value === 'invalid') {
    throw new BudgetExceeded('daily', Number.NaN, 0, 'invalid_limit');
  }
  const { dailyUsd, monthlyUsd } = value;
  if (!Number.isFinite(dailyUsd) || !Number.isFinite(monthlyUsd) || dailyUsd < 0 || monthlyUsd < 0) {
    throw new BudgetExceeded('daily', dailyUsd, 0, 'invalid_limit');
  }
  if (dailyUsd === 0 || monthlyUsd === 0) {
    throw new BudgetExceeded(
      dailyUsd === 0 ? 'daily' : 'monthly',
      0,
      0,
      'limit_reached',
    );
  }
  return { dailyUsd, monthlyUsd };
}

function attachUsage(error: unknown, usage: LlmUsage): void {
  if (error instanceof LlmError) error.usage = usage;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class PolicyLlm implements LlmPort {
  readonly #options: PolicyLlmOptions;
  readonly #now: () => Date;
  readonly #staleAfterMs: number;
  readonly #settlementRetries: number;
  readonly #settlementBackoffMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: PolicyLlmOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
    this.#staleAfterMs = Math.max(0, options.staleAfterMs ?? staleReservationThresholdMs());
    this.#settlementRetries = Math.max(0, options.settlementRetries ?? 2);
    this.#settlementBackoffMs = Math.max(0, options.settlementBackoffMs ?? 50);
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    if (request.ownerId === undefined || request.ownerId.length === 0) {
      throw new LlmUnavailable('llm owner is required for consent and budget', 'provider', false);
    }
    const access = await this.#options.resolve(request.ownerId);
    const consent = access?.consent;
    if (
      consent === undefined ||
      consent === null ||
      consent.granted !== true ||
      consent.provider !== this.#options.providerId
    ) {
      throw new LlmUnavailable(
        'LLM consent is missing or revoked; using manual mode',
        'provider',
        false,
      );
    }

    const configured = access?.budget ?? null;
    const limits: LlmBudget =
      configured === null ? validDefaults(this.#options.defaultBudget) : explicitLimits(configured);

    // The adapter sends exactly these messages (plus the fallback instruction on
    // a JSON-mode rejection), so the reservation is an upper bound for dispatch.
    const system = getPrompt(request.promptId, request.version);
    const user = JSON.stringify(request.input ?? {}) ?? '{}';
    const estimateUsd = estimateReservationUsd(
      estimateInputTokensUpperBound(system, user),
      this.#options.maxOutputTokens,
      this.#options.pricing,
    );

    const now = this.#now();
    const nowIso = now.toISOString();
    const dayStart = `${nowIso.slice(0, 10)}T00:00:00.000Z`;
    const monthStart = `${nowIso.slice(0, 7)}-01T00:00:00.000Z`;
    const reservationId = this.#options.newReservationId();

    await this.#options.ledger.reserve({
      id: reservationId,
      ownerId: request.ownerId,
      purpose: `${request.promptId}@${request.version}`,
      estimateUsd,
      dailyLimitUsd: limits.dailyUsd,
      monthlyLimitUsd: limits.monthlyUsd,
      dayStart,
      monthStart,
      createdAt: nowIso,
      staleAfterMs: this.#staleAfterMs,
    });

    const settle = (
      actualUsd: number,
      usage: LlmUsage,
      reason: LlmSpendSettleReason,
    ): Promise<LlmSpendTotals | null> =>
      this.#settleWithRetry({
        id: reservationId,
        actualUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedInputTokens ?? 0,
        settledAt: nowIso,
        dayStart,
        monthStart,
        reason,
      });

    let response: LlmCompleteResponse;
    try {
      response = await this.#options.inner.complete(request);
    } catch (error) {
      // Aborted/timeout/transport failures may still have been billed: settle at
      // the reservation. If the write keeps failing the row stays reserved for
      // stale recovery, and the policy never pretends it was settled.
      const reservedUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, costUsd: estimateUsd };
      await settle(estimateUsd, reservedUsage, 'reserved_fallback');
      attachUsage(error, reservedUsage);
      throw error;
    }

    const usage = response.usage;
    const actualUsd = usage.costUsd;
    if (actualUsd === undefined || !Number.isFinite(actualUsd) || actualUsd < 0) {
      const reservedUsage: LlmUsage = { ...usage, costUsd: estimateUsd };
      await settle(estimateUsd, reservedUsage, 'reserved_fallback');
      const error = new BudgetExceeded('daily', limits.dailyUsd, 0, 'unpriced_usage');
      attachUsage(error, reservedUsage);
      throw error;
    }

    const totals = await settle(actualUsd, usage, 'actual');
    if (totals === null) {
      // The charge is already conservative (reserved upper bound); return the
      // paid result and let stale recovery settle the row later.
      return { ...response, provider: this.#options.providerId };
    }
    if (totals.dayUsd > limits.dailyUsd) {
      const error = new BudgetExceeded('daily', limits.dailyUsd, totals.dayUsd, 'limit_reached');
      attachUsage(error, usage);
      throw error;
    }
    if (totals.monthUsd > limits.monthlyUsd) {
      const error = new BudgetExceeded('monthly', limits.monthlyUsd, totals.monthUsd, 'limit_reached');
      attachUsage(error, usage);
      throw error;
    }
    return { ...response, provider: this.#options.providerId };
  }

  async #settleWithRetry(input: Parameters<LlmSpendLedger['settle']>[0]): Promise<LlmSpendTotals | null> {
    for (let attempt = 0; attempt <= this.#settlementRetries; attempt += 1) {
      try {
        return await this.#options.ledger.settle(input);
      } catch {
        if (attempt === this.#settlementRetries) return null;
        await this.#sleep(this.#settlementBackoffMs * 2 ** attempt);
      }
    }
    return null;
  }
}

function validDefaults(value: LlmBudget): LlmBudget {
  if (!validLimit(value.dailyUsd) || !validLimit(value.monthlyUsd)) {
    throw new BudgetExceeded('daily', value.dailyUsd, 0, 'invalid_limit');
  }
  return { dailyUsd: value.dailyUsd, monthlyUsd: value.monthlyUsd };
}
