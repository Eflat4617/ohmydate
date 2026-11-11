import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { SCHEMA_SOURCES } from '../src/schemas.generated.js';
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
  'llm.decomposition.v2',
  'llm.layout_suggestion.v1',
  'llm.questions.v1',
  'llm.replan_explanation.v1',
  'llm.type_detection.v1',
];

test('all six contract schemas are registered', () => {
  expect(SCHEMA_IDS).toEqual(expectedSchemas);
  for (const schemaId of expectedSchemas) expect(hasSchema(schemaId)).toBe(true);
});

test('every schema file compiles under Ajv strict mode', () => {
  const files = [
    'llm.type_detection.v1.json',
    'llm.questions.v1.json',
    'llm.decomposition.v1.json',
    'llm.decomposition.v2.json',
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

test('generated schema map matches the checked-in JSON files', () => {
  const files = [
    'llm.type_detection.v1.json',
    'llm.questions.v1.json',
    'llm.decomposition.v1.json',
    'llm.decomposition.v2.json',
    'llm.replan_explanation.v1.json',
    'llm.layout_suggestion.v1.json',
  ];
  expect(Object.keys(SCHEMA_SOURCES).sort()).toEqual(expectedSchemas);
  for (const file of files) {
    const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf8')) as { $id: string };
    expect(SCHEMA_SOURCES[schema.$id]).toEqual(schema);
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
    'decomposition@v2',
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
  const v2 = readFileSync(join(PROMPT_DIR, 'decomposition', 'v2.md'), 'utf8');
  expect(getPrompt('decomposition', 'v2')).toBe(v2);
});

test('layout suggestion accepts the canonical 07 §2.1 ids plus scalar props', () => {
  const valid = {
    mode: 'focus',
    regions: {
      primary: [
        {
          component: 'FocusTimer',
          props: {
            sessionId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0001',
            limit: 1,
            enabled: true,
          },
        },
      ],
      secondary: [
        { component: 'CurrentTaskCard', props: { taskId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0002' } },
        { component: 'RelatedNotes', props: { documentId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0003', limit: 3 } },
      ],
      tertiary: [{ component: 'NextUp', props: { count: 2 } }],
    },
    pinned: ['NavRail'],
    reason: 'active_session',
    policyVersion: 'ui-policy@0.1.0',
  };
  expect(validateOutput('llm.layout_suggestion.v1', valid).valid).toBe(true);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: { primary: [{ component: 'EvilWidget' }] },
    }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: {
        primary: [
          {
            component: 'FocusTimer',
            props: { html: '<img src=x onerror=alert(1)>' },
          },
        ],
      },
    }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: { primary: [{ component: 'FocusTimer', props: { url: 'javascript:alert(1)' } }] },
    }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', { ...valid, pinned: ['UnknownNav'] }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: { primary: [{ component: 'FocusTimer', props: { style: { color: 'red' } } }] },
    }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: {
        primary: [
          { component: 'FocusTimer', props: { sessionId: 'not-a-uuid' } },
        ],
      },
    }).valid,
  ).toBe(false);

  expect(
    validateOutput('llm.layout_suggestion.v1', {
      ...valid,
      regions: {
        primary: [
          {
            component: 'FocusTimer',
            props: { widgetId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0004' },
          },
        ],
      },
    }).valid,
  ).toBe(false);
});
