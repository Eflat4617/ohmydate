import { BudgetExceeded } from './errors.js';
import type { LlmPricingPerMillion } from './openai-compatible-llm.js';

/**
 * FU-52R spend ledger contract (§H3/H4/H5). Production uses the PostgreSQL
 * `llm_spend` table with a per-owner advisory lock; tests use the in-memory
 * implementation below. Reservations are conservative: the estimate is
 * `ceil(inputChars/3)` prompt tokens plus the configured max output tokens.
 *
 * A settled row always keeps its actual charge. A timed-out or unpriced attempt
 * settles at the reserved amount so a failed paid call is never free.
 */

export interface LlmSpendReserveInput {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly estimateUsd: number;
  readonly dailyLimitUsd: number;
  readonly monthlyLimitUsd: number;
  /** Inclusive UTC day start, e.g. `2026-11-11T00:00:00.000Z`. */
  readonly dayStart: string;
  /** Inclusive UTC month start, e.g. `2026-11-01T00:00:00.000Z`. */
  readonly monthStart: string;
}

export interface LlmSpendSettleInput {
  readonly id: string;
  readonly actualUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly settledAt: string;
  readonly dayStart: string;
  readonly monthStart: string;
}

export interface LlmSpendTotals {
  readonly dayUsd: number;
  readonly monthUsd: number;
}

export interface LlmSpendLedger {
  /** Atomically reserve against the owner's day/month caps; throws before network. */
  reserve(input: LlmSpendReserveInput): Promise<void>;
  /** Settle the reservation, returning post-settlement totals for overrun checks. */
  settle(input: LlmSpendSettleInput): Promise<LlmSpendTotals>;
}

export interface LlmSpendRow {
  readonly id: string;
  readonly ownerId: string;
  readonly purpose: string;
  readonly state: 'reserved' | 'settled' | 'released';
  readonly reservedUsd: number;
  readonly actualUsd: number | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens: number;
  readonly createdAt: string;
  readonly settledAt: string | null;
}

/** `ceil(chars / 3)` is a conservative prompt-token estimate for mixed text. */
export function estimateInputTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 3));
}

/** Conservative cost bound for one attempt, including the max output allowance. */
export function estimateReservationUsd(
  inputChars: number,
  maxOutputTokens: number,
  pricing: LlmPricingPerMillion,
): number {
  const inputTokens = estimateInputTokensFromChars(inputChars);
  const outputTokens = Math.max(0, maxOutputTokens);
  return (
    (inputTokens * pricing.inputUsd + outputTokens * pricing.outputUsd) / 1_000_000
  );
}

function rowSpend(row: LlmSpendRow): number {
  return row.state === 'settled' ? (row.actualUsd ?? row.reservedUsd) : row.reservedUsd;
}

/** Deterministic in-memory ledger used by unit tests and fake compositions. */
export class InMemorySpendLedger implements LlmSpendLedger {
  readonly rows: LlmSpendRow[] = [];

  async reserve(input: LlmSpendReserveInput): Promise<void> {
    if (
      !Number.isFinite(input.estimateUsd) ||
      input.estimateUsd < 0 ||
      !Number.isFinite(input.dailyLimitUsd) ||
      input.dailyLimitUsd <= 0 ||
      !Number.isFinite(input.monthlyLimitUsd) ||
      input.monthlyLimitUsd <= 0
    ) {
      throw new BudgetExceeded('daily', input.dailyLimitUsd, 0, 'invalid_limit');
    }
    let day = 0;
    let month = 0;
    for (const row of this.rows) {
      if (row.ownerId !== input.ownerId || row.state === 'released') continue;
      if (row.createdAt < input.monthStart) continue;
      month += rowSpend(row);
      if (row.createdAt >= input.dayStart) day += rowSpend(row);
    }
    if (day + input.estimateUsd > input.dailyLimitUsd) {
      throw new BudgetExceeded('daily', input.dailyLimitUsd, day, 'projected_limit');
    }
    if (month + input.estimateUsd > input.monthlyLimitUsd) {
      throw new BudgetExceeded('monthly', input.monthlyLimitUsd, month, 'projected_limit');
    }
    this.rows.push({
      id: input.id,
      ownerId: input.ownerId,
      purpose: input.purpose,
      state: 'reserved',
      reservedUsd: input.estimateUsd,
      actualUsd: null,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      createdAt: input.dayStart,
      settledAt: null,
    });
  }

  async settle(input: LlmSpendSettleInput): Promise<LlmSpendTotals> {
    const row = this.rows.find((candidate) => candidate.id === input.id);
    if (row === undefined) return { dayUsd: 0, monthUsd: 0 };
    const index = this.rows.indexOf(row);
    this.rows[index] = {
      ...row,
      state: 'settled',
      actualUsd: Number.isFinite(input.actualUsd) && input.actualUsd >= 0
        ? input.actualUsd
        : row.reservedUsd,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cachedTokens: input.cachedTokens,
      settledAt: input.settledAt,
    };
    let day = 0;
    let month = 0;
    for (const entry of this.rows) {
      if (entry.ownerId !== row.ownerId || entry.state === 'released') continue;
      if (entry.createdAt < input.monthStart) continue;
      month += rowSpend(entry);
      if (entry.createdAt >= input.dayStart) day += rowSpend(entry);
    }
    return { dayUsd: day, monthUsd: month };
  }
}
