import { createHmac, randomBytes } from 'node:crypto';
import {
  GatewayError,
  LlmTimeoutError,
  LlmUnavailable,
  MissingSessionIdError,
  ResponseFormatUnsupportedError,
  type GatewayClassification,
} from './errors.js';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';
import { assertRedactInputSize } from './privacy.js';
import { effectiveMaxOutputTokens } from './prompt-limits.js';
import {
  buildStructuredMessages,
  withStrictJsonInstruction,
  type StructuredChatMessage,
} from './structured-messages.js';

export { STRICT_JSON_INSTRUCTION } from './structured-messages.js';

/**
 * ADR-022 product adapter: OpenAI-compatible chat completions.
 *
 * The provider is named by config (`provider: 'deepseek'`) so agent_run
 * metadata and consent records stay provider-specific while the wire format
 * remains reusable. JSON output is requested with `response_format:
 * json_object`; a gateway that rejects it gets exactly one strict-instruction
 * retry, never an outage retry loop.
 */

export interface LlmPricingPerMillion {
  readonly inputUsd: number;
  readonly outputUsd: number;
  readonly cachedInputUsd: number;
}

/** ADR-022 metadata defaults (input $0.15 / output $0.60 / cache read $0.003 per 1M). */
export const DEFAULT_DEEPSEEK_PRICING: LlmPricingPerMillion = Object.freeze({
  inputUsd: 0.15,
  outputUsd: 0.6,
  cachedInputUsd: 0.003,
});

export interface OpenAICompatibleLlmOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
  readonly pricing?: LlmPricingPerMillion;
  readonly timeoutMs?: number;
  /** Retries after the first attempt for 429/5xx only (05 §8: 2). */
  readonly maxRetries?: number;
  readonly backoffBaseMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); tests inject a deterministic value. */
  readonly random?: () => number;
  readonly now?: () => number;
  /** `auto` (default) sends the gateway session header only for opencode.ai hosts. */
  readonly sessionHeader?: 'auto' | 'off';
  /** HMAC secret; when omitted a random per-adapter secret is used. Never the API key. */
  readonly sessionSecret?: string;
  /** Bound used for spend reservations; sent as `max_tokens` on every request. */
  readonly maxOutputTokens?: number;
}

type ChatMessage = StructuredChatMessage;

interface ChatRequestBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly reasoning_effort?: string;
  readonly response_format?: { readonly type: 'json_object' };
  readonly max_tokens: number;
}

interface ChatResponseBody {
  readonly model?: unknown;
  readonly choices?: readonly {
    readonly message?: { readonly content?: unknown };
  }[];
  readonly usage?: {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly prompt_tokens_details?: { readonly cached_tokens?: unknown };
  };
  readonly error?: unknown;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Internal classification only. The provider's `error.type` string is inspected
 * solely to recognise the session-header rejection and is never propagated.
 */
function classifyGatewayError(status: number, body: string): GatewayClassification {
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'invalid_request';
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown } };
    const type = parsed.error?.type;
    if (type === 'MissingSessionID') return 'missing_session';
  } catch {
    // A non-JSON body still classifies by HTTP status.
  }
  return status >= 400 ? 'invalid_request' : 'unknown';
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isResponseFormatRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /response_format|json_object|json mode/iu.test(body);
}

function isOpencodeHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

export class OpenAICompatibleLlm implements LlmPort {
  readonly #options: Required<
    Pick<
      OpenAICompatibleLlmOptions,
      | 'model'
      | 'provider'
      | 'timeoutMs'
      | 'maxRetries'
      | 'backoffBaseMs'
      | 'fetch'
      | 'sleep'
      | 'random'
      | 'now'
      | 'pricing'
      | 'sessionHeader'
      | 'sessionSecret'
      | 'maxOutputTokens'
    >
  > &
    Pick<OpenAICompatibleLlmOptions, 'baseUrl' | 'apiKey' | 'reasoningEffort'>;

  constructor(options: OpenAICompatibleLlmOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('OpenAI-compatible LLM requires a non-empty API key');
    }
    this.#options = {
      baseUrl: options.baseUrl.replace(/\/+$/u, ''),
      apiKey: options.apiKey.trim(),
      model: options.model,
      provider: options.provider ?? 'openai-compatible',
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: options.reasoningEffort }),
      pricing: options.pricing ?? DEFAULT_DEEPSEEK_PRICING,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: Math.max(0, options.maxRetries ?? 2),
      backoffBaseMs: Math.max(0, options.backoffBaseMs ?? 250),
      fetch: options.fetch ?? globalThis.fetch,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
      now: options.now ?? Date.now,
      sessionHeader: options.sessionHeader ?? 'auto',
      sessionSecret: options.sessionSecret ?? randomBytes(32).toString('hex'),
      maxOutputTokens: Math.max(1, Math.floor(options.maxOutputTokens ?? 2000)),
    };
  }

  /** Provider id recorded in agent_run metadata and consent records. */
  get providerId(): string {
    return this.#options.provider;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const startedAt = this.#options.now();
    const messages = this.#messages(request);
    // Per-call limits (prompt overrides); the policy reserved with the same bound.
    const maxTokens = effectiveMaxOutputTokens(request.maxOutputTokens, this.#options.maxOutputTokens);
    const timeoutMs =
      request.timeoutMs !== undefined && Number.isInteger(request.timeoutMs) && request.timeoutMs > 0
        ? request.timeoutMs
        : this.#options.timeoutMs;
    const body = this.#body(messages, true, maxTokens);
    const sessionId = this.#sessionId(request);

    let responseBody: ChatResponseBody;
    try {
      responseBody = await this.#send(body, request.signal, sessionId, request.onDispatch, timeoutMs);
    } catch (error) {
      if (!(error instanceof ResponseFormatUnsupportedError)) throw error;
      // Exactly one fallback, never part of the outage retry loop.
      const fallbackMessages = withStrictJsonInstruction(messages);
      responseBody = await this.#send(
        this.#body(fallbackMessages, false, maxTokens),
        request.signal,
        sessionId,
        request.onDispatch,
        timeoutMs,
      );
    }

    const latencyMs = Math.max(0, this.#options.now() - startedAt);
    const content = responseBody.choices?.[0]?.message?.content;
    const usage = this.#usageOrThrow(responseBody.usage);
    const model =
      typeof responseBody.model === 'string' && responseBody.model.length > 0
        ? responseBody.model
        : this.#options.model;

    return {
      // A malformed model payload stays a string so schema validation (and the
      // existing single repair attempt) owns the failure, not the transport.
      output: typeof content === 'string' ? parseJsonOrRaw(content) : '',
      usage,
      model,
      provider: this.#options.provider,
      latencyMs,
    };
  }

  #messages(request: LlmCompleteRequest): ChatMessage[] {
    // FU-54: the shared builder PolicyLlm reserves against (prompt file plus the
    // output contract generated from the schema registry, then the user input).
    const messages = buildStructuredMessages(request);
    for (const message of messages) assertRedactInputSize(message.content);
    return [...messages];
  }

  #body(messages: readonly ChatMessage[], jsonMode: boolean, maxTokens: number): ChatRequestBody {
    return {
      model: this.#options.model,
      messages,
      ...(this.#options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: this.#options.reasoningEffort }),
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
      max_tokens: maxTokens,
    };
  }

  /** Stable, truncated HMAC of owner + intake session; never raw ids or the key. */
  #sessionId(request: LlmCompleteRequest): string | undefined {
    if (this.#options.sessionHeader === 'off') return undefined;
    if (!isOpencodeHost(this.#options.baseUrl)) return undefined;
    if (request.ownerId === undefined || request.sessionKey === undefined) return undefined;
    return createHmac('sha256', this.#options.sessionSecret)
      .update(`${request.ownerId}:${request.sessionKey}`)
      .digest('hex')
      .slice(0, 32);
  }

  async #send(
    body: ChatRequestBody,
    outerSignal: AbortSignal | undefined,
    sessionId: string | undefined,
    onDispatch: (() => void) | undefined,
    timeoutMs: number,
  ): Promise<ChatResponseBody> {
    let attempt = 0;
    for (;;) {
      // M6-01: every network attempt carries the prompt off the machine.
      onDispatch?.();
      const result = await this.#once(body, outerSignal, sessionId, timeoutMs);
      if (result.ok) return result.body;
      if (result.retryable && attempt < this.#options.maxRetries) {
        attempt += 1;
        const ceiling = this.#options.backoffBaseMs * 2 ** (attempt - 1);
        const jitter = 0.5 + this.#options.random();
        await this.#options.sleep(Math.round(ceiling * jitter));
        continue;
      }
      throw result.error;
    }
  }

  async #once(
    body: ChatRequestBody,
    outerSignal: AbortSignal | undefined,
    sessionId: string | undefined,
    timeoutMs: number,
  ): Promise<
    | { readonly ok: true; readonly body: ChatResponseBody }
    | { readonly ok: false; readonly retryable: boolean; readonly error: LlmUnavailable }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    const onAbort = (): void => controller.abort('caller');
    if (outerSignal?.aborted === true) controller.abort('caller');
    else outerSignal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.#options.fetch(`${this.#options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // The key stays in this header only; it is never in the body or an error.
          authorization: `Bearer ${this.#options.apiKey}`,
          ...(sessionId === undefined ? {} : { 'x-opencode-session': sessionId }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();

      if (!response.ok) {
        const status = response.status;
        if (isResponseFormatRejection(status, text)) {
          return {
            ok: false,
            retryable: false,
            error: new ResponseFormatUnsupportedError(
              `provider rejected response_format (HTTP ${String(status)})`,
            ),
          };
        }
        if (status === 429 || status >= 500) {
          return {
            ok: false,
            retryable: true,
            error: new GatewayError(status, classifyGatewayError(status, text)),
          };
        }
        const classification = classifyGatewayError(status, text);
        return {
          ok: false,
          retryable: false,
          error:
            classification === 'missing_session'
              ? new MissingSessionIdError(status)
              : new GatewayError(status, classification),
        };
      }

      try {
        return { ok: true, body: JSON.parse(text) as ChatResponseBody };
      } catch {
        return {
          ok: false,
          retryable: false,
          error: new LlmUnavailable('llm provider returned a non-JSON response', 'provider', false),
        };
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (outerSignal?.aborted === true) {
          return {
            ok: false,
            retryable: false,
            error: new LlmUnavailable('llm call aborted by caller', 'aborted', false),
          };
        }
        throw new LlmTimeoutError(timeoutMs);
      }
      if (error instanceof LlmUnavailable) throw error;
      return {
        ok: false,
        retryable: false,
        error: new LlmUnavailable('llm provider request failed', 'provider', false),
      };
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }

  #usageOrThrow(usage: ChatResponseBody['usage']): LlmUsage {
    const inputTokens = usage?.prompt_tokens;
    const outputTokens = usage?.completion_tokens;
    const cachedInputTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens) || !isTokenCount(cachedInputTokens)) {
      throw new LlmUnavailable(
        'llm provider response missing or invalid usage',
        'provider',
        false,
      );
    }
    if (cachedInputTokens > inputTokens) {
      throw new LlmUnavailable(
        'llm provider response cached tokens exceed prompt tokens',
        'provider',
        false,
      );
    }
    const billedInput = inputTokens - cachedInputTokens;
    const costUsd =
      (billedInput * this.#options.pricing.inputUsd +
        cachedInputTokens * this.#options.pricing.cachedInputUsd +
        outputTokens * this.#options.pricing.outputUsd) /
      1_000_000;
    return {
      inputTokens,
      outputTokens,
      ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
      costUsd,
    };
  }
}

function parseJsonOrRaw(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
