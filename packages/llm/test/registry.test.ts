import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import {
  SCHEMA_IDS,
  getPrompt,
  hasPrompt,
  hasSchema,
  listPromptKeys,
  validateOutput,
} from '../src/index.js';

const SCHEMA_DIR = join(import.meta.dirname, '..', 'schemas');
const PROMPT_DIR = join(import.meta.dirname, '..', 'prompts');

const expectedSchemas = [
  'llm.decomposition.v1',
  'llm.layout_suggestion.v1',
  'llm.questions.v1',
  'llm.replan_explanation.v1',
  'llm.type_detection.v1',
];

test('all five contract schemas are registered', () => {
  expect(SCHEMA_IDS).toEqual(expectedSchemas);
  for (const schemaId of expectedSchemas) expect(hasSchema(schemaId)).toBe(true);
});

test('every schema file compiles under Ajv strict mode', () => {
  const files = [
    'llm.type_detection.v1.json',
    'llm.questions.v1.json',
    'llm.decomposition.v1.json',
    'llm.replan_explanation.v1.json',
    'llm.layout_suggestion.v1.json',
  ];
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as {
      $id: string;
    };
    const ajv = new Ajv({ allErrors: true, strict: true });
    expect(() => ajv.compile(schema)).not.toThrow();
    expect(hasSchema(schema.$id)).toBe(true);
  }
});

test('a valid decomposition passes the exact 05 §7 schema', () => {
  const value = {
    steps: [
      {
        key: 's1',
        title: 'Collect sources',
        deliverable: 'Source list',
        doneCriteria: 'At least five sources',
        kind: 'prep',
        estimate: { p50Minutes: 30, p90Minutes: 45 },
        dependsOn: [],
        splittable: true,
      },
      {
        key: 's2',
        title: 'Draft',
        deliverable: 'Draft',
        doneCriteria: 'Draft reviewed',
        kind: 'review',
        estimate: { p50Minutes: 120, p90Minutes: 180 },
        dependsOn: ['s1'],
        splittable: true,
      },
    ],
    assumptions: [],
    questionsRemaining: [],
  };
  expect(validateOutput('llm.decomposition.v1', value).valid).toBe(true);
});

test('schema-invalid output reports paths instead of throwing', () => {
  const result = validateOutput('llm.decomposition.v1', { steps: 'nope' });
  expect(result.valid).toBe(false);
  expect(result.issues.length).toBeGreaterThan(0);
  expect(result.errors.length).toBeGreaterThan(0);
});

test('additional properties are rejected', () => {
  expect(
    validateOutput('llm.replan_explanation.v1', {
      explanation: 'Moved two blocks',
      reasons: ['deadline risk'],
      unexpected: true,
    }).valid,
  ).toBe(false);
});

test('prompt files are available through the pure registry', () => {
  const keys = listPromptKeys();
  expect(keys).toEqual([
    'decomposition@v1',
    'layout_suggestion@v1',
    'questions@v1',
    'replan_explanation@v1',
    'type_detection@v1',
  ]);
  expect(hasPrompt('decomposition', 'v1')).toBe(true);
  expect(getPrompt('type_detection', 'v1')).toContain('<untrusted_document>');
  expect(() => getPrompt('missing', 'v1')).toThrow(/prompt not found/);
});

test('prompt registry matches the checked-in markdown files', () => {
  const ids = ['type_detection', 'questions', 'decomposition', 'replan_explanation', 'layout_suggestion'];
  for (const id of ids) {
    const file = readFileSync(join(PROMPT_DIR, id, 'v1.md'), 'utf8');
    expect(getPrompt(id, 'v1')).toBe(file);
  }
});
