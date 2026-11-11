import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import {
  BudgetExceeded,
  DEFAULT_DEEPSEEK_PRICING,
  FakeLlm,
  GatewayError,
  InMemorySpendLedger,
  LlmTimeoutError,
  LlmUnavailable,
  MAX_REDACT_INPUT,
  MissingSessionIdError,
  OpenAICompatibleLlm,
  PolicyLlm,
  ResponseFormatUnsupportedError,
  SchemaViolation,
  appendValidationErrors,
  getPrompt,
  runStructured,
  validateOutput,
  type LlmCompleteResponse,
  type LlmPort,
  type OpenAICompatibleLlmOptions,
  type PolicyLlmOptions,
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

function chatResponse(
  content: string,
  usage: Record<string, unknown> = { prompt_tokens: 1, completion_tokens: 1 },
): string {
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
    const fixture = JSON.parse(
      readFileSync(
        new URL('./fixtures/openai-compatible-request-shape.json', import.meta.url),
        'utf8',
      ),
    ) as {
      readonly promptKey: string;
      readonly model: string;
      readonly reasoning_effort: string;
      readonly response_format: { readonly type: string };
      readonly messages: {
        readonly roles: readonly string[];
        readonly systemIncludes: string;
        readonly userIsJsonStringifiedInput: boolean;
      };
      readonly forbidden: readonly string[];
    };
    expect(fixture.promptKey).toBe('type_detection@v1');
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(chatResponse(JSON.stringify(validTypeDetection))),
    );
    try {
      const llm = adapter(server.url);
      await llm.complete(request);
      const captured = server.requests[0]?.json;
      expect(captured).toBeDefined();
      expect(Object.keys(captured ?? {}).sort()).toEqual(
        ['max_tokens', 'messages', 'model', 'reasoning_effort', 'response_format'].sort(),
      );
      expect(captured?.['model']).toBe(fixture.model);
      expect(captured?.['reasoning_effort']).toBe(fixture.reasoning_effort);
      expect(captured?.['response_format']).toEqual(fixture.response_format);
      const messages = captured?.['messages'] as Array<{ role: string; content: string }>;
      expect(messages.map((message) => message.role)).toEqual(fixture.messages.roles);
      expect(messages[0]?.content).toContain(fixture.messages.systemIncludes);
      if (fixture.messages.userIsJsonStringifiedInput) {
        expect(messages[1]).toEqual({
          role: 'user',
          content: JSON.stringify(request.input),
        });
      }
      expect(messages[0]).toEqual({ role: 'system', content: getPrompt('type_detection', 'v1') });
      for (const forbidden of fixture.forbidden) {
        expect(JSON.stringify(captured)).not.toContain(forbidden);
      }
      expect(JSON.stringify(captured)).not.toContain(KEY_MARKER);
    } finally {
      await server.close();
    }
  });
});

