import { BudgetExceeded } from './errors.js';
import type { LlmBudget, LlmUsage } from './port.js';

export interface BudgetSnapshot {
  readonly dayKey: string;
  readonly monthKey: string;
  readonly spentTodayUsd: number;
  readonly spentThisMonthUsd: number;
}

export interface BudgetGuardInit {
  readonly spentTodayUsd?: number;
  readonly spentThisMonthUsd?: number;
  readonly dayKey?: string;
  readonly monthKey?: string;
  /**
   * Exact model names allowed to omit `costUsd`. Tests opt in with `['fake-llm']`;
   * production guards must leave this empty so an unpriced real response fails closed.
   */
  readonly allowUnpricedModels?: readonly string[];
}

export interface BudgetRecordOptions {
  /** Provider model name used for the exact unpriced-model allow-list match. */
  readonly model?: string;
}

function assertValidInitSpend(kind: string, value: number | undefined): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new RangeError(`budget ${kind} spend must be finite and non-negative`);
  }
}

function normalizeUnpricedModels(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('allowUnpricedModels must be an array of model-name strings');
  }
  return value;
}

function dayKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKeyOf(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function requireLimit(kind: 'daily' | 'monthly', value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new BudgetExceeded(kind, value ?? Number.NaN, 0, 'invalid_limit');
  }
  return value;
}

/**
 * Daily/monthly USD budget consulted before every LLM call (05 §8, ADR-008).
 * Fail-closed: both limits must be present, finite and positive. Time is injected so
 * billing-period rollover is deterministic in tests.
 */
export class BudgetGuard {
  private spentTodayUsd: number;
  private spentThisMonthUsd: number;
  private dayKey: string;
  private monthKey: string;
  private exhausted = false;
  private readonly unpricedModels: ReadonlySet<string>;

  constructor(
    readonly limits: Readonly<Partial<LlmBudget>>,
    init: BudgetGuardInit = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    const current = now();
    assertValidInitSpend('daily', init.spentTodayUsd);
    assertValidInitSpend('monthly', init.spentThisMonthUsd);
    this.dayKey = init.dayKey ?? dayKeyOf(current);
    this.monthKey = init.monthKey ?? monthKeyOf(current);
    this.spentTodayUsd = init.spentTodayUsd ?? 0;
    this.spentThisMonthUsd = init.spentThisMonthUsd ?? 0;
    this.unpricedModels = new Set(normalizeUnpricedModels(init.allowUnpricedModels));
  }

  private rollover(): void {
    const current = this.now();
    const day = dayKeyOf(current);
    const month = monthKeyOf(current);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.spentTodayUsd = 0;
    }
    if (month !== this.monthKey) {
      this.monthKey = month;
      this.spentThisMonthUsd = 0;
    }
  }

  snapshot(): BudgetSnapshot {
    this.rollover();
    return {
      dayKey: this.dayKey,
      monthKey: this.monthKey,
      spentTodayUsd: this.spentTodayUsd,
      spentThisMonthUsd: this.spentThisMonthUsd,
    };
  }

  /**
   * Throws `BudgetExceeded` unless a call is allowed. The default estimate is zero, but
   * an already-reached ceiling still blocks: `spent >= limit` never passes.
   */
  assertCanSpend(estimatedCostUsd = 0): void {
    this.rollover();
    const dailyLimit = requireLimit('daily', this.limits.dailyUsd);
    const monthlyLimit = requireLimit('monthly', this.limits.monthlyUsd);
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) {
      throw new BudgetExceeded('daily', dailyLimit, this.spentTodayUsd, 'invalid_estimate');
    }
    const estimate = estimatedCostUsd;
    if (this.exhausted) {
      throw new BudgetExceeded('daily', dailyLimit, this.spentTodayUsd, 'unpriced_usage');
    }

    if (this.spentTodayUsd >= dailyLimit) {
      throw new BudgetExceeded('daily', dailyLimit, this.spentTodayUsd, 'limit_reached');
    }
    if (this.spentThisMonthUsd >= monthlyLimit) {
      throw new BudgetExceeded('monthly', monthlyLimit, this.spentThisMonthUsd, 'limit_reached');
    }
    if (this.spentTodayUsd + estimate > dailyLimit) {
      throw new BudgetExceeded('daily', dailyLimit, this.spentTodayUsd, 'projected_limit');
    }
    if (this.spentThisMonthUsd + estimate > monthlyLimit) {
      throw new BudgetExceeded(
        'monthly',
        monthlyLimit,
        this.spentThisMonthUsd,
        'projected_limit',
      );
    }
  }

  /**
   * Record usage. A missing cost is exempt only for an exact unpriced-allow-list model;
   * a non-finite or negative cost always exhausts the guard (fail closed). Recovering
   * from exhaustion requires constructing a new guard; rollover does not reset the flag.
   */
  record(cost: number | LlmUsage | undefined, options: BudgetRecordOptions = {}): void {
    const usd = typeof cost === 'number' ? cost : cost?.costUsd;
    const unpricedAllowed = options.model !== undefined && this.unpricedModels.has(options.model);

    if (usd === undefined) {
      if (!unpricedAllowed) this.exhausted = true;
      return;
    }
    if (!Number.isFinite(usd) || usd < 0) {
      this.exhausted = true;
      return;
    }
    if (usd === 0) return;
    this.rollover();
    this.spentTodayUsd += usd;
    this.spentThisMonthUsd += usd;
  }

  /** True once an unpriced/non-finite real-model usage forced fail-closed behaviour. */
  isExhausted(): boolean {
    return this.exhausted;
  }
}
