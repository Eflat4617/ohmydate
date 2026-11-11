import {
  BudgetExceeded,
  DEFAULT_DEEPSEEK_PRICING,
  InMemorySpendLedger,
  LlmError,
  LlmUnavailable,
  PolicyLlm,
  estimateInputTokensFromChars,
  estimateInputTokensUpperBound,
  estimateReservationUsd,
  getPrompt,
  roundUpToMicroUsd,
  staleReservationThresholdMs,
  type LlmCompleteResponse,
  type LlmPort,
  type LlmSpendLedger,
  type LlmSpendReserveInput,
  type LlmSpendSettleInput,
  type LlmSpendTotals,
  type PolicyLlmOptions,
} from '../src/index.js';
import { STRICT_JSON_INSTRUCTION } from '../src/openai-compatible-llm.js';

const request = {
  promptId: 'type_detection',
  version: 'v1',
  input: { title: 'Write a report' },
  schemaId: 'llm.type_detection.v1',
} as const;

const consent = {
  granted: true,
  at: '2026-11-11T00:00:00.000Z',
  provider: 'deepseek',
};

const encoder = new TextEncoder();

function makePolicy(
  inner: LlmPort,
  ledger: LlmSpendLedger = new InMemorySpendLedger(),
  overrides: Partial<PolicyLlmOptions> = {},
): { llm: PolicyLlm; ledger: LlmSpendLedger } {
  let seq = 0;
  const llm = new PolicyLlm({
    inner,
    providerId: 'deepseek',
    defaultBudget: { dailyUsd: 0.2, monthlyUsd: 5 },
    resolve: async () => ({ consent, budget: { dailyUsd: 0.2, monthlyUsd: 5 } }),
    ledger,
    pricing: DEFAULT_DEEPSEEK_PRICING,
    maxOutputTokens: 2000,
    newReservationId: () => `res-${++seq}`,
    now: () => new Date('2026-11-11T12:00:00.000Z'),
    ...overrides,
  });
  return { llm, ledger };
}

function stubResponse(costUsd = 0.001): LlmCompleteResponse {
  return {
    output: { classification: 'new' },
    usage: { inputTokens: 10, outputTokens: 5, costUsd },
    model: 'deepseek-v4.1-flash',
    latencyMs: 1,
  };
}

describe('reservation input upper bound', () => {
  test('UTF-8 byte length + fixed overhead bounds ASCII, Korean, emoji/astral and mixed', () => {
    const samples = [
      'plain ascii title',
      '한국어 제목과 설명입니다',
      '🙂🚀👨‍👩‍👧‍👦',
      'mixed 한글 🙂 ascii 🚀',
    ];
    for (const sample of samples) {
      const upper = estimateInputTokensUpperBound(sample, sample);
      const expected =
        encoder.encode(sample).length * 2 +
        encoder.encode(STRICT_JSON_INSTRUCTION).length +
        16 * 2 +
        64;
      expect({ sample, upper }).toEqual({ sample, upper: expected });
      // The old average estimate is strictly lower for non-ASCII input; the
      // byte bound must never fall back to it.
      expect(upper).toBeGreaterThan(
        estimateInputTokensFromChars(sample.length * 2 + STRICT_JSON_INSTRUCTION.length),
      );
    }
  });

  test('reservations round UP to the next micro-dollar', () => {
    const tiny = estimateReservationUsd(1, 0, {
      inputUsd: DEFAULT_DEEPSEEK_PRICING.inputUsd,
      outputUsd: 0,
      cachedInputUsd: 0,
    });
    expect(tiny).toBe(0.000001);
    expect(roundUpToMicroUsd(1.0000001e-6)).toBe(0.000002);
    expect(roundUpToMicroUsd(0.000001)).toBe(0.000001);
    expect(roundUpToMicroUsd(0)).toBe(0);
    const reservation = estimateReservationUsd(24600, 2000, DEFAULT_DEEPSEEK_PRICING);
    expect(Number.isInteger(Math.round(reservation * 1_000_000))).toBe(true);
    expect(reservation * 1_000_000).toBeGreaterThanOrEqual(
      24600 * DEFAULT_DEEPSEEK_PRICING.inputUsd +
        2000 * DEFAULT_DEEPSEEK_PRICING.outputUsd -
        0.5,
    );
  });

  test('stale threshold is request timeout x (retries + 1) + margin', () => {
    expect(staleReservationThresholdMs(30_000, 2, 60_000)).toBe(150_000);
    expect(staleReservationThresholdMs(1_000, 0, 0)).toBe(1_000);
  });
});

