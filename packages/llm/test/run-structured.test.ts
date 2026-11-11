import { vi } from 'vitest';
import {
  BudgetExceeded,
  BudgetGuard,
  FakeLlm,
  LlmTimeoutError,
  LlmUnavailable,
  SchemaViolation,
  appendValidationErrors,
  runStructured,
  validateOutput,
  type LlmCompleteResponse,
  type LlmPort,
} from '../src/index.js';

const validTypeDetection = {
  classification: 'new',
  confidence: 0.9,
  reasons: ['no matching template'],
  missingRequired: ['dueAt'],
};

const unbudgeted = { allowUnbudgeted: true } as const;

const request = {
  promptId: 'type_detection',
  version: 'v1',
  input: { title: 'Write a report' },
  schemaId: 'llm.type_detection.v1',
} as const;

test('returns validated output and usage from FakeLlm', async () => {
  const llm = new FakeLlm([
    {
      promptId: 'type_detection',
      input: request.input,
      response: {
        output: validTypeDetection,
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
        model: 'fixture-model',
        latencyMs: 12,
      },
    },
  ]);

  const result = await runStructured(llm, request, unbudgeted);
  expect(result.output).toEqual(validTypeDetection);
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, costUsd: 0.001 });
  expect(result.model).toBe('fixture-model');
  expect(result.attempts).toBe(1);
  expect(result.repairs).toBe(0);
  expect(llm.calls).toHaveLength(1);
});

test('one invalid output triggers exactly one repair retry with validation errors appended', async () => {
  const invalid = { classification: 'maybe', confidence: 2, reasons: [] };
  const errors = validateOutput('llm.type_detection.v1', invalid).errors;
  const repairedInput = appendValidationErrors(request.input, errors);

  const llm = new FakeLlm([
    { promptId: 'type_detection', input: request.input, response: { output: invalid } },
    { promptId: 'type_detection', input: repairedInput, response: { output: validTypeDetection } },
  ]);

  const result = await runStructured(llm, request, unbudgeted);
  expect(result.output).toEqual(validTypeDetection);
  expect(result.attempts).toBe(2);
  expect(result.repairs).toBe(1);
  expect(llm.calls).toHaveLength(2);
});

test('two invalid outputs throw SchemaViolation after the single repair', async () => {
  const invalid = { classification: 'maybe' };
  const errors = validateOutput('llm.type_detection.v1', invalid).errors;
  const repairedInput = appendValidationErrors(request.input, errors);
  const llm = new FakeLlm([
    { promptId: 'type_detection', input: request.input, response: { output: invalid } },
    { promptId: 'type_detection', input: repairedInput, response: { output: invalid } },
  ]);

  await expect(runStructured(llm, request, unbudgeted)).rejects.toBeInstanceOf(SchemaViolation);
  expect(llm.calls).toHaveLength(2);
});

class FlakyPort implements LlmPort {
  attempts = 0;

  constructor(
    private readonly failures: number,
    private readonly response: LlmCompleteResponse,
  ) {}

  async complete(): Promise<LlmCompleteResponse> {
    this.attempts += 1;
    if (this.attempts <= this.failures) throw new LlmUnavailable('503 from provider');
    return this.response;
  }
}

test('LlmUnavailable is retried at most twice with injected exponential backoff', async () => {
  const sleep = vi.fn((ms: number) => {
    void ms;
    return Promise.resolve();
  });
  const port = new FlakyPort(2, {
    output: validTypeDetection,
    usage: { inputTokens: 1, outputTokens: 1 },
    model: 'flaky',
    latencyMs: 1,
  });

  const result = await runStructured(port, request, { ...unbudgeted, sleep, backoffBaseMs: 100 });
  expect(result.attempts).toBe(3);
  expect(port.attempts).toBe(3);
  expect(sleep.mock.calls.map((call) => call[0])).toEqual([100, 200]);
});

test('LlmUnavailable after two retries is rethrown', async () => {
  const sleep = vi.fn((ms: number) => {
    void ms;
    return Promise.resolve();
  });
  const port = new FlakyPort(10, {
    output: validTypeDetection,
    usage: { inputTokens: 0, outputTokens: 0 },
    model: 'flaky',
    latencyMs: 0,
  });

  await expect(
    runStructured(port, request, { ...unbudgeted, sleep, maxUnavailableRetries: 2 }),
  ).rejects.toBeInstanceOf(LlmUnavailable);
  expect(port.attempts).toBe(3);
});

test('timeout aborts the call and is not retried', async () => {
  let calls = 0;
  let aborted = false;
  const port: LlmPort = {
    complete: (req) => {
      calls += 1;
      return new Promise<LlmCompleteResponse>((_resolve, reject) => {
        req.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new LlmUnavailable('aborted', 'aborted'));
          },
          { once: true },
        );
      });
    },
  };

  await expect(runStructured(port, request, { ...unbudgeted, timeoutMs: 25 })).rejects.toBeInstanceOf(
    LlmTimeoutError,
  );
  expect(calls).toBe(1);
  expect(aborted).toBe(true);
});

test('refuses to call without a BudgetGuard unless explicitly allowed', async () => {
  const llm = new FakeLlm([
    { promptId: 'type_detection', input: request.input, response: { output: validTypeDetection } },
  ]);
  await expect(runStructured(llm, request)).rejects.toBeInstanceOf(BudgetExceeded);
  expect(llm.calls).toHaveLength(0);
});

