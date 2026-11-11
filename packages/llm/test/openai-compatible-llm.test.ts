import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import {
  BudgetExceeded,
  LlmTimeoutError,
  LlmUnavailable,
  MAX_REDACT_INPUT,
  OpenAICompatibleLlm,
  PolicyLlm,
  ResponseFormatUnsupportedError,
  SchemaViolation,
  getPrompt,
  runStructured,
  type LlmCompleteResponse,
  type LlmPort,
  type OpenAICompatibleLlmOptions,
} from '../src/index.js';

const KEY_MARKER = 'sk-test-synthetic-marker-never-log';
const validTypeDetection = {
  classification: 'new',
  confidence: 0.9,
  reasons: ['no matching template'],
  missingRequired: ['dueAt'],
};

interface CapturedRequest {
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
  readonly json: Record<string, unknown>;
}

interface FakeServer {
  readonly url: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

function chatResponse(content: string, usage: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    model: 'deepseek-v4.1-flash',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage,
  });
}

async function startServer(
  handler: (request: CapturedRequest, response: ServerResponse, index: number) => void,
): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const captured: CapturedRequest = {
        headers: request.headers,
        body,
        json: body.length === 0 ? {} : (JSON.parse(body) as Record<string, unknown>),
      };
      requests.push(captured);
      handler(captured, response, requests.length - 1);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

function adapter(
  url: string,
  overrides: Partial<OpenAICompatibleLlmOptions> = {},
): OpenAICompatibleLlm {
  return new OpenAICompatibleLlm({
    baseUrl: url,
    apiKey: KEY_MARKER,
    model: 'deepseek-v4.1-flash',
    provider: 'deepseek',
    reasoningEffort: 'medium',
    sleep: async () => undefined,
    random: () => 0.5,
    ...overrides,
  });
}

const request = {
  promptId: 'type_detection',
  version: 'v1',
  input: { title: 'Write a report', documents: ['<untrusted_document id="d1">x</untrusted_document>'] },
  schemaId: 'llm.type_detection.v1',
} as const;

describe('OpenAICompatibleLlm', () => {
  test('success maps JSON output, usage, cached tokens, cost, latency and provider', async () => {
    const server = await startServer((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          chatResponse(JSON.stringify(validTypeDetection), {
            prompt_tokens: 2000,
            completion_tokens: 500,
            prompt_tokens_details: { cached_tokens: 1000 },
          }),
        ),
    );
    try {
      let now = 1_000;
      const llm = adapter(server.url, { now: () => (now += 25) });
      const result = await llm.complete(request);
      expect(result.output).toEqual(validTypeDetection);
      expect(result.model).toBe('deepseek-v4.1-flash');
      expect(result.provider).toBe('deepseek');
      expect(result.latencyMs).toBeGreaterThan(0);
      expect(result.usage).toMatchObject({
        inputTokens: 2000,
        outputTokens: 500,
        cachedInputTokens: 1000,
      });
      // billed input 1000*0.15 + cached 1000*0.003 + output 500*0.6, per 1M
      expect(result.usage.costUsd).toBeCloseTo((150 + 3 + 300) / 1_000_000, 12);

      const [captured] = server.requests;
      expect(captured?.headers.authorization).toBe(`Bearer ${KEY_MARKER}`);
      expect(captured?.body.includes(KEY_MARKER)).toBe(false);
      expect(captured?.json).toMatchObject({
        model: 'deepseek-v4.1-flash',
        reasoning_effort: 'medium',
        response_format: { type: 'json_object' },
      });
      const messages = captured?.json['messages'] as Array<{ role: string; content: string }>;
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toContain('You are a planning assistant');
      expect(messages[1]?.content).toContain('<untrusted_document id=\\"d1\\">');
    } finally {
      await server.close();
    }
  });

  test('retries 429 then succeeds with jittered exponential backoff', async () => {
    const server = await startServer((_request, response, index) => {
      if (index === 0) response.writeHead(429, { 'content-type': 'application/json' }).end('{}');
      else
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(chatResponse(JSON.stringify(validTypeDetection)));
    });
    try {
      const sleep = vi.fn(async (ms: number) => void ms);
      const llm = adapter(server.url, { sleep, random: () => 0.25, backoffBaseMs: 100 });
      const result = await llm.complete(request);
      expect(result.output).toEqual(validTypeDetection);
      expect(server.requests).toHaveLength(2);
      // ceiling 100 * (0.5 + 0.25) = 75
      expect(sleep).toHaveBeenCalledWith(75);
    } finally {
      await server.close();
    }
  });

  test('retries 500 twice then reports unavailable with retryable=false', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'),
    );
    try {
      const llm = adapter(server.url);
      await expect(llm.complete(request)).rejects.toMatchObject({
        code: 'llm_unavailable',
        retryable: false,
      });
      expect(server.requests).toHaveLength(3);
    } finally {
      await server.close();
    }
  });

  test('does not retry a generic 400', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad"}'),
    );
    try {
      const llm = adapter(server.url);
      await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmUnavailable);
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test('times out via AbortSignal and reports LlmTimeoutError', async () => {
    const server = await startServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' }).end(chatResponse('{}'));
      }, 200);
    });
    try {
      const llm = adapter(server.url, { timeoutMs: 20 });
      await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmTimeoutError);
    } finally {
      await server.close();
    }
  });

  test('malformed model JSON reaches the schema repair path', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(chatResponse('not-json')),
    );
    try {
      const llm = adapter(server.url);
      await expect(runStructured(llm, request, { allowUnbudgeted: true })).rejects.toBeInstanceOf(
        SchemaViolation,
      );
      expect(server.requests).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  test('falls back once to a strict instruction when response_format is rejected', async () => {
    const server = await startServer((_request, response, index) => {
      if (index === 0) {
        response
          .writeHead(400, { 'content-type': 'application/json' })
          .end('{"error":{"message":"response_format json_object is not supported"}}');
      } else {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(chatResponse(JSON.stringify(validTypeDetection)));
      }
    });
    try {
      const llm = adapter(server.url);
      const result = await llm.complete(request);
      expect(result.output).toEqual(validTypeDetection);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]?.json['response_format']).toEqual({ type: 'json_object' });
      expect(server.requests[1]?.json['response_format']).toBeUndefined();
      const messages = server.requests[1]?.json['messages'] as Array<{ content: string }>;
      expect(messages[0]?.content).toContain('Return only a single valid JSON object');
    } finally {
      await server.close();
    }
  });

  test('rejects an over-size input before any outbound call', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(chatResponse('{}')),
    );
    try {
      const llm = adapter(server.url);
      await expect(
        llm.complete({ ...request, input: { title: 'x'.repeat(MAX_REDACT_INPUT + 1) } }),
      ).rejects.toThrow(/MAX_REDACT_INPUT/);
      expect(server.requests).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  test('never leaks the key in errors', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(500).end('{"error":"upstream"}'),
    );
    try {
      const llm = adapter(server.url);
      let error: Error | undefined;
      try {
        await llm.complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(LlmUnavailable);
      expect(error?.message).not.toContain(KEY_MARKER);
      expect(JSON.stringify(error)).not.toContain(KEY_MARKER);
    } finally {
      await server.close();
    }
  });

  test('matches the recorded request-shape fixture', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(chatResponse(JSON.stringify(validTypeDetection))),
    );
    try {
      const llm = adapter(server.url);
      await llm.complete(request);
      const captured = server.requests[0]?.json;
      expect(captured).toBeDefined();
      expect(Object.keys(captured ?? {}).sort()).toEqual(
        ['messages', 'model', 'reasoning_effort', 'response_format'].sort(),
      );
      expect(captured?.['model']).toBe('deepseek-v4.1-flash');
      expect(captured?.['reasoning_effort']).toBe('medium');
      expect(captured?.['response_format']).toEqual({ type: 'json_object' });
      const messages = captured?.['messages'] as Array<{ role: string; content: string }>;
      expect(messages[0]).toEqual({ role: 'system', content: getPrompt('type_detection', 'v1') });
      expect(messages[1]).toEqual({
        role: 'user',
        content: JSON.stringify(request.input),
      });
      expect(JSON.stringify(captured)).not.toContain(KEY_MARKER);
    } finally {
      await server.close();
    }
  });
});