describe('OpenCode Go session header', () => {
  const opencodeBase = 'https://opencode.ai/inference/go/openai/v1';
  const sessionSecret = 'synthetic-session-secret';

  function rewriteFetch(serverUrl: string): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const original = new URL(typeof input === 'string' ? input : input.toString());
      return globalThis.fetch(`${serverUrl}${original.pathname}`, init);
    }) as typeof globalThis.fetch;
  }

  async function opencodeServer(): Promise<FakeServer> {
    return startServer((_request, response) =>
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(chatResponse(JSON.stringify(validTypeDetection))),
    );
  }

  function gatewayLlm(server: FakeServer, overrides: Partial<OpenAICompatibleLlmOptions> = {}) {
    return new OpenAICompatibleLlm({
      baseUrl: opencodeBase,
      apiKey: KEY_MARKER,
      model: 'deepseek-v4.1-flash',
      provider: 'deepseek',
      sessionSecret,
      fetch: rewriteFetch(server.url),
      sleep: async () => undefined,
      random: () => 0.5,
      ...overrides,
    });
  }

  test('sends a stable non-identifying HMAC session header for one intake session', async () => {
    const server = await opencodeServer();
    try {
      const llm = gatewayLlm(server);
      const first = { ...request, ownerId: 'owner-1', sessionKey: 'session-1' };
      const second = { ...first, sessionKey: 'session-2' };
      await llm.complete(first);
      await llm.complete(first);
      await llm.complete(second);

      const headers = server.requests.map((entry) => entry.headers['x-opencode-session']);
      expect(headers[0]).toMatch(/^[0-9a-f]{32}$/u);
      expect(headers[0]).toBe(headers[1]);
      expect(headers[2]).not.toBe(headers[0]);
      expect(headers[0]).not.toContain('owner-1');
      expect(headers[0]).not.toContain('session-1');
      expect(headers[0]).not.toContain(KEY_MARKER);
      // The API key is not the HMAC secret.
      const keyDerived = createHmac('sha256', KEY_MARKER)
        .update('owner-1:session-1')
        .digest('hex')
        .slice(0, 32);
      expect(headers[0]).not.toBe(keyDerived);
      expect(server.requests[0]?.body).not.toContain(KEY_MARKER);
    } finally {
      await server.close();
    }
  });

  test('omits the session header when off or on a non-opencode host', async () => {
    const server = await opencodeServer();
    try {
      const off = gatewayLlm(server, { sessionHeader: 'off' });
      await off.complete({ ...request, ownerId: 'owner-1', sessionKey: 'session-1' });

      const otherHost = new OpenAICompatibleLlm({
        baseUrl: server.url,
        apiKey: KEY_MARKER,
        model: 'deepseek-v4.1-flash',
        provider: 'deepseek',
        sessionSecret,
      });
      await otherHost.complete({ ...request, ownerId: 'owner-1', sessionKey: 'session-1' });

      const missingKey = gatewayLlm(server);
      await missingKey.complete({ ...request, ownerId: 'owner-1' });

      expect(server.requests[0]?.headers['x-opencode-session']).toBeUndefined();
      expect(server.requests[1]?.headers['x-opencode-session']).toBeUndefined();
      expect(server.requests[2]?.headers['x-opencode-session']).toBeUndefined();
    } finally {
      await server.close();
    }
  });
});

describe('Gateway 4xx classification', () => {
  test('maps MissingSessionID to a typed non-retryable error without the raw body', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            type: 'MissingSessionID',
            message: 'raw-body-marker Request is missing x-opencode-session',
          },
        }),
      ),
    );
    try {
      const llm = adapter(server.url);
      let error: Error | undefined;
      try {
        await llm.complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(MissingSessionIdError);
      const typed = error as MissingSessionIdError;
      expect(typed.classification).toBe('missing_session');
      expect(typed.retryable).toBe(false);
      expect(typed.message).toContain('missing_session');
      expect(typed.message).not.toContain('raw-body-marker');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test('classifies other 4xx error.type values without echoing the body', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(400, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: { type: 'InvalidRequest', message: 'raw-body-marker' },
        }),
      ),
    );
    try {
      const llm = adapter(server.url);
      let error: Error | undefined;
      try {
        await llm.complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(GatewayError);
      const typed = error as GatewayError;
      expect(typed.status).toBe(400);
      expect(typed.classification).toBe('invalid_request');
      expect(typed.message).toContain('invalid_request');
      expect(typed.message).not.toContain('raw-body-marker');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test('drops an unbounded or malformed error.type instead of echoing it', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: { type: 'bad type with spaces'.repeat(20) } }),
      ),
    );
    try {
      const llm = adapter(server.url);
      let error: Error | undefined;
      try {
        await llm.complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).classification).toBe('auth');
      expect(error?.message).not.toContain('bad type');
      expect(server.requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe('H1 gateway classification never echoes provider strings', () => {
  test.each([
    { status: 400, classification: 'invalid_request', attempts: 1 },
    { status: 401, classification: 'auth', attempts: 1 },
    { status: 403, classification: 'auth', attempts: 1 },
    { status: 404, classification: 'invalid_request', attempts: 1 },
    { status: 429, classification: 'rate_limited', attempts: 3 },
    { status: 500, classification: 'server', attempts: 3 },
  ] as const)(
    'HTTP $status maps to $classification without the synthetic key marker',
    async ({ status, classification, attempts }) => {
      const server = await startServer((_request, response) =>
        response.writeHead(status, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { type: KEY_MARKER, message: `provider-echo-${KEY_MARKER}` },
          }),
        ),
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
        expect((error as GatewayError).classification).toBe(classification);
        expect(error?.message).not.toContain(KEY_MARKER);
        expect(JSON.stringify(error)).not.toContain(KEY_MARKER);
        expect(server.requests).toHaveLength(attempts);
      } finally {
        await server.close();
      }
    },
  );

  test('timeout and malformed success bodies never leak the marker', async () => {
    const slow = await startServer((_request, response) => {
      setTimeout(() => response.writeHead(200).end(chatResponse('{}')), 200);
    });
    try {
      let error: Error | undefined;
      try {
        await adapter(slow.url, { timeoutMs: 20 }).complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(LlmTimeoutError);
      expect(error?.message).not.toContain(KEY_MARKER);
      expect(JSON.stringify(error)).not.toContain(KEY_MARKER);
    } finally {
      await slow.close();
    }

    const malformed = await startServer((_request, response) =>
      response.writeHead(200).end(`not-json-${KEY_MARKER}`),
    );
    try {
      let error: Error | undefined;
      try {
        await adapter(malformed.url).complete(request);
      } catch (cause) {
        error = cause as Error;
      }
      expect(error).toBeInstanceOf(LlmUnavailable);
      expect(error?.message).not.toContain(KEY_MARKER);
      expect(JSON.stringify(error)).not.toContain(KEY_MARKER);
    } finally {
      await malformed.close();
    }
  });
});