describe('concurrent schema-sized Korean input cannot exceed the owner cap', () => {
  test('20 concurrent calls against $0.035 dispatch only bounded reservations', async () => {
    const koreanInput = {
      title: '가'.repeat(200),
      description: '나'.repeat(4000),
      deliverable: '다'.repeat(2000),
      prerequisites: '라'.repeat(2000),
    };
    const simulatedUsage = { inputTokens: 8200, outputTokens: 2000 };
    const simulatedCost =
      (simulatedUsage.inputTokens * DEFAULT_DEEPSEEK_PRICING.inputUsd +
        simulatedUsage.outputTokens * DEFAULT_DEEPSEEK_PRICING.outputUsd) /
      1_000_000;
    let dispatched = 0;
    const inner: LlmPort = {
      complete: async () => {
        dispatched += 1;
        return {
          output: { classification: 'new' },
          usage: { ...simulatedUsage, costUsd: simulatedCost },
          model: 'deepseek-v4.1-flash',
          latencyMs: 1,
        };
      },
    };
    const ledger = new InMemorySpendLedger();
    const cap = 0.035;
    const llm = new PolicyLlm({
      inner,
      providerId: 'deepseek',
      defaultBudget: { dailyUsd: cap, monthlyUsd: 5 },
      resolve: async () => ({ consent, budget: { dailyUsd: cap, monthlyUsd: 5 } }),
      ledger,
      pricing: DEFAULT_DEEPSEEK_PRICING,
      maxOutputTokens: 2000,
      newReservationId: (() => {
        let seq = 0;
        return () => `korean-${++seq}`;
      })(),
      now: () => new Date('2026-11-11T12:00:00.000Z'),
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        llm.complete({ ...request, input: koreanInput, ownerId: 'owner-1' }),
      ),
    );

    expect(dispatched).toBeGreaterThan(0);
    expect(dispatched).toBeLessThan(20);
    expect(results.filter((entry) => entry.status === 'rejected')).toHaveLength(
      20 - dispatched,
    );
    for (const rejected of results) {
      if (rejected.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(BudgetExceeded);
      }
    }
    // Worst case for the dispatched calls is their reservation total, which the
    // ledger never lets exceed the cap; actual simulated spend is lower still.
    const reservedTotal = ledger.rows.reduce((sum, row) => sum + row.reservedUsd, 0);
    expect(reservedTotal).toBeLessThanOrEqual(cap);
    expect(dispatched * simulatedCost).toBeLessThanOrEqual(cap);
    for (const row of ledger.rows) {
      expect(row.reservedUsd).toBeGreaterThanOrEqual(row.actualUsd ?? 0);
    }
    // 8200 prompt tokens is above the old chars/3 estimate for this input.
    const system = getPrompt('type_detection', 'v1');
    const user = JSON.stringify(koreanInput);
    expect(estimateInputTokensUpperBound(system, user)).toBeGreaterThan(8200);
    expect(dispatched).toBeLessThanOrEqual(
      Math.floor(cap / (estimateReservationUsd(
        estimateInputTokensUpperBound(system, user),
        2000,
        DEFAULT_DEEPSEEK_PRICING,
      ))),
    );
  });
});

class FlakySettlementLedger implements LlmSpendLedger {
  settleAttempts = 0;

  constructor(
    private readonly inner: InMemorySpendLedger,
    private readonly failures: number,
  ) {}

  reserve(input: LlmSpendReserveInput): Promise<void> {
    return this.inner.reserve(input);
  }

  async settle(input: LlmSpendSettleInput): Promise<LlmSpendTotals> {
    this.settleAttempts += 1;
    if (this.settleAttempts <= this.failures) {
      throw new Error('simulated settlement database failure');
    }
    return this.inner.settle(input);
  }
}

