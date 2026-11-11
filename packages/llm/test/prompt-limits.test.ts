/**
 * M6-01 fix round 1 addendum: per-prompt output bound and timeout
 * (decomposition 8000 tokens / 120 s; type_detection unchanged).
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import {
  DEFAULT_DEEPSEEK_PRICING,
  InMemorySpendLedger,
  LlmTimeoutError,
  OpenAICompatibleLlm,
  PolicyLlm,
  effectiveMaxOutputTokens,
  estimateInputTokensUpperBound,
  estimateReservationUsd,
  exampleForSchema,
  maxPromptTimeoutMs,
  promptLimitsFor,
  runStructured,
  structuredSystemPrompt,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '../src/index.js';

const decomposition = {
  promptId: 'decomposition',
  version: 'v1',
  input: { task: { estimatedScope: 'medium' } },
  schemaId: 'llm.decomposition.v1',
} as const;
const detection = {
  promptId: 'type_detection',
  version: 'v1',
  input: { title: 'x' },
  schemaId: 'llm.type_detection.v1',
} as const;

class CapturingPort implements LlmPort {
  readonly requests: LlmCompleteRequest[] = [];
  constructor(private readonly output: (request: LlmCompleteRequest) => unknown) {}
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.requests.push(request);
    return { output: this.output(request), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'm', latencyMs: 1 };
  }
}

describe('prompt limits', () => {
  test('decomposition has 8000 tokens / 120 s; other prompts have no override', () => {
    expect(promptLimitsFor('decomposition')).toEqual({ maxOutputTokens: 8000, timeoutMs: 120_000 });
    expect(promptLimitsFor('type_detection')).toBeUndefined();
    expect(maxPromptTimeoutMs()).toBe(120_000);
    expect(() => promptLimitsFor('x', { x: { maxOutputTokens: 0, timeoutMs: 1 } })).toThrow(RangeError);
    expect(() => promptLimitsFor('x', { x: { maxOutputTokens: 1, timeoutMs: -1 } })).toThrow(RangeError);
    expect(() => promptLimitsFor('x', { x: { maxOutputTokens: 40_000, timeoutMs: 1 } })).toThrow(RangeError);
  });

  test('effectiveMaxOutputTokens accepts only a valid per-call bound', () => {
    expect(effectiveMaxOutputTokens(8000, 2000)).toBe(8000);
    expect(effectiveMaxOutputTokens(undefined, 2000)).toBe(2000);
    for (const bad of [0, -1, 1.5, Number.NaN, 1_000_000]) expect(effectiveMaxOutputTokens(bad, 2000)).toBe(2000);
  });

  test('runStructured forwards the decomposition limits and leaves type_detection untouched', async () => {
    const port = new CapturingPort((request) => exampleForSchema(request.schemaId));
    await runStructured(port, decomposition, { allowUnbudgeted: true });
    await runStructured(port, detection, { allowUnbudgeted: true });
    expect(port.requests[0]).toMatchObject({ maxOutputTokens: 8000, timeoutMs: 120_000 });
    expect(port.requests[1]).not.toHaveProperty('maxOutputTokens');
    expect(port.requests[1]).not.toHaveProperty('timeoutMs');
    // Configured overrides (config.ts) replace the defaults; explicit values win.
    await runStructured(port, decomposition, {
      allowUnbudgeted: true,
      promptLimits: { decomposition: { maxOutputTokens: 6000, timeoutMs: 90_000 } },
    });
    await runStructured(port, { ...decomposition, maxOutputTokens: 7000 }, { allowUnbudgeted: true, timeoutMs: 50_000 });
    expect(port.requests[2]).toMatchObject({ maxOutputTokens: 6000, timeoutMs: 90_000 });
    expect(port.requests[3]).toMatchObject({ maxOutputTokens: 7000, timeoutMs: 50_000 });
  });

  test('runStructured times decomposition out at 120 s and type_detection at 30 s (llm_unavailable)', async () => {
    vi.useFakeTimers();
    try {
      const hanging: LlmPort = { complete: () => new Promise(() => undefined) };
      const slow = runStructured(hanging, decomposition, { allowUnbudgeted: true });
      const slowResult = slow.then(
        () => 'resolved',
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_001);
      let settled = false;
      void slowResult.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(90_000);
      const error = await slowResult;
      expect(error).toBeInstanceOf(LlmTimeoutError);
      expect(error).toMatchObject({ code: 'llm_unavailable', timeoutMs: 120_000 });

      const fast = runStructured(hanging, detection, { allowUnbudgeted: true }).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await fast).toMatchObject({ timeoutMs: 30_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  test('PolicyLlm reserves with the per-call bound and the full system message', async () => {
    const ledger = new InMemorySpendLedger();
    let seq = 0;
    const inner = new CapturingPort((request) => exampleForSchema(request.schemaId));
    const llm = new PolicyLlm({
      inner,
      providerId: 'deepseek',
      defaultBudget: { dailyUsd: 5, monthlyUsd: 50 },
      resolve: async () => ({ consent: { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } }),
      ledger,
      pricing: DEFAULT_DEEPSEEK_PRICING,
      maxOutputTokens: 2000,
      newReservationId: () => `r-${++seq}`,
      now: () => new Date('2026-11-12T00:00:00.000Z'),
    });
    await runStructured(llm, { ...decomposition, ownerId: 'o1' }, { allowUnbudgeted: true });
    await runStructured(llm, { ...detection, ownerId: 'o1' }, { allowUnbudgeted: true });
    const expected = (promptId: string, version: string, schemaId: string, input: unknown, maxTokens: number) =>
      estimateReservationUsd(
        estimateInputTokensUpperBound(structuredSystemPrompt(promptId, version, schemaId), JSON.stringify(input)),
        maxTokens,
        DEFAULT_DEEPSEEK_PRICING,
      );
    expect(ledger.rows[0]?.reservedUsd).toBeCloseTo(
      expected('decomposition', 'v1', 'llm.decomposition.v1', decomposition.input, 8000),
      12,
    );
    expect(ledger.rows[1]?.reservedUsd).toBeCloseTo(
      expected('type_detection', 'v1', 'llm.type_detection.v1', detection.input, 2000),
      12,
    );
    expect(ledger.rows[0]?.reservedUsd).toBeGreaterThan(ledger.rows[1]?.reservedUsd ?? 0);
  });

  test('the adapter sends the per-call max_tokens, the contract and honours the per-call timeout', async () => {
    const bodies: Record<string, unknown>[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        bodies.push(body);
        const messages = body['messages'] as { content: string }[];
        const schemaId = (messages[0]?.content.match(/# Output contract \(([^)]+)\)/) ?? [])[1] as string;
        // Slower than the adapter default (100 ms) but within the per-call timeout.
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              model: 'm',
              choices: [{ message: { content: JSON.stringify(exampleForSchema(schemaId)) } }],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
        }, 300);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const llm = new OpenAICompatibleLlm({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        apiKey: 'sk-test-limits-synthetic',
        model: 'm',
        timeoutMs: 100,
        maxRetries: 0,
        maxOutputTokens: 2000,
      });
      const result = await llm.complete({ ...decomposition, maxOutputTokens: 8000, timeoutMs: 5_000 });
      expect(result.output).toEqual(exampleForSchema('llm.decomposition.v1'));
      expect(bodies[0]?.['max_tokens']).toBe(8000);
      const system = (bodies[0]?.['messages'] as { content: string }[])[0]?.content;
      expect(system).toBe(structuredSystemPrompt('decomposition', 'v1', 'llm.decomposition.v1'));
      // Without a per-call timeout the 100 ms adapter default applies and expires.
      await expect(llm.complete(detection)).rejects.toBeInstanceOf(LlmTimeoutError);
      expect(bodies[1]?.['max_tokens']).toBe(2000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
