import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { SCHEMA_SOURCES } from '../src/schemas.generated.js';
import {
  PROMPT_SCHEMA_IDS,
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
  // CAL-02: natural-language commitment entry.
  'llm.commitment_parse.v1',
  'llm.decomposition.v1',
  'llm.decomposition.v2',
  'llm.layout_suggestion.v1',
  'llm.questions.v1',
  'llm.replan_explanation.v1',
  // CAL-05: natural-language task entry.
  'llm.task_parse.v1',
  'llm.type_detection.v1',
];

test('all eight contract schemas are registered (six + CAL-02 commitment_parse + CAL-05 task_parse)', () => {
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
    'llm.commitment_parse.v1.json',
    'llm.task_parse.v1.json',
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
    'llm.commitment_parse.v1.json',
    'llm.task_parse.v1.json',
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
    'commitment_parse@v1',
    'decomposition@v1',
    'decomposition@v2',
    'decomposition@v3',
    'decomposition@v4',
    'layout_suggestion@v1',
    'questions@v1',
    'replan_explanation@v1',
    'task_parse@v1',
    'type_detection@v1',
    'type_detection@v2',
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
  // Every checked-in file, including the FU-89 versions, is registered verbatim.
  const files = readdirSync(PROMPT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((dir) =>
      readdirSync(join(PROMPT_DIR, dir.name))
        .filter((file) => file.endsWith('.md'))
        .map((file) => ({ id: dir.name, version: file.slice(0, -3) })),
    );
  expect(files.map((file) => `${file.id}@${file.version}`).sort()).toEqual([...listPromptKeys()]);
  for (const file of files) {
    expect(getPrompt(file.id, file.version)).toBe(readFileSync(join(PROMPT_DIR, file.id, `${file.version}.md`), 'utf8'));
  }
});

/**
 * FU-89: released prompt versions are never edited in place. SHA-256 of each
 * released file (and of its registered text) as of the FU-89 base commit 02129fe.
 */
const RELEASED_PROMPT_SHA256: Readonly<Record<string, string>> = {
  'decomposition@v1': '8e18ea3c3c9ac9fa489c37d77659bfb882233757e79ca4ff1309c0180516e701',
  'decomposition@v2': '2525c09a8ef8af108a7528088b80c004e17a05be441211a7a51860cb55780d73',
  'layout_suggestion@v1': 'fc19c06a22b039f2ae753e082f4658187df47745fcc7a742057304893d2583c9',
  'questions@v1': '180c51134a34b7263a705434f1cbe8b4497c81acb09570259961d2eab7dd6499',
  'replan_explanation@v1': '2724c66019c0640704a7b247c80340e7dc134ed5e716cc9488be3309d48c0ff2',
  'type_detection@v1': 'ab713e45d7d9b9ff228788e3662a996fb557b62df2fb96d51a12fe7f6c601a46',
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

test('released prompt versions are unchanged byte for byte (FU-89)', () => {
  for (const [key, digest] of Object.entries(RELEASED_PROMPT_SHA256)) {
    const [id, version] = key.split('@') as [string, string];
    expect({ key, file: sha256(readFileSync(join(PROMPT_DIR, id, `${version}.md`), 'utf8')) }).toEqual({ key, file: digest });
    expect({ key, registered: sha256(getPrompt(id, version)) }).toEqual({ key, registered: digest });
  }
});

/** FU-89 output-language versions and the version they extend. */
const LANGUAGE_VERSIONS = [
  { key: 'type_detection@v2', extends: 'type_detection@v1', schemaId: 'llm.type_detection.v1', fields: ['`reasons`'] },
  {
    key: 'decomposition@v3',
    extends: 'decomposition@v1',
    schemaId: 'llm.decomposition.v1',
    fields: ['`title`', '`deliverable`', '`doneCriteria`', '`assumptions`', '`questionsRemaining`'],
  },
  {
    key: 'decomposition@v4',
    extends: 'decomposition@v2',
    schemaId: 'llm.decomposition.v2',
    fields: ['`title`', '`deliverable`', '`doneCriteria`', '`assumptions`', '`questionsRemaining`', '`statement`'],
  },
] as const;

test.each(LANGUAGE_VERSIONS)('$key states the output-language rule and keeps the $schemaId contract', (entry) => {
  const [id, version] = entry.key.split('@') as [string, string];
  const [, baseVersion] = entry.extends.split('@') as [string, string];
  const text = getPrompt(id, version);
  expect(text).toContain('# Output language');
  expect(text).toContain('`outputLanguage` is a BCP-47 language tag');
  for (const field of entry.fields) expect({ field, stated: text.includes(field) }).toEqual({ field, stated: true });
  expect(text).toContain('never\n  translate them');
  expect(text).toContain('Do not translate quoted user content');
  // Same output schema as the version it extends; the rules of that version are kept.
  expect(PROMPT_SCHEMA_IDS[entry.key]).toBe(entry.schemaId);
  expect(PROMPT_SCHEMA_IDS[entry.extends]).toBe(entry.schemaId);
  expect(text).toContain(`\`${entry.schemaId}\``);
  const baseRules = getPrompt(id, baseVersion)
    .split('\n')
    .filter((line) => line.startsWith('- ') && !line.includes('Return JSON'));
  for (const rule of baseRules) expect({ rule, kept: text.includes(rule) }).toEqual({ rule, kept: true });
});

test('the released versions carry no output-language rule (negative)', () => {
  for (const key of Object.keys(RELEASED_PROMPT_SHA256)) {
    const [id, version] = key.split('@') as [string, string];
    expect({ key, rule: getPrompt(id, version).includes('outputLanguage') }).toEqual({ key, rule: false });
  }
});

test('every registered prompt has exactly one explicit output schema', () => {
  expect(Object.keys(PROMPT_SCHEMA_IDS).sort()).toEqual([...listPromptKeys()]);
  for (const schemaId of Object.values(PROMPT_SCHEMA_IDS)) expect(hasSchema(schemaId)).toBe(true);
  expect(Object.isFrozen(PROMPT_SCHEMA_IDS)).toBe(true);
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
