import { FakeLlm, LlmUnavailable, validateOutput } from '@ohmydate/llm';
import { ScriptedFakeLlm, scriptedFakeOutput } from '../src/adapters/scripted-fake-llm.js';
import { configFromEnv } from '../src/config.js';
import {
  AI_REQUEST_OVERHEAD_MS,
  aiCallTotalTimeoutMs,
  intakeAiRequestBoundMs,
} from '../src/application/intake/ai-runs.js';
import { DEFAULT_HTTP_CONNECTION_TIMEOUT_MS } from '../src/app.js';

const OWNER = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';

const request = (schemaId: string, promptId: string, ownerId: string, signal?: AbortSignal) => ({
  promptId,
  version: schemaId.endsWith('v2') ? 'v2' : 'v1',
  input: {},
  schemaId,
  ownerId,
  ...(signal === undefined ? {} : { signal }),
});

describe('FU-76 scripted fake LLM (E2E only)', () => {
  test('scripted outputs are schema-valid for every intake prompt', () => {
    for (const schemaId of ['llm.type_detection.v1', 'llm.decomposition.v1', 'llm.decomposition.v2']) {
      expect(validateOutput(schemaId, scriptedFakeOutput(schemaId)).valid).toBe(true);
    }
  });

  test('listed owners wait the latency then get the scripted answer; others keep plain FakeLlm', async () => {
    const llm = new ScriptedFakeLlm({ inner: new FakeLlm(), latencyMs: 30, owners: [OWNER] });
    const started = Date.now();
    const answer = await llm.complete(request('llm.decomposition.v1', 'decomposition', OWNER));
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    expect(answer.model).toBe('fake-llm');
    expect(validateOutput('llm.decomposition.v1', answer.output).valid).toBe(true);
    await expect(llm.complete(request('llm.decomposition.v1', 'decomposition', OTHER))).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
  });

  test('negative: an abort ends the wait at once as llm_unavailable(aborted)', async () => {
    const llm = new ScriptedFakeLlm({ inner: new FakeLlm(), latencyMs: 10_000, owners: [OWNER] });
    const controller = new AbortController();
    const pending = llm.complete(request('llm.decomposition.v1', 'decomposition', OWNER, controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'llm_unavailable', reason: 'aborted' });
  });

  test('config: owners and latency are parsed for fake only; real providers and bad ids are rejected', () => {
    const fake = configFromEnv({
      LLM_PROVIDER: 'fake',
      LLM_FAKE_SCRIPTED_OWNERS: ` ${OWNER} ,${OTHER}`,
      LLM_FAKE_LATENCY_MS: '5000',
    });
    expect(fake.llmFakeScriptedOwners).toEqual([OWNER, OTHER]);
    expect(fake.llmFakeLatencyMs).toBe(5000);
    expect(configFromEnv({}).llmFakeScriptedOwners).toEqual([]);
    expect(configFromEnv({}).llmFakeLatencyMs).toBe(0);
    expect(() =>
      configFromEnv({
        LLM_PROVIDER: 'deepseek',
        LLM_API_KEY_FILE: '/nonexistent/fu76-not-read.txt',
        LLM_SESSION_HEADER: 'off',
        LLM_FAKE_SCRIPTED_OWNERS: OWNER,
      }),
    ).toThrow(/only allowed with LLM_PROVIDER=fake/);
    expect(() => configFromEnv({ LLM_FAKE_SCRIPTED_OWNERS: 'not-an-id' })).toThrow(/user ids/);
    expect(() => configFromEnv({ LLM_FAKE_LATENCY_MS: '-5' })).toThrow(/non-negative/);
  });
});

describe('FU-76 effective bounds', () => {
  test('decomposition 2 x 120 s + slack; the request bound stays under the HTTP inactivity guard', () => {
    expect(aiCallTotalTimeoutMs('decomposition')).toBe(250_000);
    expect(aiCallTotalTimeoutMs('type_detection')).toBe(70_000);
    expect(intakeAiRequestBoundMs()).toBe(250_000 + AI_REQUEST_OVERHEAD_MS);
    expect(intakeAiRequestBoundMs()).toBeLessThan(DEFAULT_HTTP_CONNECTION_TIMEOUT_MS);
    // A longer configured decomposition timeout moves the bound with it.
    expect(
      intakeAiRequestBoundMs({ decomposition: { maxOutputTokens: 8000, timeoutMs: 200_000 } }),
    ).toBe(2 * 200_000 + 10_000 + AI_REQUEST_OVERHEAD_MS);
  });
});
