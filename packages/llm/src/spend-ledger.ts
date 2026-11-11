import { BudgetExceeded } from './errors.js';
import type { LlmPricingPerMillion } from './openai-compatible-llm.js';
import { STRICT_JSON_INSTRUCTION } from './structured-messages.js';

/**
 * FU-52c spend ledger contract (§H3/H4/H5/S1/S2). Production uses the
 * PostgreSQL `llm_spend` table with a per-owner advisory lock; tests use the
 * in-memory implementation below.
 *
 * A reservation is an UPPER BOUND for the whole outbound request, never an
 * average estimate: the UTF-8 byte length of the serialized system + user
 * messages (untrusted blocks included) plus the JSON-mode fallback instruction,
 * plus a fixed per-message/request overhead. One BPE token always covers at
 * least one byte, so byte length is a safe token upper bound.
 *
 * A settled row always keeps its charge. A timed-out, aborted or unpriced
 * attempt settles at the reserved amount (`reserved_fallback`); a reservation
 * left behind by a crash is settled at the reserved amount by the on-demand
 * stale recovery (`recovered`) so potentially billable work is never released.
 */

export type LlmSpendSettleReason = 'actual' | 'reserved_fallback' | 'recovered';

/** Adapter default request timeout (05 §8). Kept here so the policy can age rows. */
export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 30_000;
/** Adapter default retries after the first attempt for 429/5xx (05 §8). */
export const DEFAULT_LLM_MAX_RETRIES = 2;
/** Extra grace after the slowest possible attempt chain before recovery. */
export const DEFAULT_STALE_RESERVATION_MARGIN_MS = 60_000;
/**
 * Attempt chains one adapter call may run: the JSON-mode request plus the
 * single strict-instruction fallback, each with its own 429/5xx retries.
 */
export const LLM_ATTEMPT_CHAINS_WITH_FALLBACK = 2;

/**
 * Single attempt-chain formula: `requestTimeout x (retries + 1) + margin`.
 * It does not cover the JSON-mode fallback; reservation recovery uses
 * `staleReservationThresholdWithFallbackMs` (FU-54).
 */
export function staleReservationThresholdMs(
  requestTimeoutMs: number = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  retries: number = DEFAULT_LLM_MAX_RETRIES,
  marginMs: number = DEFAULT_STALE_RESERVATION_MARGIN_MS,
): number {
  return (
    Math.max(0, requestTimeoutMs) * (Math.max(0, retries) + 1) +
    Math.max(0, marginMs)
  );
}

/**
 * FU-54: age after which an open reservation is certainly abandoned, counting
 * the JSON-mode fallback. One `OpenAICompatibleLlm.complete` call may run the
 * JSON-mode chain and then the fallback chain, each `requestTimeout x
 * (retries + 1)`, so the threshold is
 * `requestTimeout x (retries + 1) x 2 + margin`. The policy never relies on a
 * caller (runStructured) capping the adapter below that.
 */
export function staleReservationThresholdWithFallbackMs(
  requestTimeoutMs: number = DEFAULT_LLM_REQUEST_TIMEOUT_MS,
  retries: number = DEFAULT_LLM_MAX_RETRIES,
  marginMs: number = DEFAULT_STALE_RESERVATION_MARGIN_MS,
): number {
  return (
    staleReservationThresholdMs(requestTimeoutMs, retries, 0) * LLM_ATTEMPT_CHAINS_WITH_FALLBACK +
    Math.max(0, marginMs)
  );
}

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
  /** Reservation creation instant (injected clock, ISO). */
  readonly createdAt: string;
  /** Open rows older than this are settled at their reserved amount first. */
  readonly staleAfterMs: number;
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
  /** Defaults to `actual`; failure paths use `reserved_fallback`. */
  readonly reason?: LlmSpendSettleReason;
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
  readonly settleReason: LlmSpendSettleReason | null;
}

