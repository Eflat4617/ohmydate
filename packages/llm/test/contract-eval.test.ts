/**
 * M6-01 fix round 1 addendum: live contract smoke core, exercised with FakeLlm only.
 */

import {
  BudgetGuard,
  FakeLlm,
  GatewayError,
  LlmUnavailable,
  appendValidationErrors,
  assertRedactInputSize,
  exampleForSchema,
  listPromptKeys,
  redact,
  schemaIdForPrompt,
  validateOutput,
  type FakeLlmResponse,
} from '../src/index.js';
import { CONTRACT_SMOKE_INPUTS, runContractSmoke, summarizeContractOutcomes } from '../src/contract-eval.js';

const RUNS = 2;

function guard(): BudgetGuard {
  return new BudgetGuard({ dailyUsd: 1, monthlyUsd: 1 }, { allowUnpricedModels: ['fake-llm'] });
}

/** Exact fixtures for every planned call; `override` replaces the response for one prompt. */
function fakeFor(override?: { prompt: string; response: (input: unknown, index: number) => FakeLlmResponse }): FakeLlm {
  const llm = new FakeLlm();
  for (const prompt of listPromptKeys()) {
    const [promptId, version] = prompt.split('@') as [string, string];
    const schemaId = schemaIdForPrompt(promptId, version);
    for (let index = 0; index < RUNS; index += 1) {
      const input = (CONTRACT_SMOKE_INPUTS[prompt] as (i: number) => unknown)(index);
      const response =
        override?.prompt === prompt
          ? override.response(input, index)
          : { output: exampleForSchema(schemaId), usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 } };
      llm.addFixture({ promptId, input, response });
    }
  }
  return llm;
}

function clock(step = 10): () => number {
  let now = 0;
  return () => (now += step);
}

describe('contract smoke inputs', () => {
  test('every registered prompt has a deterministic, benign synthetic input', () => {
    expect(Object.keys(CONTRACT_SMOKE_INPUTS).sort()).toEqual([...listPromptKeys()]);
    for (const [prompt, build] of Object.entries(CONTRACT_SMOKE_INPUTS)) {
      for (let index = 0; index < 5; index += 1) {
        const text = JSON.stringify(build(index));
        expect(JSON.stringify(build(index))).toBe(text);
        assertRedactInputSize(text);
        expect({ prompt, redactions: redact(text).report }).toEqual({ prompt, redactions: [] });
      }
    }
  });
});

describe('runContractSmoke', () => {
  test('all schema-valid answers pass (exit 0) with per-prompt metadata', async () => {
    const summary = await runContractSmoke({ port: fakeFor(), guard: guard(), runsPerPrompt: RUNS, now: clock() });
    expect(summary).toMatchObject({ verdict: 'pass', exitCode: 0, invalid: 0, errored: 0, notRun: 0 });
    expect(summary.planned).toBe(listPromptKeys().length * RUNS);
    for (const stats of summary.prompts) {
      expect(stats).toMatchObject({ planned: RUNS, valid: RUNS, validRate: 1, attempts: RUNS, repairs: 0 });
      expect(stats.inputTokens).toBe(100 * RUNS);
      expect(stats.latencyMsP50).toBe(10);
    }
    // Metadata only: no model output or prompt text in the summary.
    expect(JSON.stringify(summary)).not.toContain('deliverable');
  });

  test('a repaired answer is valid with one repair; a persistently invalid one fails (exit 1)', async () => {
    const decomposition = 'decomposition@v1';
    const repaired = fakeFor();
    const flat = { steps: [{ key: 's1', title: 'x', description: 'y', p50Minutes: 30 }] };
    const errors = validateOutput('llm.decomposition.v1', flat).errors;
    for (let index = 0; index < RUNS; index += 1) {
      const input = (CONTRACT_SMOKE_INPUTS[decomposition] as (i: number) => unknown)(index);
      repaired.addFixture({ promptId: 'decomposition', input, response: { output: flat } });
      repaired.addFixture({
        promptId: 'decomposition',
        input: appendValidationErrors(input, errors, 'llm.decomposition.v1'),
        response: { output: exampleForSchema('llm.decomposition.v1') },
      });
    }
    const ok = await runContractSmoke({ port: repaired, guard: guard(), runsPerPrompt: RUNS, promptKeys: [decomposition] });
    expect(ok).toMatchObject({ verdict: 'pass', exitCode: 0 });
    expect(ok.prompts[0]).toMatchObject({ valid: RUNS, repairs: RUNS, attempts: 2 * RUNS, validRate: 1 });

    const broken = fakeFor({ prompt: decomposition, response: () => ({ output: flat }) });
    // The repair attempt is answered with the same wrong shape.
    broken.addPromptFallback('decomposition', { output: flat });
    const bad = await runContractSmoke({ port: broken, guard: guard(), runsPerPrompt: RUNS });
    expect(bad).toMatchObject({ verdict: 'invalid', exitCode: 1, invalid: RUNS });
    expect(bad.prompts.find((stats) => stats.prompt === decomposition)).toMatchObject({ validRate: 0, invalid: RUNS });
  });

  test('outages and auth errors are inconclusive (exit 3) with error codes, not invalid', async () => {
    const outage = await runContractSmoke({
      port: fakeFor({ prompt: 'type_detection@v1', response: () => ({ error: new LlmUnavailable('outage', 'provider', false) }) }),
      guard: guard(),
      runsPerPrompt: RUNS,
    });
    expect(outage).toMatchObject({ verdict: 'inconclusive', exitCode: 3, errored: RUNS, invalid: 0 });
    expect(outage.prompts.find((stats) => stats.prompt === 'type_detection@v1')?.errorCodes).toEqual({
      llm_unavailable: RUNS,
    });
    const auth = await runContractSmoke({
      port: fakeFor({ prompt: 'decomposition@v2', response: () => ({ error: new GatewayError(401, 'auth') }) }),
      guard: guard(),
      runsPerPrompt: 1,
    });
    expect(auth).toMatchObject({ verdict: 'inconclusive', exitCode: 3 });
  });

  test('an exhausted budget stops the run; the remaining calls are not run', async () => {
    const tight = new BudgetGuard({ dailyUsd: 0.001, monthlyUsd: 0.001 });
    const port = fakeFor({
      prompt: listPromptKeys()[0] as string,
      response: (_input, index) => ({
        output: exampleForSchema(schemaIdForPrompt(...((listPromptKeys()[0] as string).split('@') as [string, string]))),
        usage: { inputTokens: 1, outputTokens: 1, costUsd: index === 0 ? 0.002 : 0 },
      }),
    });
    const summary = await runContractSmoke({ port, guard: tight, runsPerPrompt: RUNS });
    expect(summary).toMatchObject({ verdict: 'inconclusive', exitCode: 3, valid: 1, errored: 1 });
    expect(summary.notRun).toBe(listPromptKeys().length * RUNS - 2);
    expect(port.callCount).toBe(1);
  });

  test('summary edge cases and argument bounds', async () => {
    expect(summarizeContractOutcomes([])).toMatchObject({ verdict: 'inconclusive', exitCode: 3 });
    await expect(runContractSmoke({ port: fakeFor(), guard: guard(), runsPerPrompt: 0 })).rejects.toThrow(RangeError);
    await expect(
      runContractSmoke({ port: fakeFor(), guard: guard(), runsPerPrompt: 1, promptKeys: ['nope@v1'] }),
    ).rejects.toThrow(/no synthetic contract input/);
  });
});