function stubResponse(): LlmCompleteResponse {
  return {
    output: validTypeDetection,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
    model: 'deepseek-v4.1-flash',
    latencyMs: 3,
  };
}

describe('PolicyLlm consent + per-owner budget', () => {
  const base = {
    providerId: 'deepseek',
    defaultBudget: { dailyUsd: 0.2, monthlyUsd: 5 },
  } as const;

  test('missing consent is unavailable and never calls the provider', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: null,
        spentTodayUsd: 0,
        spentThisMonthUsd: 0,
      }),
    });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toMatchObject({
      code: 'llm_unavailable',
      retryable: false,
    });
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('consent for another provider does not unlock this provider', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'other' },
        spentTodayUsd: 0,
        spentThisMonthUsd: 0,
      }),
    });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('granted consent calls the provider and adds the provider id', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' },
        spentTodayUsd: 0,
        spentThisMonthUsd: 0,
      }),
    });
    const result = await llm.complete({ ...request, ownerId: 'owner-1' });
    expect(result.provider).toBe('deepseek');
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  test('default conservative budget blocks an owner already at the daily ceiling', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' },
        spentTodayUsd: 0.2,
        spentThisMonthUsd: 0.2,
      }),
    });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('owner settings budget overrides the conservative default', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' },
        budget: { dailyUsd: 10, monthlyUsd: 50 },
        spentTodayUsd: 0.5,
        spentThisMonthUsd: 0.5,
      }),
    });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).resolves.toBeDefined();
    expect(inner.complete).toHaveBeenCalledTimes(1);
  });

  test('unpriced provider usage fails closed as budget_exceeded', async () => {
    const inner: LlmPort = {
      complete: vi.fn(async () => ({ ...stubResponse(), usage: { inputTokens: 1, outputTokens: 1 } })),
    };
    const llm = new PolicyLlm({
      ...base,
      inner,
      resolve: async () => ({
        consent: { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' },
        spentTodayUsd: 0,
        spentThisMonthUsd: 0,
      }),
    });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
  });

  test('missing owner id is rejected before resolving settings', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const resolve = vi.fn(async () => null);
    const llm = new PolicyLlm({ ...base, inner, resolve });
    await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('response_format rejection is a typed error, not an outage retry', () => {
    const error = new ResponseFormatUnsupportedError();
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(error.retryable).toBe(false);
  });
});
