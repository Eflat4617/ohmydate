/**
 * FU-54 / FU-76: a timeout or caller abort raced by runStructured must carry
 * the in-flight attempt's charge (agent_run cost == ledger), an abort before
 * dispatch must cost nothing, the policy bound and the adapter share one
 * message builder, the stale threshold counts the JSON-mode fallback, and the
 * total deadline bounds the whole attempt chain.
 */

import {
  DEFAULT_DEEPSEEK_PRICING,
  InMemorySpendLedger,
  LlmTimeoutError,
  LlmUnavailable,
  OpenAICompatibleLlm,
  PolicyLlm,
  STRICT_JSON_INSTRUCTION,
  buildStructuredMessages,
  estimateInputTokensUpperBound,
  exampleForSchema,
  runStructured,
  staleReservationThresholdMs,
  staleReservationThresholdWithFallbackMs,
  structuredContentBytes,
  structuredSystemPrompt,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
  type LlmSpendLedger,
  type LlmSpendReserveInput,
  type LlmSpendSettleInput,
  type LlmSpendTotals,
  type LlmUsage,
} from '../src/index.js';

const consent = { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } as const;
const NOW = new Date('2026-11-12T09:00:00.000Z');

const decomposition = {
  promptId: 'decomposition',
  version: 'v1',
  input: { task: { estimatedScope: 'medium' }, documents: ['<untrusted_document>보고서</untrusted_document>'] },
  schemaId: 'llm.decomposition.v1',
  ownerId: 'owner-1',
} as const;

/** Inner provider that hangs until its signal aborts, then rejects like the real adapter. */
class AbortablePort implements LlmPort {
  calls = 0;
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.calls += 1;
    return new Promise<LlmCompleteResponse>((_resolve, reject) => {
      const signal = request.signal;
      if (signal === undefined) return;
      const fail = (): void => reject(new LlmUnavailable('llm call aborted by caller', 'aborted', false));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  }
}

/** First call answers with an invalid payload (paid), later calls hang until aborted. */
class ChargedThenHangingPort extends AbortablePort {
  override async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    if (this.calls === 0) {
      this.calls += 1;
      return {
        output: { steps: 'not-an-array' },
        usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.00027 },
        model: 'deepseek-v4.1-flash',
        latencyMs: 5,
      };
    }
    return super.complete(request);
  }
}

/** Provider that ignores the abort and never settles (a transport that cannot be cancelled). */
class DeafPort implements LlmPort {
  async complete(): Promise<LlmCompleteResponse> {
    return new Promise<LlmCompleteResponse>(() => undefined);
  }
}

function policy(inner: LlmPort, ledger: LlmSpendLedger = new InMemorySpendLedger()): PolicyLlm {
  let seq = 0;
  return new PolicyLlm({
    inner,
    providerId: 'deepseek',
    defaultBudget: { dailyUsd: 5, monthlyUsd: 50 },
    resolve: async () => ({ consent }),
    ledger,
    pricing: DEFAULT_DEEPSEEK_PRICING,
    maxOutputTokens: 2000,
    newReservationId: () => `r-${++seq}`,
    now: () => NOW,
  });
}

function ledgerTotal(ledger: InMemorySpendLedger): number {
  return ledger.rows.reduce(
    (sum, row) => sum + (row.state === 'settled' ? (row.actualUsd ?? row.reservedUsd) : row.reservedUsd),
    0,
  );
}

