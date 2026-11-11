/**
 * M6-01 fix round 1 addendum: per-prompt LLM limits from config reach the provider
 * request (decomposition 8000 tokens / 120 s), type_detection keeps its values.
 */

import type { IntakeInput, IntakeSessionDto } from '@ohmydate/contracts';
import {
  BudgetGuard,
  FakeLlm,
  exampleForSchema,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '@ohmydate/llm';
import { DEFAULT_HTTP_CONNECTION_TIMEOUT_MS } from '../src/app.js';
import { configFromEnv, createConfig, defaultConfig, llmPromptLimits } from '../src/config.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
} from './support/test-context.js';

/** FakeLlm wrapper that also keeps each request's per-call limits. */
class LimitRecordingLlm implements LlmPort {
  readonly limits: { promptId: string; maxOutputTokens?: number; timeoutMs?: number }[] = [];
  constructor(private readonly inner: FakeLlm) {}
  complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.limits.push({
      promptId: request.promptId,
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });
    return this.inner.complete(request);
  }
}

const input: IntakeInput = {
  title: 'Quarterly report',
  deliverable: 'Write the report',
  dueAt: '2026-12-01T00:00:00.000Z',
  estimatedScope: 'medium',
  currentProgress: 0.1,
  availabilityConfirmed: true,
};

describe('LLM prompt limits configuration', () => {
  test('decomposition defaults to 8000 tokens / 120 s and parses env', () => {
    expect(defaultConfig.llmDecompositionMaxOutputTokens).toBe(8000);
    expect(defaultConfig.llmDecompositionTimeoutMs).toBe(120_000);
    expect(defaultConfig.llmMaxOutputTokens).toBe(2000);
    const env = configFromEnv({
      LLM_DECOMPOSITION_MAX_OUTPUT_TOKENS: '6000',
      LLM_DECOMPOSITION_TIMEOUT_MS: '90000',
    });
    expect(llmPromptLimits(env)).toEqual({ decomposition: { maxOutputTokens: 6000, timeoutMs: 90_000 } });
    expect(() => configFromEnv({ LLM_DECOMPOSITION_MAX_OUTPUT_TOKENS: '0' })).toThrow(/positive integer/);
    expect(() => configFromEnv({ LLM_DECOMPOSITION_MAX_OUTPUT_TOKENS: '99999' })).toThrow(/at most 32768/);
    expect(() => configFromEnv({ LLM_DECOMPOSITION_TIMEOUT_MS: 'slow' })).toThrow(/positive integer/);
  });

  test('the default socket-inactivity guard covers one decomposition attempt plus its repair', () => {
    expect(DEFAULT_HTTP_CONNECTION_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * createConfig().llmDecompositionTimeoutMs);
  });
});

describe.skipIf(!hasDatabase)('intake sends per-prompt limits to the provider', () => {
  test('decomposition carries 8000 / 120 s, type_detection carries no override', async () => {
    const fake = new FakeLlm();
    fake.addPromptFallback('type_detection', {
      output: { classification: 'new', confidence: 0.9, reasons: [], missingRequired: [] },
    });
    fake.addPromptFallback('decomposition', {
      output: {
        steps: [1, 2, 3].map((n) => ({
          key: `s${n}`,
          title: `Step ${n}`,
          deliverable: 'd',
          doneCriteria: 'c',
          kind: n === 3 ? 'review' : 'work',
          estimate: { p50Minutes: 30, p90Minutes: 60 },
          dependsOn: n === 1 ? [] : [`s${n - 1}`],
          splittable: false,
        })),
        assumptions: [],
        questionsRemaining: [],
      },
    });
    const llm = new LimitRecordingLlm(fake);
    const ctx = await createTestContext({
      llm,
      budgetGuard: new BudgetGuard({ dailyUsd: 10, monthlyUsd: 100 }, { allowUnpricedModels: ['fake-llm'] }),
    });
    try {
      await ctx.seedUser({ email: 'limits@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'limits@example.com', 'correct-horse');
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/intake-sessions',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { input },
      });
      const body = created.json() as IntakeSessionDto;
      const answered = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/intake-sessions/${body.id}/answers`,
        headers: authHeaders(session, { 'if-match': `W/"${body.version}"`, 'idempotency-key': newIdempotencyKey() }),
        payload: { answers: [{ questionKey: 'priority', action: 'answer', value: 2 }] },
      });
      expect(answered.statusCode).toBe(200);
      expect((answered.json() as IntakeSessionDto).manual).toBe(false);
      expect(llm.limits).toEqual([
        { promptId: 'type_detection' },
        { promptId: 'decomposition', maxOutputTokens: 8000, timeoutMs: 120_000 },
      ]);
      // Sanity: the generated example is a valid decomposition shape the fake could return.
      expect(exampleForSchema('llm.decomposition.v1')).toHaveProperty('steps');
    } finally {
      await ctx.close();
    }
  });
});