describe('stale reservation recovery', () => {
  test('crash-before-dispatch: a reserved row is recovered at the reserved amount on the next reservation', async () => {
    const base = new Date('2026-11-11T12:00:00.000Z');
    const ledger = new InMemorySpendLedger();
    await ledger.reserve({
      id: 'crashed',
      ownerId: 'owner-1',
      purpose: 'type_detection@v1',
      estimateUsd: 0.1,
      dailyLimitUsd: 1,
      monthlyLimitUsd: 5,
      dayStart: '2026-11-11T00:00:00.000Z',
      monthStart: '2026-11-01T00:00:00.000Z',
      createdAt: base.toISOString(),
      staleAfterMs: 1_000,
    });
    expect(ledger.rows[0]).toMatchObject({ state: 'reserved', settleReason: null });

    const { llm } = makePolicy(
      { complete: async () => stubResponse() },
      ledger,
      {
        resolve: async () => ({ consent, budget: { dailyUsd: 1, monthlyUsd: 5 } }),
        now: () => new Date(base.getTime() + 2_000),
        staleAfterMs: 1_000,
      },
    );
    await llm.complete({ ...request, ownerId: 'owner-1' });

    expect(ledger.rows[0]).toMatchObject({
      id: 'crashed',
      state: 'settled',
      actualUsd: 0.1,
      settleReason: 'recovered',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  test('abort mid-call settles at the reservation, retrying transient settlement failures', async () => {
    const inner = new InMemorySpendLedger();
    const ledger = new FlakySettlementLedger(inner, 2);
    const sleep = vi.fn(async () => {});
    let settleCalls = 0;
    const counting: LlmSpendLedger = {
      reserve: (input) => ledger.reserve(input),
      settle: (input) => {
        settleCalls += 1;
        return ledger.settle(input);
      },
    };
    const { llm } = makePolicy(
      {
        complete: async () => {
          throw new LlmUnavailable('llm call aborted by caller', 'aborted', false);
        },
      },
      counting,
      {
        resolve: async () => ({ consent, budget: { dailyUsd: 1, monthlyUsd: 5 } }),
        settlementRetries: 2,
        settlementBackoffMs: 5,
        sleep,
      },
    );

    let error: unknown;
    try {
      await llm.complete({ ...request, ownerId: 'owner-1' });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(settleCalls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(inner.rows[0]).toMatchObject({
      state: 'settled',
      settleReason: 'reserved_fallback',
      actualUsd: inner.rows[0]?.reservedUsd,
    });
    expect((error as LlmError).usage?.costUsd).toBe(inner.rows[0]?.reservedUsd);
  });

  test('permanent settlement failure leaves the row reserved for later recovery', async () => {
    const inner = new InMemorySpendLedger();
    const ledger = new FlakySettlementLedger(inner, Number.MAX_SAFE_INTEGER);
    const { llm } = makePolicy(
      {
        complete: async () => {
          throw new LlmUnavailable('transport failed', 'provider', false);
        },
      },
      ledger,
      {
        resolve: async () => ({ consent, budget: { dailyUsd: 1, monthlyUsd: 5 } }),
        settlementRetries: 1,
        settlementBackoffMs: 1,
        sleep: async () => {},
      },
    );

    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    expect(ledger.settleAttempts).toBe(2);
    expect(inner.rows[0]).toMatchObject({ state: 'reserved', settleReason: null });

    // A later on-demand reservation recovers the abandoned row even though the
    // regular settlement path is still failing.
    const later = new Date('2026-11-11T13:00:00.000Z');
    await inner.reserve({
      id: 'fresh',
      ownerId: 'owner-1',
      purpose: 'type_detection@v1',
      estimateUsd: 0.001,
      dailyLimitUsd: 1,
      monthlyLimitUsd: 5,
      dayStart: '2026-11-11T00:00:00.000Z',
      monthStart: '2026-11-01T00:00:00.000Z',
      createdAt: later.toISOString(),
      staleAfterMs: 1_000,
    });
    expect(inner.rows[0]).toMatchObject({
      state: 'settled',
      settleReason: 'recovered',
      actualUsd: inner.rows[0]?.reservedUsd,
    });
  });

  test('an intact settlement is recorded with reason=actual', async () => {
    const inner = new InMemorySpendLedger();
    const { llm } = makePolicy(
      { complete: async () => stubResponse() },
      inner,
      { resolve: async () => ({ consent, budget: { dailyUsd: 1, monthlyUsd: 5 } }) },
    );
    await llm.complete({ ...request, ownerId: 'owner-1' });
    expect(inner.rows[0]).toMatchObject({
      state: 'settled',
      settleReason: 'actual',
      actualUsd: 0.001,
    });
  });
});