describe('H5 usage validation fails closed', () => {
  test('missing usage is not a free paid response', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(
        JSON.stringify({
          model: 'deepseek-v4.1-flash',
          choices: [{ message: { content: JSON.stringify(validTypeDetection) } }],
        }),
      ),
    );
    try {
      await expect(adapter(server.url).complete(request)).rejects.toMatchObject({
        code: 'llm_unavailable',
        retryable: false,
      });
    } finally {
      await server.close();
    }
  });

  test('cached tokens above prompt tokens are rejected', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(
        chatResponse(JSON.stringify(validTypeDetection), {
          prompt_tokens: 10,
          completion_tokens: 1,
          prompt_tokens_details: { cached_tokens: 11 },
        }),
      ),
    );
    try {
      await expect(adapter(server.url).complete(request)).rejects.toMatchObject({
        code: 'llm_unavailable',
        retryable: false,
      });
    } finally {
      await server.close();
    }
  });

  test('every request carries max_tokens as the reservation output bound', async () => {
    const server = await startServer((_request, response) =>
      response.writeHead(200).end(chatResponse(JSON.stringify(validTypeDetection))),
    );
    try {
      await adapter(server.url, { maxOutputTokens: 1234 }).complete(request);
      expect(server.requests[0]?.json['max_tokens']).toBe(1234);
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

describe('PolicyLlm consent + ledger budget', () => {
  const now = () => new Date('2026-11-11T12:00:00.000Z');
  const consent = { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' };

  function makePolicy(
    resolve: (ownerId: string) => Promise<{
      consent?: typeof consent | null;
      budget?: { dailyUsd: number; monthlyUsd: number } | 'invalid' | null;
    } | null>,
    inner: LlmPort,
    overrides: Partial<PolicyLlmOptions> = {},
  ): { llm: PolicyLlm; ledger: InMemorySpendLedger } {
    const ledger = new InMemorySpendLedger();
    let seq = 0;
    const llm = new PolicyLlm({
      inner,
      providerId: 'deepseek',
      defaultBudget: { dailyUsd: 0.2, monthlyUsd: 5 },
      resolve,
      ledger,
      pricing: DEFAULT_DEEPSEEK_PRICING,
      maxOutputTokens: 2000,
      newReservationId: () => `res-${++seq}`,
      now,
      ...overrides,
    });
    return { llm, ledger };
  }

  test('missing consent is unavailable and never calls the provider or ledger', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm, ledger } = makePolicy(async () => ({ consent: null }), inner);
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toMatchObject({
      code: 'llm_unavailable',
      retryable: false,
    });
    expect(inner.complete).not.toHaveBeenCalled();
    expect(ledger.rows).toHaveLength(0);
  });

  test('consent for another provider does not unlock this provider', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm } = makePolicy(
      async () => ({ consent: { ...consent, provider: 'other' } }),
      inner,
    );
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('granted consent calls the provider, settles the ledger and adds the provider id', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm, ledger } = makePolicy(async () => ({ consent }), inner);
    const result = await llm.complete({ ...request, ownerId: 'owner-1' });
    expect(result.provider).toBe('deepseek');
    expect(inner.complete).toHaveBeenCalledTimes(1);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({
      state: 'settled',
      actualUsd: 0.001,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  test('saved zero daily or monthly budget disables calls instead of restoring defaults', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    for (const budget of [
      { dailyUsd: 0, monthlyUsd: 5 },
      { dailyUsd: 1, monthlyUsd: 0 },
    ]) {
      const { llm, ledger } = makePolicy(async () => ({ consent, budget }), inner);
      await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
        BudgetExceeded,
      );
      expect(ledger.rows).toHaveLength(0);
    }
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('invalid explicit savings fail closed without substituting defaults', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm, ledger } = makePolicy(
      async () => ({ consent, budget: 'invalid' }),
      inner,
    );
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(ledger.rows).toHaveLength(0);
    expect(inner.complete).not.toHaveBeenCalled();
  });

  test('defaults apply only when the owner never saved a budget', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm, ledger } = makePolicy(async () => ({ consent }), inner);
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).resolves.toBeDefined();
    expect(ledger.rows).toHaveLength(1);
  });

  test('actual spend over the cap returns budget_exceeded, retains the charge and blocks the next call', async () => {
    const expensive: LlmPort = {
      complete: vi.fn(async () => ({
        ...stubResponse(),
        usage: { inputTokens: 10, outputTokens: 5, costUsd: 1 },
      })),
    };
    const { llm, ledger } = makePolicy(
      async () => ({ consent, budget: { dailyUsd: 0.5, monthlyUsd: 5 } }),
      expensive,
    );
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(ledger.rows[0]).toMatchObject({ state: 'settled', actualUsd: 1 });
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(expensive.complete).toHaveBeenCalledTimes(1);
  });

  test('concurrent reservations against one cap allow exactly one paid call', async () => {
    const inner: LlmPort = {
      complete: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...stubResponse(), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.01 } };
      }),
    };
    const { llm, ledger } = makePolicy(
      async () => ({ consent, budget: { dailyUsd: 0.15, monthlyUsd: 5 } }),
      inner,
      {
        pricing: { inputUsd: 0, outputUsd: 1_000, cachedInputUsd: 0 },
        maxOutputTokens: 100,
      },
    );
    const results = await Promise.allSettled([
      llm.complete({ ...request, ownerId: 'owner-1' }),
      llm.complete({ ...request, ownerId: 'owner-1' }),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined).toBeInstanceOf(
      BudgetExceeded,
    );
    expect(ledger.rows.filter((row) => row.state === 'settled')).toHaveLength(1);
  });

  test('missing usage settles at the reservation and fails closed', async () => {
    const inner: LlmPort = {
      complete: vi.fn(async () => ({ ...stubResponse(), usage: { inputTokens: 1, outputTokens: 1 } })),
    };
    const { llm, ledger } = makePolicy(async () => ({ consent }), inner);
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      BudgetExceeded,
    );
    expect(ledger.rows[0]?.state).toBe('settled');
    expect(ledger.rows[0]?.actualUsd).toBe(ledger.rows[0]?.reservedUsd);
  });

  test('timeout settles at the reservation and keeps the charge', async () => {
    const inner: LlmPort = {
      complete: vi.fn(async () => {
        throw new LlmTimeoutError(30_000);
      }),
    };
    const { llm, ledger } = makePolicy(async () => ({ consent }), inner);
    await expect(llm.complete({ ...request, ownerId: 'owner-1' })).rejects.toBeInstanceOf(
      LlmTimeoutError,
    );
    expect(ledger.rows[0]?.state).toBe('settled');
    expect(ledger.rows[0]?.actualUsd).toBe(ledger.rows[0]?.reservedUsd);
  });

  test('owners are isolated for both consent and spend', async () => {
    const inner: LlmPort = {
      complete: vi.fn(async () => ({
        ...stubResponse(),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
      })),
    };
    const { llm, ledger } = makePolicy(
      async (ownerId) =>
        ownerId === 'owner-1'
          ? { consent, budget: { dailyUsd: 0.15, monthlyUsd: 5 } }
          : { consent, budget: { dailyUsd: 1, monthlyUsd: 5 } },
      inner,
    );
    await llm.complete({ ...request, ownerId: 'owner-1' });
    await llm.complete({ ...request, ownerId: 'owner-2' });
    expect(ledger.rows.map((row) => row.ownerId)).toEqual(['owner-1', 'owner-2']);
  });

  test('other owners inherit neither consent nor spend', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const { llm, ledger } = makePolicy(
      async (ownerId) =>
        ownerId === 'owner-1' ? { consent } : { consent: null },
      inner,
    );
    await llm.complete({ ...request, ownerId: 'owner-1' });
    await expect(llm.complete({ ...request, ownerId: 'owner-2' })).rejects.toMatchObject({
      code: 'llm_unavailable',
    });
    expect(ledger.rows.map((row) => row.ownerId)).toEqual(['owner-1']);
  });

  test('missing owner id is rejected before resolving settings', async () => {
    const inner: LlmPort = { complete: vi.fn(async () => stubResponse()) };
    const resolve = vi.fn(async () => null);
    const { llm } = makePolicy(resolve, inner);
    await expect(llm.complete(request)).rejects.toBeInstanceOf(LlmUnavailable);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('response_format rejection is a typed error, not an outage retry', () => {
    const error = new ResponseFormatUnsupportedError();
    expect(error).toBeInstanceOf(LlmUnavailable);
    expect(error.retryable).toBe(false);
  });
});

