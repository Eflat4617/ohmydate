import { BudgetGuard } from './budget.js';
import { BudgetExceeded, LlmUnavailable } from './errors.js';
import type { LlmBudget, LlmCompleteRequest, LlmCompleteResponse, LlmPort } from './port.js';

/**
 * 05 §12 / ADR-022 access gate. The provider is only usable when the owner has
 * an explicit consent record for this provider id; without it the call fails as
 * `llm_unavailable`, which the intake flow already maps to manual mode.
 *
 * The owner's day/month ceilings come from `user.settings.llm.budget` with
 * conservative defaults; persisted spend is supplied by the composition root
 * (sum of priced `agent_run` rows). A missing/invalid consent or budget never
 * falls through to a paid call.
 */

export interface LlmConsentRecord {
  readonly granted: boolean;
  readonly at: string;
  readonly provider: string;
}

export interface ResolvedLlmAccess {
  readonly consent?: LlmConsentRecord | null;
  readonly budget?: LlmBudget | null;
  readonly spentTodayUsd: number;
  readonly spentThisMonthUsd: number;
}

export interface PolicyLlmOptions {
  readonly inner: LlmPort;
  /** Provider id this process is configured for (e.g. `deepseek`). */
  readonly providerId: string;
  readonly defaultBudget: LlmBudget;
  readonly resolve: (ownerId: string) => Promise<ResolvedLlmAccess | null>;
  readonly now?: () => Date;
}

function validLimit(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
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

    const configured = access?.budget;
    const limits: LlmBudget =
      validLimit(configured?.dailyUsd) && validLimit(configured?.monthlyUsd)
        ? { dailyUsd: configured.dailyUsd, monthlyUsd: configured.monthlyUsd }
        : this.#options.defaultBudget;

    const guard = new BudgetGuard(limits, {
      spentTodayUsd: access?.spentTodayUsd ?? 0,
      spentThisMonthUsd: access?.spentThisMonthUsd ?? 0,
    }, this.#now);
    guard.assertCanSpend(0);

    const response = await this.#options.inner.complete(request);
    guard.record(response.usage, { model: response.model });
    if (guard.isExhausted()) {
      throw new BudgetExceeded('daily', limits.dailyUsd, guard.snapshot().spentTodayUsd, 'unpriced_usage');
    }
    return { ...response, provider: this.#options.providerId };
  }
}
