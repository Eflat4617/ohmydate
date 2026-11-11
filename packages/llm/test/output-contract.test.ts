/**
 * M6-01 fix round 1 addendum: every structured prompt carries the output contract
 * generated from the schema registry (field list + minimal valid example).
 */

import {
  SCHEMA_IDS,
  appendValidationErrors,
  exampleForPattern,
  exampleForSchema,
  getPrompt,
  hasSchema,
  listPromptKeys,
  renderOutputContract,
  schemaIdForPrompt,
  structuredSystemPrompt,
  validateOutput,
} from '../src/index.js';
import { SCHEMA_SOURCES } from '../src/schemas.generated.js';

type Node = Readonly<Record<string, unknown>>;

/** Independent walker: every required property path and every enum value. */
function requiredPathsAndEnums(schemaId: string): { paths: string[]; enums: unknown[] } {
  const root = SCHEMA_SOURCES[schemaId] as Node;
  const defs = (root['$defs'] ?? {}) as Readonly<Record<string, Node>>;
  const paths: string[] = [];
  const enums: unknown[] = [];
  const deref = (node: Node): Node => {
    const ref = node['$ref'];
    return typeof ref === 'string' ? (defs[ref.replace('#/$defs/', '')] as Node) : node;
  };
  const visit = (raw: Node, path: string): void => {
    const node = deref(raw);
    if (Array.isArray(node['enum'])) enums.push(...(node['enum'] as unknown[]));
    if (node['items'] !== undefined) visit(node['items'] as Node, `${path}[]`);
    const properties = (node['properties'] ?? {}) as Readonly<Record<string, Node>>;
    const required = new Set((node['required'] ?? []) as string[]);
    for (const [name, child] of Object.entries(properties)) {
      const childPath = path.length === 0 ? name : `${path}.${name}`;
      if (required.has(name)) paths.push(childPath);
      visit(child, childPath);
    }
  };
  visit(root, '');
  return { paths, enums };
}

const prompts = listPromptKeys().map((key) => {
  const [promptId, version] = key.split('@') as [string, string];
  return { key, promptId, version, schemaId: schemaIdForPrompt(promptId, version) };
});

describe('generated output contract', () => {
  test('every registered prompt maps to a registered schema and every schema has a prompt', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(6);
    for (const prompt of prompts) {
      expect({ prompt: prompt.key, schema: hasSchema(prompt.schemaId) }).toEqual({ prompt: prompt.key, schema: true });
    }
    expect([...new Set(prompts.map((prompt) => prompt.schemaId))].sort()).toEqual([...SCHEMA_IDS]);
  });

  test.each(prompts)('$key: the system prompt states every required path, enum value and a valid example', (prompt) => {
    const system = structuredSystemPrompt(prompt.promptId, prompt.version, prompt.schemaId);
    expect(system.startsWith(getPrompt(prompt.promptId, prompt.version).trimEnd())).toBe(true);
    expect(system).toContain(`# Output contract (${prompt.schemaId})`);
    const { paths, enums } = requiredPathsAndEnums(prompt.schemaId);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect({ path, stated: system.includes(`- \`${path}\` (required)`) }).toEqual({ path, stated: true });
    }
    for (const value of enums) {
      expect({ value, stated: system.includes(JSON.stringify(value)) }).toEqual({ value, stated: true });
    }
    const example = exampleForSchema(prompt.schemaId);
    expect(validateOutput(prompt.schemaId, example)).toMatchObject({ valid: true });
    expect(system).toContain(JSON.stringify(example));
  });

  test('decomposition states the exact nested step shape the live model got wrong', () => {
    const contract = renderOutputContract('llm.decomposition.v2');
    for (const line of [
      '- `steps[].deliverable` (required): string, at most 300 characters',
      '- `steps[].doneCriteria` (required): string, at most 300 characters',
      '- `steps[].kind` (required): one of "prep", "work", "review", "buffer"',
      '- `steps[].estimate` (required): object, no other keys',
      '- `steps[].estimate.p50Minutes` (required): integer, 5 to 2400',
      '- `steps[].splittable` (required): boolean (true or false)',
      '- `evidence[].stepKeys[]` (each item): string, matching /^s[0-9]{1,2}$/',
    ]) {
      expect(contract).toContain(line);
    }
    expect(contract).toContain('Do not add, rename, flatten or omit');
    // Bounded so it does not dominate the prompt budget.
    expect(contract.length).toBeLessThan(6_000);
  });

  test('optional properties are marked optional and examples omit them', () => {
    const contract = renderOutputContract('llm.type_detection.v1');
    expect(contract).toContain('- `templateId` (optional): string, at most 120 characters');
    expect(exampleForSchema('llm.type_detection.v1')).not.toHaveProperty('templateId');
  });

  test('examples are fresh copies and rendering is deterministic', () => {
    const first = exampleForSchema('llm.decomposition.v1') as { steps: unknown[] };
    first.steps.push('mutated');
    expect((exampleForSchema('llm.decomposition.v1') as { steps: unknown[] }).steps).toHaveLength(1);
    expect(renderOutputContract('llm.decomposition.v1')).toBe(renderOutputContract('llm.decomposition.v1'));
  });

  test('pattern examples match their pattern; unsupported patterns fail loudly', () => {
    for (const pattern of ['^s[0-9]{1,2}$', '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}$', '^ab?c+\\.d{2}$']) {
      expect(new RegExp(pattern).test(exampleForPattern(pattern))).toBe(true);
    }
    for (const pattern of ['^(a|b)$', '^[^x]$', '^a.b$']) {
      expect(() => exampleForPattern(pattern)).toThrow(/unsupported pattern/);
    }
    expect(() => renderOutputContract('llm.missing.v1')).toThrow();
  });

  test('the repair input carries the validation errors and the rendered contract', () => {
    const repaired = appendValidationErrors({ task: 1 }, ['/ must be object'], 'llm.decomposition.v2') as Record<
      string,
      unknown
    >;
    expect(repaired).toEqual({
      task: 1,
      schemaValidationErrors: ['/ must be object'],
      outputContract: renderOutputContract('llm.decomposition.v2'),
    });
    // Without a schema id (legacy callers) only the errors are appended.
    expect(appendValidationErrors({ task: 1 }, ['x'])).toEqual({ task: 1, schemaValidationErrors: ['x'] });
    expect(appendValidationErrors({ task: 1 }, ['x'], 'llm.unknown.v9')).toEqual({ task: 1, schemaValidationErrors: ['x'] });
  });
});
