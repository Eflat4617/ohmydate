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

  constructor(
    readonly limits: Readonly<Partial<LlmBudget>>,
    init: BudgetGuardInit = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    const current = now();
    this.dayKey = init.dayKey ?? dayKeyOf(current);
    this.monthKey = init.monthKey ?? monthKeyOf(current);
    this.spentTodayUsd = init.spentTodayUsd ?? 0;
    this.spentThisMonthUsd = init.spentThisMonthUsd ?? 0;
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
    const estimate = Number.isFinite(estimatedCostUsd) ? Math.max(0, estimatedCostUsd) : 0;

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

  record(cost: number | LlmUsage | undefined): void {
    if (cost === undefined) return;
    const usd = typeof cost === 'number' ? cost : (cost.costUsd ?? 0);
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.rollover();
    this.spentTodayUsd += usd;
    this.spentThisMonthUsd += usd;
  }
}