const MESSAGE_OVERHEAD_TOKENS = 16;
const REQUEST_OVERHEAD_TOKENS = 64;
const MESSAGES_PER_REQUEST = 2;
const encoder = new TextEncoder();

/**
 * `ceil(chars / 3)` is only an average estimate; kept for callers that need a
 * rough number, never for reservations (see `estimateInputTokensUpperBound`).
 */
export function estimateInputTokensFromChars(chars: number): number {
  return Math.max(1, Math.ceil(Math.max(0, chars) / 3));
}

/**
 * Defensive prompt-token upper bound for the exact messages the adapter sends:
 * system prompt + serialized user input (untrusted blocks included) + the
 * JSON-mode fallback instruction. Bytes cover every BPE token; the fixed
 * overhead covers chat framing. Never lower this to a chars/N average.
 */
export function estimateInputTokensUpperBound(system: string, user: string): number {
  const bytes =
    encoder.encode(system).length +
    encoder.encode(user).length +
    encoder.encode(STRICT_JSON_INSTRUCTION).length;
  return Math.max(
    1,
    bytes + MESSAGE_OVERHEAD_TOKENS * MESSAGES_PER_REQUEST + REQUEST_OVERHEAD_TOKENS,
  );
}

/** Round a dollar amount UP to the next micro-dollar (never under-reserve). */
export function roundUpToMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.ceil(usd * 1_000_000 - 1e-9) / 1_000_000;
}

/** Conservative cost bound for one attempt, including the max output allowance. */
export function estimateReservationUsd(
  inputTokens: number,
  maxOutputTokens: number,
  pricing: LlmPricingPerMillion,
): number {
  const promptTokens = Math.max(0, inputTokens);
  const outputTokens = Math.max(0, maxOutputTokens);
  const usd =
    (promptTokens * pricing.inputUsd + outputTokens * pricing.outputUsd) / 1_000_000;
  return roundUpToMicroUsd(usd);
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
    this.#recoverStale(input);
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
      createdAt: input.createdAt,
      settledAt: null,
      settleReason: null,
    });
  }

  async settle(input: LlmSpendSettleInput): Promise<LlmSpendTotals> {
    const row = this.rows.find((candidate) => candidate.id === input.id);
    if (row === undefined) return { dayUsd: 0, monthUsd: 0 };
    const index = this.rows.indexOf(row);
    if (row.state === 'reserved') {
      this.rows[index] = {
        ...row,
        state: 'settled',
        actualUsd:
          Number.isFinite(input.actualUsd) && input.actualUsd >= 0
            ? input.actualUsd
            : row.reservedUsd,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        cachedTokens: input.cachedTokens,
        settledAt: input.settledAt,
        settleReason: input.reason ?? 'actual',
      };
    }
    return this.#totals(row.ownerId, input.dayStart, input.monthStart);
  }

  /** On-demand recovery: settle abandoned reservations at their reserved amount. */
  #recoverStale(input: LlmSpendReserveInput): void {
    const cutoff = Date.parse(input.createdAt) - input.staleAfterMs;
    if (!Number.isFinite(cutoff)) return;
    for (const row of this.rows) {
      if (
        row.ownerId !== input.ownerId ||
        row.state !== 'reserved' ||
        Date.parse(row.createdAt) >= cutoff
      ) {
        continue;
      }
      const index = this.rows.indexOf(row);
      this.rows[index] = {
        ...row,
        state: 'settled',
        actualUsd: row.reservedUsd,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        settledAt: input.createdAt,
        settleReason: 'recovered',
      };
    }
  }

  #totals(ownerId: string, dayStart: string, monthStart: string): LlmSpendTotals {
    let day = 0;
    let month = 0;
    for (const entry of this.rows) {
      if (entry.ownerId !== ownerId || entry.state === 'released') continue;
      if (entry.createdAt < monthStart) continue;
      month += rowSpend(entry);
      if (entry.createdAt >= dayStart) day += rowSpend(entry);
    }
    return { dayUsd: day, monthUsd: month };
  }
}
