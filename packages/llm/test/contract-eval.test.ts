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
import {
  CONTRACT_SMOKE_INPUTS,
  matchesOutputLanguage,
  runContractSmoke,
  smokeOutputLanguage,
  summarizeContractOutcomes,
  userFacingStrings,
} from '../src/contract-eval.js';

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

describe('FU-89 output-language inputs', () => {
  const LANGUAGE_KEYS = [
    ['type_detection@v2', 'type_detection@v1'],
    ['decomposition@v3', 'decomposition@v1'],
    ['decomposition@v4', 'decomposition@v2'],
  ] as const;

  test.each(LANGUAGE_KEYS)('%s sends the %s input plus outputLanguage right after configVersion', (key, base) => {
    for (let index = 0; index < 6; index += 1) {
      const input = (CONTRACT_SMOKE_INPUTS[key] as (i: number) => Record<string, unknown>)(index);
      const previous = (CONTRACT_SMOKE_INPUTS[base] as (i: number) => Record<string, unknown>)(index);
      expect(Object.keys(input).slice(0, 2)).toEqual(['configVersion', 'outputLanguage']);
      expect(input['outputLanguage']).toBe(smokeOutputLanguage(index));
      const rest = Object.fromEntries(Object.entries(input).filter(([name]) => name !== 'outputLanguage'));
      expect(rest).toEqual(previous);
    }
  });

  test('the runs cover an English task in Korean, a Korean task in Korean and English output', () => {
    expect([0, 1, 2, 3, 4, 5].map(smokeOutputLanguage)).toEqual(['ko-KR', 'ko-KR', 'en', 'ko-KR', 'ko-KR', 'en']);
  });

  test('the older versions never carry outputLanguage (negative)', () => {
    for (const key of ['type_detection@v1', 'decomposition@v1', 'decomposition@v2', 'questions@v1']) {
      expect(JSON.stringify((CONTRACT_SMOKE_INPUTS[key] as (i: number) => unknown)(0))).not.toContain('outputLanguage');
    }
  });

  test('the language check judges the whole output by dominant script', () => {
    const draft = (title: string, statement?: string) => ({
      steps: [{ key: 's1', title, deliverable: '', doneCriteria: '', kind: 'work' }],
      assumptions: [],
      questionsRemaining: [],
      ...(statement === undefined ? {} : { evidence: [{ statement }] }),
    });
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('학회 발표 자료 준비'), 'ko-KR')).toBe(true);
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('Prepare the slides'), 'ko-KR')).toBe(false);
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('Prepare the slides'), 'en')).toBe(true);
    // A quoted Korean title inside an English draft keeps it English.
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('Draft the outline for 학회 발표'), 'en')).toBe(true);
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('발표 자료 준비하기'), 'en-US')).toBe(false);
    expect(matchesOutputLanguage('llm.decomposition.v2', draft('Q3', '노트에 적힌 마감일'), 'ko')).toBe(true);
    expect(matchesOutputLanguage('llm.type_detection.v1', { reasons: ['새 유형'] }, 'ko-KR')).toBe(true);
    // Nothing to judge, or a language the heuristic does not cover.
    expect(matchesOutputLanguage('llm.type_detection.v1', { reasons: [] }, 'ko-KR')).toBeNull();
    expect(matchesOutputLanguage('llm.decomposition.v1', draft('Préparer'), 'fr')).toBeNull();
    expect(userFacingStrings('llm.layout_suggestion.v1', { reason: 'x' })).toEqual([]);
  });

  test('language counts are reported per prompt and never change the verdict', async () => {
    const korean = {
      steps: [
        { key: 's1', title: '자료 모으기', deliverable: '자료 목록', doneCriteria: '모두 모음', kind: 'prep', estimate: { p50Minutes: 30, p90Minutes: 60 }, dependsOn: [], splittable: false },
        { key: 's2', title: '검토하기', deliverable: '검토 결과', doneCriteria: '검토 완료', kind: 'review', estimate: { p50Minutes: 30, p90Minutes: 60 }, dependsOn: ['s1'], splittable: false },
      ],
      assumptions: [],
      questionsRemaining: [],
    };
    const port = new FakeLlm();
    for (let index = 0; index < 3; index += 1) {
      const build = (key: string): unknown => (CONTRACT_SMOKE_INPUTS[key] as (i: number) => unknown)(index);
      port.addFixture({ promptId: 'decomposition', input: build('decomposition@v1'), response: { output: exampleForSchema('llm.decomposition.v1') } });
      port.addFixture({ promptId: 'decomposition', input: build('decomposition@v3'), response: { output: korean } });
    }
    const summary = await runContractSmoke({
      port,
      guard: guard(),
      runsPerPrompt: 3,
      promptKeys: ['decomposition@v1', 'decomposition@v3'],
    });
    expect(summary).toMatchObject({ verdict: 'pass', exitCode: 0 });
    // v1 sends no outputLanguage: nothing judged. v3 runs ko-KR, ko-KR, en.
    expect(summary.prompts.find((stats) => stats.prompt === 'decomposition@v1')).toMatchObject({
      languageChecked: 0,
      languageMismatched: 0,
    });
    expect(summary.prompts.find((stats) => stats.prompt === 'decomposition@v3')).toMatchObject({
      schemaId: 'llm.decomposition.v1',
      valid: 3,
      languageChecked: 3,
      languageMismatched: 1,
    });
    expect(port.calls.filter((call) => call.version === 'v3').map((call) => call.schemaId)).toEqual([
      'llm.decomposition.v1',
      'llm.decomposition.v1',
      'llm.decomposition.v1',
    ]);
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