async function settleLedger(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function errorUsage(error: unknown): LlmUsage | undefined {
  return (error as { usage?: LlmUsage }).usage;
}

describe('runStructured + PolicyLlm: raced attempts keep their charge (FU-54)', () => {
  test('caller abort mid-call: error.usage equals the ledger (reserved_fallback)', async () => {
    const ledger = new InMemorySpendLedger();
    const controller = new AbortController();
    const pending = runStructured(policy(new AbortablePort(), ledger), decomposition, {
      allowUnbudgeted: true,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const error = await pending;
    await settleLedger();

    expect(error).toBeInstanceOf(LlmUnavailable);
    expect((error as LlmUnavailable).reason).toBe('aborted');
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ state: 'settled', settleReason: 'reserved_fallback' });
    expect(errorUsage(error)?.costUsd).toBeGreaterThan(0);
    expect(errorUsage(error)?.costUsd).toBeCloseTo(ledgerTotal(ledger), 12);
  });

  test('runStructured timeout mid-call: error.usage equals the ledger', async () => {
    const ledger = new InMemorySpendLedger();
    const error = await runStructured(policy(new AbortablePort(), ledger), decomposition, {
      allowUnbudgeted: true,
      timeoutMs: 40,
    }).catch((caught: unknown) => caught);
    await settleLedger();

    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect(errorUsage(error)?.costUsd).toBeGreaterThan(0);
    expect(errorUsage(error)?.costUsd).toBeCloseTo(ledgerTotal(ledger), 12);
  });

  test('timeout of the repair after a charged first attempt: usage is the sum of both rows', async () => {
    const ledger = new InMemorySpendLedger();
    const error = await runStructured(policy(new ChargedThenHangingPort(), ledger), decomposition, {
      allowUnbudgeted: true,
      timeoutMs: 40,
    }).catch((caught: unknown) => caught);
    await settleLedger();

    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect(ledger.rows.map((row) => row.settleReason)).toEqual(['actual', 'reserved_fallback']);
    expect(errorUsage(error)?.costUsd).toBeCloseTo(ledgerTotal(ledger), 12);
    expect(errorUsage(error)?.inputTokens).toBe(1000);
  });

  test('a transport that ignores the abort is waited for at most the grace, charged at the reservation', async () => {
    const ledger = new InMemorySpendLedger();
    const controller = new AbortController();
    const started = Date.now();
    const pending = runStructured(policy(new DeafPort(), ledger), decomposition, {
      allowUnbudgeted: true,
      signal: controller.signal,
      abortSettleGraceMs: 30,
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    const error = await pending;

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(ledger.rows[0]?.state).toBe('reserved');
    // The row stays reserved (stale recovery settles it at reserved_usd), which
    // is exactly the charge reported on the error.
    expect(errorUsage(error)?.costUsd).toBeCloseTo(ledger.rows[0]?.reservedUsd ?? -1, 12);
  });

  test('negative: an already-aborted caller never reserves, never dispatches, costs nothing', async () => {
    const ledger = new InMemorySpendLedger();
    const inner = new AbortablePort();
    const controller = new AbortController();
    controller.abort();
    const error = await runStructured(policy(inner, ledger), decomposition, {
      allowUnbudgeted: true,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(inner.calls).toBe(0);
    expect(ledger.rows).toEqual([]);
    expect(errorUsage(error)?.costUsd ?? 0).toBe(0);
  });

  test('abort while the reservation is being written: settled at actual 0, never dispatched', async () => {
    const inner = new AbortablePort();
    const memory = new InMemorySpendLedger();
    const controller = new AbortController();
    const slowReserve: LlmSpendLedger = {
      async reserve(input: LlmSpendReserveInput): Promise<void> {
        await memory.reserve(input);
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      settle(input: LlmSpendSettleInput): Promise<LlmSpendTotals> {
        return memory.settle(input);
      },
    };
    const error = await runStructured(policy(inner, slowReserve), decomposition, {
      allowUnbudgeted: true,
      signal: controller.signal,
    }).catch((caught: unknown) => caught);
    await settleLedger();

    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(inner.calls).toBe(0);
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0]).toMatchObject({ state: 'settled', actualUsd: 0, settleReason: 'actual' });
    expect(errorUsage(error)?.costUsd ?? 0).toBe(ledgerTotal(memory));
  });
});

describe('runStructured total deadline (FU-76)', () => {
  test('the repair attempt gets only the time left and the chain stops at the bound', async () => {
    const ledger = new InMemorySpendLedger();
    const started = Date.now();
    const error = await runStructured(policy(new ChargedThenHangingPort(), ledger), decomposition, {
      allowUnbudgeted: true,
      timeoutMs: 5_000,
      totalTimeoutMs: 80,
    }).catch((caught: unknown) => caught);
    await settleLedger();

    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(ledger.rows).toHaveLength(2);
    expect(errorUsage(error)?.costUsd).toBeCloseTo(ledgerTotal(ledger), 12);
  });

  test('negative: an exhausted deadline never starts (or reserves) another attempt', async () => {
    const ledger = new InMemorySpendLedger();
    let clock = 0;
    const inner: LlmPort = {
      async complete(): Promise<LlmCompleteResponse> {
        clock += 100; // the first attempt consumes the whole bound
        return {
          output: { steps: 'invalid' },
          usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.00001 },
          model: 'deepseek-v4.1-flash',
          latencyMs: 100,
        };
      },
    };
    const error = await runStructured(policy(inner, ledger), decomposition, {
      allowUnbudgeted: true,
      totalTimeoutMs: 100,
      now: () => clock,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect(ledger.rows).toHaveLength(1);
    expect(errorUsage(error)?.costUsd).toBeCloseTo(0.00001, 12);
  });

  test('without totalTimeoutMs the per-attempt timeout is not forwarded for prompts without a limit', async () => {
    const seen: LlmCompleteRequest[] = [];
    const port: LlmPort = {
      async complete(request): Promise<LlmCompleteResponse> {
        seen.push(request);
        return { output: exampleForSchema(request.schemaId), usage: { inputTokens: 1, outputTokens: 1 }, model: 'fake-llm', latencyMs: 0 };
      },
    };
    await runStructured(port, { promptId: 'type_detection', version: 'v1', input: {}, schemaId: 'llm.type_detection.v1' }, { allowUnbudgeted: true });
    await runStructured(port, { promptId: 'type_detection', version: 'v1', input: {}, schemaId: 'llm.type_detection.v1' }, { allowUnbudgeted: true, totalTimeoutMs: 10 });
    expect(seen[0]).not.toHaveProperty('timeoutMs');
    expect(seen[1]?.timeoutMs).toBeLessThanOrEqual(10);
  });
});

describe('one message builder for the policy bound and the adapter (FU-54)', () => {
  test('the shared builder produces the documented system and user messages', () => {
    const [system, user] = buildStructuredMessages(decomposition);
    expect(system).toEqual({
      role: 'system',
      content: structuredSystemPrompt('decomposition', 'v1', 'llm.decomposition.v1'),
    });
    expect(user).toEqual({ role: 'user', content: JSON.stringify(decomposition.input) });
  });

  test('every outbound body (JSON mode and fallback) stays within the reserved token bound', async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: { role: 'system' | 'user'; content: string }[]; response_format?: unknown };
      bodies.push(body);
      if (body.response_format !== undefined) {
        return new Response(JSON.stringify({ error: { message: 'response_format json_object unsupported' } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-v4.1-flash',
          choices: [{ message: { content: JSON.stringify(exampleForSchema('llm.decomposition.v1')) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    }) as typeof globalThis.fetch;
    const adapter = new OpenAICompatibleLlm({
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'test-key-not-real',
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      fetch: fetchImpl,
      sessionHeader: 'off',
    });
    const ledger = new InMemorySpendLedger();
    await policy(adapter, ledger).complete({ ...decomposition, maxOutputTokens: 8000 });

    expect(bodies).toHaveLength(2);
    const [system, user] = buildStructuredMessages(decomposition);
    const bound = estimateInputTokensUpperBound(system.content, user.content);
    for (const body of bodies) {
      const messages = body.messages.map((message) => ({ role: message.role as 'system' | 'user', content: message.content }));
      expect(structuredContentBytes(messages)).toBeLessThanOrEqual(bound);
      expect(messages[1]?.content).toBe(user.content);
    }
    expect(bodies[0]?.messages[0]?.content).toBe(system.content);
    expect(bodies[1]?.messages[0]?.content).toBe(`${system.content}${STRICT_JSON_INSTRUCTION}`);
  });
});

describe('stale reservation threshold counts the JSON-mode fallback (FU-54)', () => {
  test('threshold is timeout x (retries + 1) x 2 + margin; the single-chain formula is unchanged', () => {
    expect(staleReservationThresholdWithFallbackMs(30_000, 2, 60_000)).toBe(240_000);
    expect(staleReservationThresholdWithFallbackMs(120_000, 2, 60_000)).toBe(780_000);
    expect(staleReservationThresholdMs(30_000, 2, 60_000)).toBe(150_000);
  });

  test('the policy default keeps a 200 s old reservation (fallback chain may still run) and recovers one older than 240 s', async () => {
    const ledger = new InMemorySpendLedger();
    const age = (seconds: number): string => new Date(NOW.getTime() - seconds * 1_000).toISOString();
    for (const [id, seconds] of [['young', 200], ['old', 241]] as const) {
      ledger.rows.push({
        id,
        ownerId: 'owner-1',
        purpose: 'decomposition@v1',
        state: 'reserved',
        reservedUsd: 0.001,
        actualUsd: null,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        createdAt: age(seconds),
        settledAt: null,
        settleReason: null,
      });
    }
    const inner: LlmPort = {
      async complete(request): Promise<LlmCompleteResponse> {
        return { output: exampleForSchema(request.schemaId), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'deepseek-v4.1-flash', latencyMs: 1 };
      },
    };
    await policy(inner, ledger).complete(decomposition);

    expect(ledger.rows.find((row) => row.id === 'young')?.state).toBe('reserved');
    expect(ledger.rows.find((row) => row.id === 'old')).toMatchObject({ state: 'settled', settleReason: 'recovered' });
  });
});