test('a pre-aborted signal never invokes the port', async () => {
  const controller = new AbortController();
  controller.abort();
  const llm = new FakeLlm([
    { promptId: 'type_detection', input: request.input, response: { output: validTypeDetection } },
  ]);

  await expect(
    runStructured(llm, request, { ...unbudgeted, signal: controller.signal }),
  ).rejects.toMatchObject({ code: 'llm_unavailable', reason: 'aborted' });
  expect(llm.calls).toHaveLength(0);
});

test('a mid-flight abort is not retried', async () => {
  let calls = 0;
  const port: LlmPort = {
    complete: (req) => {
      calls += 1;
      return new Promise<LlmCompleteResponse>((_resolve, reject) => {
        req.signal?.addEventListener(
          'abort',
          () => reject(new LlmUnavailable('aborted', 'aborted')),
          { once: true },
        );
      });
    },
  };
  const controller = new AbortController();
  const promise = runStructured(port, request, {
    ...unbudgeted,
    sleep: async () => undefined,
    signal: controller.signal,
  });
  controller.abort();

  await expect(promise).rejects.toMatchObject({ code: 'llm_unavailable', reason: 'aborted' });
  expect(calls).toBe(1);
});

test('real-model usage without costUsd blocks the next call', async () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    () => new Date('2026-11-11T00:00:00.000Z'),
  );
  const llm = new FakeLlm([
    {
      promptId: 'type_detection',
      input: request.input,
      response: {
        output: validTypeDetection,
        usage: { inputTokens: 1, outputTokens: 1 },
        model: 'real-adapter',
      },
    },
  ]);

  await runStructured(llm, request, { budgetGuard: guard });
  expect(guard.isExhausted()).toBe(true);
  await expect(runStructured(llm, request, { budgetGuard: guard })).rejects.toBeInstanceOf(
    BudgetExceeded,
  );
  expect(llm.calls).toHaveLength(1);
});

test('budget guard is consulted before the call', async () => {
  const guard = new BudgetGuard(
    { dailyUsd: 0.01, monthlyUsd: 1 },
    { spentTodayUsd: 0.02 },
    () => new Date('2026-11-11T00:00:00.000Z'),
  );
  const llm = new FakeLlm([
    { promptId: 'type_detection', input: request.input, response: { output: validTypeDetection } },
  ]);

  await expect(runStructured(llm, request, { budgetGuard: guard })).rejects.toBeInstanceOf(
    BudgetExceeded,
  );
  expect(llm.calls).toHaveLength(0);
});

test('budget guard records successful usage', async () => {
  const guard = new BudgetGuard(
    { dailyUsd: 1, monthlyUsd: 10 },
    {},
    () => new Date('2026-11-11T00:00:00.000Z'),
  );
  const llm = new FakeLlm([
    {
      promptId: 'type_detection',
      input: request.input,
      response: { output: validTypeDetection, usage: { costUsd: 0.25 } },
    },
  ]);

  await runStructured(llm, request, { budgetGuard: guard });
  expect(guard.snapshot().spentTodayUsd).toBe(0.25);
  expect(guard.snapshot().spentThisMonthUsd).toBe(0.25);
});

describe('terminal LlmError usage includes every charged attempt', () => {
  const invalid = { classification: 'maybe' };

  class ChargedThenFail implements LlmPort {
    calls = 0;

    constructor(private readonly failure: Error) {}

    async complete(): Promise<LlmCompleteResponse> {
      this.calls += 1;
      if (this.calls === 1) {
        return {
          output: invalid,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
          model: 'fixture',
          latencyMs: 1,
        };
      }
      throw this.failure;
    }
  }

  test('repair rejection carries the first attempt usage', async () => {
    const port = new ChargedThenFail(new LlmUnavailable('repair rejected', 'provider', false));
    let error: unknown;
    try {
      await runStructured(port, request, unbudgeted);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect((error as { usage?: unknown }).usage).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.1,
    });
    expect(port.calls).toBe(2);
  });

  test('transport failure on the repair carries the first attempt usage', async () => {
    const port = new ChargedThenFail(new LlmUnavailable('connection reset', 'provider', false));
    let error: unknown;
    try {
      await runStructured(port, request, unbudgeted);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect((error as { usage?: unknown }).usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.1,
    });
  });

  test('timeout after a charged first attempt carries that attempt usage', async () => {
    const port: LlmPort = {
      complete: (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          if (calls === 1) {
            return {
              output: invalid,
              usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
              model: 'fixture',
              latencyMs: 1,
            };
          }
          return new Promise<never>(() => {});
        };
      })(),
    };
    let error: unknown;
    try {
      await runStructured(port, request, { ...unbudgeted, timeoutMs: 10 });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(LlmTimeoutError);
    expect((error as { usage?: unknown }).usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.1,
    });
  });

  test('usage attached by a failed attempt is merged, not overwritten', async () => {
    const failure = new LlmUnavailable('gateway budget rejected the call', 'provider', false);
    failure.usage = { inputTokens: 50, outputTokens: 5, costUsd: 0.05 };
    const port = new ChargedThenFail(failure);
    let error: unknown;
    try {
      await runStructured(port, request, unbudgeted);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(LlmUnavailable);
    const usage = (error as { usage?: { inputTokens: number; outputTokens: number; costUsd: number } })
      .usage;
    expect(usage?.inputTokens).toBe(150);
    expect(usage?.outputTokens).toBe(15);
    expect(usage?.costUsd).toBeCloseTo(0.15, 12);
  });
});
