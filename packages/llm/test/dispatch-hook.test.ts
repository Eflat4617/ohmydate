/**
 * M6-01: `onDispatch` marks the moment a prompt actually leaves the process, so
 * note_ai_usage is recorded only for prompts that were sent (never for calls the
 * consent/budget gate refused).
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  DEFAULT_DEEPSEEK_PRICING,
  FakeLlm,
  InMemorySpendLedger,
  LlmUnavailable,
  OpenAICompatibleLlm,
  PolicyLlm,
  hashInput,
  runStructured,
  type LlmPort,
} from '../src/index.js';

const typeDetection = { classification: 'new', confidence: 0.9, reasons: ['r'] };
const request = {
  promptId: 'type_detection',
  version: 'v1',
  input: { title: 'x' },
  schemaId: 'llm.type_detection.v1',
} as const;

function policy(inner: LlmPort, consent: boolean): PolicyLlm {
  let seq = 0;
  return new PolicyLlm({
    inner,
    providerId: 'deepseek',
    defaultBudget: { dailyUsd: 1, monthlyUsd: 5 },
    resolve: async () =>
      consent
        ? { consent: { granted: true, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } }
        : { consent: { granted: false, at: '2026-11-12T00:00:00.000Z', provider: 'deepseek' } },
    ledger: new InMemorySpendLedger(),
    pricing: DEFAULT_DEEPSEEK_PRICING,
    maxOutputTokens: 100,
    newReservationId: () => `res-${++seq}`,
    now: () => new Date('2026-11-12T00:00:00.000Z'),
  });
}

describe('onDispatch hook', () => {
  test('FakeLlm fires it per call and records inputs only when asked', async () => {
    const plain = new FakeLlm();
    plain.addPromptFallback('type_detection', { output: typeDetection });
    let fired = 0;
    await plain.complete({ ...request, onDispatch: () => (fired += 1) });
    expect(fired).toBe(1);
    expect(plain.calls[0]).not.toHaveProperty('input');

    const recording = new FakeLlm([], { recordInputs: true });
    recording.addPromptFallback('type_detection', { output: typeDetection });
    await recording.complete(request);
    expect(recording.calls[0]?.input).toEqual(request.input);
    expect(recording.calls[0]?.inputHash).toBe(hashInput(request.input));
  });

  test('exact fixtures win over the prompt fallback; no fallback still fails closed', async () => {
    const llm = new FakeLlm([{ promptId: 'type_detection', input: request.input, response: { output: { exact: true } } }]);
    llm.addPromptFallback('type_detection', { output: { fallback: true } });
    expect((await llm.complete(request)).output).toEqual({ exact: true });
    expect((await llm.complete({ ...request, input: { other: 1 } })).output).toEqual({ fallback: true });
    await expect(new FakeLlm().complete(request)).rejects.toBeInstanceOf(LlmUnavailable);
  });

  test('runStructured forwards it to every attempt, including the repair attempt', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('type_detection', { output: { classification: 'bogus' } });
    let fired = 0;
    await expect(
      runStructured(llm, { ...request, onDispatch: () => (fired += 1) }, { allowUnbudgeted: true }),
    ).rejects.toThrow();
    expect(fired).toBe(2);
  });

  test('a call refused by the consent gate never dispatches', async () => {
    const inner = new FakeLlm();
    inner.addPromptFallback('type_detection', { output: typeDetection, usage: { costUsd: 0 } });
    let fired = 0;
    await expect(
      policy(inner, false).complete({ ...request, ownerId: 'o1', onDispatch: () => (fired += 1) }),
    ).rejects.toBeInstanceOf(LlmUnavailable);
    expect(fired).toBe(0);
    expect(inner.callCount).toBe(0);

    await policy(inner, true).complete({ ...request, ownerId: 'o1', onDispatch: () => (fired += 1) });
    expect(fired).toBe(1);
  });

  test('the OpenAI-compatible adapter fires it before every network attempt only', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits += 1;
      if (hits === 1) {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'm',
          choices: [{ message: { content: JSON.stringify(typeDetection) } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as AddressInfo;
      const llm = new OpenAICompatibleLlm({
        baseUrl: `http://127.0.0.1:${String(address.port)}`,
        apiKey: 'sk-test-dispatch-hook-synthetic',
        model: 'm',
        sleep: async () => undefined,
        random: () => 0.5,
      });
      const fired: number[] = [];
      await llm.complete({ ...request, onDispatch: () => fired.push(hits) });
      // Fired before attempt 1 (no hit yet) and before the retry (one hit so far).
      expect(fired).toEqual([0, 1]);
      expect(hits).toBe(2);

      const oversize = 'x'.repeat(1024 * 1024 + 1);
      let oversizeFired = 0;
      await expect(
        llm.complete({ ...request, input: { title: oversize }, onDispatch: () => (oversizeFired += 1) }),
      ).rejects.toThrow(RangeError);
      expect(oversizeFired).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
