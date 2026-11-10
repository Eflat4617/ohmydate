import { FakeLlm, LlmUnavailable, fixtureKey, hashInput } from '../src/index.js';

test('input hashing is order-insensitive and deterministic', () => {
  expect(hashInput({ a: 1, b: 2 })).toBe(hashInput({ b: 2, a: 1 }));
  expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
  expect(hashInput([1, 2, 3])).toBe(hashInput([1, 2, 3]));
  expect(fixtureKey('questions', { a: 1 })).toBe(`questions#${hashInput({ a: 1 })}`);
});

test('records every call with a deterministic input hash', async () => {
  const llm = new FakeLlm([
    {
      promptId: 'questions',
      input: { known: {} },
      response: { output: { questions: [] } },
    },
  ]);
  await llm.complete({
    promptId: 'questions',
    version: 'v1',
    input: { known: {} },
    schemaId: 'llm.questions.v1',
  });
  expect(llm.calls).toEqual([
    {
      index: 0,
      promptId: 'questions',
      version: 'v1',
      schemaId: 'llm.questions.v1',
      inputHash: hashInput({ known: {} }),
    },
  ]);
});

test('throws the configured fixture error', async () => {
  const llm = new FakeLlm([
    {
      promptId: 'questions',
      input: { known: {} },
      response: { error: new LlmUnavailable('fixture outage') },
    },
  ]);
  await expect(
    llm.complete({
      promptId: 'questions',
      version: 'v1',
      input: { known: {} },
      schemaId: 'llm.questions.v1',
    }),
  ).rejects.toThrow('fixture outage');
});

test('throws LlmUnavailable when no fixture matches', async () => {
  const llm = new FakeLlm();
  await expect(
    llm.complete({
      promptId: 'questions',
      version: 'v1',
      input: {},
      schemaId: 'llm.questions.v1',
    }),
  ).rejects.toBeInstanceOf(LlmUnavailable);
});

test('rejects circular inputs instead of hanging', () => {
  const value: Record<string, unknown> = {};
  value.self = value;
  expect(() => hashInput(value)).toThrow(/circular/);
});
