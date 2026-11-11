import { LlmTimeoutError, LlmUnavailable, ResponseFormatUnsupportedError } from './errors.js';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';
import { assertRedactInputSize } from './privacy.js';
import { getPrompt } from './prompt-registry.js';

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
}

interface ChatMessage {
  readonly role: 'system' | 'user';
  readonly content: string;
}

interface ChatRequestBody {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly reasoning_effort?: string;
  readonly response_format?: { readonly type: 'json_object' };
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

const STRICT_JSON_INSTRUCTION =
  '\n\nReturn only a single valid JSON object that matches the requested schema. ' +
  'Do not wrap it in Markdown fences and do not add prose outside the JSON.';

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function errorDetail(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 500) : 'no response body';
}

function isResponseFormatRejection(status: number, body: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /response_format|json_object|json mode/iu.test(body);
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
    };
  }

  /** Provider id recorded in agent_run metadata and consent records. */
  get providerId(): string {
    return this.#options.provider;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const startedAt = this.#options.now();
    const messages = this.#messages(request);
    const body = this.#body(messages, true);

    let responseBody: ChatResponseBody;
    try {
      responseBody = await this.#send(body, request.signal);
    } catch (error) {
      if (!(error instanceof ResponseFormatUnsupportedError)) throw error;
      // Exactly one fallback, never part of the outage retry loop.
      const fallbackMessages = messages.map((message) =>
        message.role === 'system'
          ? { ...message, content: `${message.content}${STRICT_JSON_INSTRUCTION}` }
          : message,
      );
      responseBody = await this.#send(this.#body(fallbackMessages, false), request.signal);
    }

    const latencyMs = Math.max(0, this.#options.now() - startedAt);
    const content = responseBody.choices?.[0]?.message?.content;
    const usage = this.#usage(responseBody.usage);
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
    const system = getPrompt(request.promptId, request.version);
    const user = JSON.stringify(request.input ?? {}) ?? '{}';
    assertRedactInputSize(system);
    assertRedactInputSize(user);
    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  #body(messages: readonly ChatMessage[], jsonMode: boolean): ChatRequestBody {
    return {
      model: this.#options.model,
      messages,
      ...(this.#options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: this.#options.reasoningEffort }),
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    };
  }

  async #send(body: ChatRequestBody, outerSignal: AbortSignal | undefined): Promise<ChatResponseBody> {
    let attempt = 0;
    for (;;) {
      const result = await this.#once(body, outerSignal);
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
  ): Promise<
    | { readonly ok: true; readonly body: ChatResponseBody }
    | { readonly ok: false; readonly retryable: boolean; readonly error: LlmUnavailable }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), this.#options.timeoutMs);
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
        const retryable = status === 429 || status >= 500;
        return {
          ok: false,
          retryable,
          error: new LlmUnavailable(
            `llm provider HTTP ${String(status)}: ${errorDetail(text)}`,
            'provider',
            !retryable,
          ),
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
        throw new LlmTimeoutError(this.#options.timeoutMs);
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

  #usage(usage: ChatResponseBody['usage']): LlmUsage {
    const inputTokens = finiteNonNegative(usage?.prompt_tokens);
    const outputTokens = finiteNonNegative(usage?.completion_tokens);
    const cachedInputTokens = finiteNonNegative(usage?.prompt_tokens_details?.cached_tokens);
    const billedInput = Math.max(0, inputTokens - cachedInputTokens);
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
