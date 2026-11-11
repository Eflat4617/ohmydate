import { LlmUnavailable } from './errors.js';
import type { LlmCompleteRequest, LlmCompleteResponse, LlmPort, LlmUsage } from './port.js';

/**
 * Deterministic, fixture-driven LLM used by every test (ADR-008).
 * Fixtures are keyed by `promptId + hash(input)`; calls are recorded for assertions.
 */

export interface FakeLlmResponse {
  readonly output?: unknown;
  readonly error?: Error;
  readonly usage?: Partial<LlmUsage>;
  readonly model?: string;
  readonly latencyMs?: number;
}

export interface FakeLlmFixture {
  readonly promptId: string;
  readonly input: unknown;
  readonly response: FakeLlmResponse;
}

export interface FakeLlmCall {
  readonly index: number;
  readonly promptId: string;
  readonly version: string;
  readonly schemaId: string;
  readonly inputHash: string;
  /** The exact input object, only when the fake was built with `recordInputs`. */
  readonly input?: unknown;
}

export interface FakeLlmOptions {
  /**
   * Keep each call's input for prompt-content assertions (injection tests).
   * Off by default so the dev-mode fake never retains prompt bodies.
   */
  readonly recordInputs?: boolean;
}

const encoder = new TextEncoder();
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64_MASK = 0xffffffffffffffffn;

function canonical(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'undefined') return 'undefined';
  if (type === 'number' || type === 'boolean' || type === 'bigint') return `${value}`;
  if (type === 'string') return JSON.stringify(value);
  if (type !== 'object') return JSON.stringify(String(value));

  const object = value as object;
  if (seen.has(object)) throw new Error('cannot hash a circular input');
  seen.add(object);

  let result: string;
  if (Array.isArray(object)) {
    result = `[${object.map((item) => canonical(item, seen)).join(',')}]`;
  } else if (object instanceof Date) {
    result = JSON.stringify(object.toISOString());
  } else {
    const record = object as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    result = `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], seen)}`)
      .join(',')}}`;
  }

  seen.delete(object);
  return result;
}

/** Stable 64-bit FNV-1a hash of a canonical JSON representation. */
export function hashInput(input: unknown): string {
  const text = canonical(input, new WeakSet<object>());
  let hash = FNV_OFFSET;
  for (const byte of encoder.encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & UINT64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

export function fixtureKey(promptId: string, input: unknown): string {
  return `${promptId}#${hashInput(input)}`;
}

function toUsage(usage: Partial<LlmUsage> | undefined): LlmUsage {
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  return usage?.costUsd === undefined
    ? { inputTokens, outputTokens }
    : { inputTokens, outputTokens, costUsd: usage.costUsd };
}

export class FakeLlm implements LlmPort {
  private readonly fixtures = new Map<string, FakeLlmResponse>();
  private readonly fallbacks = new Map<string, FakeLlmResponse>();
  private readonly recordInputs: boolean;
  readonly calls: FakeLlmCall[] = [];

  constructor(fixtures: readonly FakeLlmFixture[] = [], options: FakeLlmOptions = {}) {
    this.recordInputs = options.recordInputs === true;
    for (const fixture of fixtures) this.addFixture(fixture);
  }

  addFixture(fixture: FakeLlmFixture): void {
    this.fixtures.set(fixtureKey(fixture.promptId, fixture.input), fixture.response);
  }

  /**
   * Response for any input of `promptId` that has no exact fixture. Used by
   * pipeline tests whose prompt contains generated note blocks; exact-input
   * fixtures still win.
   */
  addPromptFallback(promptId: string, response: FakeLlmResponse): void {
    this.fallbacks.set(promptId, response);
  }

  get callCount(): number {
    return this.calls.length;
  }

  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    const inputHash = hashInput(request.input);
    this.calls.push({
      index: this.calls.length,
      promptId: request.promptId,
      version: request.version,
      schemaId: request.schemaId,
      inputHash,
      ...(this.recordInputs ? { input: request.input } : {}),
    });
    // Simulated provider boundary: the fake "receives" the prompt here.
    request.onDispatch?.();

    const response =
      this.fixtures.get(fixtureKey(request.promptId, request.input)) ??
      this.fallbacks.get(request.promptId);
    if (response === undefined) {
      throw new LlmUnavailable(
        `no fake fixture for ${request.promptId} (input ${inputHash})`,
      );
    }
    if (response.error !== undefined) throw response.error;

    return {
      output: response.output,
      usage: toUsage(response.usage),
      model: response.model ?? 'fake-llm',
      latencyMs: response.latencyMs ?? 0,
    };
  }
}