describe('PolicyLlm + runStructured attempt accounting', () => {
  const now = () => new Date('2026-11-11T12:00:00.000Z');
  const consent = { granted: true, at: '2026-11-11T00:00:00.000Z', provider: 'deepseek' };

  function policyFor(inner: LlmPort, ledger = new InMemorySpendLedger()): PolicyLlm {
    let seq = 0;
    return new PolicyLlm({
      inner,
      providerId: 'deepseek',
      defaultBudget: { dailyUsd: 5, monthlyUsd: 50 },
      resolve: async () => ({ consent, budget: { dailyUsd: 5, monthlyUsd: 50 } }),
      ledger,
      pricing: DEFAULT_DEEPSEEK_PRICING,
      maxOutputTokens: 2000,
      newReservationId: () => `run-${++seq}`,
      now,
    });
  }

  test('a schema repair charges both attempts and aggregates run usage', async () => {
    const invalid = { classification: 'maybe' };
    const errors = validateOutput('llm.type_detection.v1', invalid).errors;
    const repairedInput = appendValidationErrors(request.input, errors);
    const inner = new FakeLlm([
      {
        promptId: 'type_detection',
        input: request.input,
        response: {
          output: invalid,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
        },
      },
      {
        promptId: 'type_detection',
        input: repairedInput,
        response: {
          output: validTypeDetection,
          usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.1 },
        },
      },
    ]);
    const ledger = new InMemorySpendLedger();
    const llm = policyFor(inner, ledger);
    const result = await runStructured(llm, { ...request, ownerId: 'owner-1' }, { allowUnbudgeted: true });
    expect(result.usage).toMatchObject({ inputTokens: 220, outputTokens: 30, costUsd: 0.2 });
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.every((row) => row.state === 'settled' && row.actualUsd === 0.1)).toBe(true);
  });

  test('two invalid outputs still charge both attempts and expose aggregate usage', async () => {
    const invalid = { classification: 'maybe' };
    const errors = validateOutput('llm.type_detection.v1', invalid).errors;
    const repairedInput = appendValidationErrors(request.input, errors);
    const inner = new FakeLlm([
      {
        promptId: 'type_detection',
        input: request.input,
        response: {
          output: invalid,
          usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
        },
      },
      {
        promptId: 'type_detection',
        input: repairedInput,
        response: {
          output: invalid,
          usage: { inputTokens: 120, outputTokens: 20, costUsd: 0.1 },
        },
      },
    ]);
    const ledger = new InMemorySpendLedger();
    const llm = policyFor(inner, ledger);
    let error: SchemaViolation | undefined;
    try {
      await runStructured(llm, { ...request, ownerId: 'owner-1' }, { allowUnbudgeted: true });
    } catch (cause) {
      error = cause as SchemaViolation;
    }
    expect(error).toBeInstanceOf(SchemaViolation);
    expect(error?.usage).toMatchObject({ inputTokens: 220, outputTokens: 30, costUsd: 0.2 });
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows.every((row) => row.state === 'settled')).toBe(true);
  });
});
