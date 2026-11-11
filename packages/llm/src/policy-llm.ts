import { BudgetExceeded, LlmError, LlmUnavailable } from './errors.js';
import type { LlmPricingPerMillion } from './openai-compatible-llm.js';
import type { LlmBudget, LlmCompleteRequest, LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';
import { getPrompt } from './prompt-registry.js';
import {
  estimateReservationUsd,
  type LlmSpendLedger,
  type LlmSpendTotals,
} from './spend-ledger.js';

/**
 * 05 §12 / ADR-022 access gate. The provider is only usable when the owner has
 * an explicit consent record for this provider id; without it the call fails as
 * `llm_unavailable`, which the intake flow already maps to manual mode.
 *
 * Budget semantics (FU-52R H2/H3):
 * - no saved budget -> conservative config defaults
 * - saved `{dailyUsd: 0}` (or monthly 0) -> disabled, no outbound call
 * - saved invalid/partial values -> fail closed, never substitute defaults
 * - every provider attempt reserves atomically in the ledger before any network
 *   call and settles with actual usage (or the reservation on timeout/unpriced)
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

export class PolicyLlm implements LlmPort {
  readonly #options: PolicyLlmOptions;
  readonly #now: () => Date;

  constructor(options: PolicyLlmOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
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

    const system = getPrompt(request.promptId, request.version);
    const user = JSON.stringify(request.input ?? {}) ?? '{}';
    const estimateUsd = estimateReservationUsd(
      system.length + user.length,
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
    });

    let settled = false;
    const settle = async (
      actualUsd: number,
      usage: LlmUsage,
    ): Promise<LlmSpendTotals> => {
      settled = true;
      return this.#options.ledger.settle({
        id: reservationId,
        actualUsd,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedTokens: usage.cachedInputTokens ?? 0,
        settledAt: nowIso,
        dayStart,
        monthStart,
      });
    };

    try {
      const response = await this.#options.inner.complete(request);
      const usage = response.usage;
      const actualUsd = usage.costUsd;
      if (actualUsd === undefined || !Number.isFinite(actualUsd) || actualUsd < 0) {
        await settle(estimateUsd, { ...usage, costUsd: estimateUsd });
        const error = new BudgetExceeded('daily', limits.dailyUsd, 0, 'unpriced_usage');
        attachUsage(error, { ...usage, costUsd: estimateUsd });
        throw error;
      }

      const totals = await settle(actualUsd, usage);
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
    } catch (error) {
      if (!settled) {
        const reservedUsage: LlmUsage = { inputTokens: 0, outputTokens: 0, costUsd: estimateUsd };
        try {
          await settle(estimateUsd, reservedUsage);
        } catch {
          // Leave the open reservation in place; it keeps future calls blocked.
        }
        attachUsage(error, reservedUsage);
      }
      throw error;
    }
  }
}

function validDefaults(value: LlmBudget): LlmBudget {
  if (!validLimit(value.dailyUsd) || !validLimit(value.monthlyUsd)) {
    throw new BudgetExceeded('daily', value.dailyUsd, 0, 'invalid_limit');
  }
  return { dailyUsd: value.dailyUsd, monthlyUsd: value.monthlyUsd };
}
