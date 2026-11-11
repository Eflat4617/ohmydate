/**
 * Output contract rendered from the schema registry into every structured prompt
 * (M6-01 fix round 1 addendum). Hand-written prompt files never had to state the
 * output shape, and live models answered with a different one (flattened estimates,
 * missing required fields). The contract is generated, never hand-written:
 *
 * - a field list with every property path, type, enum, limit and required flag;
 * - one minimal valid example generated from the schema (validated in tests).
 *
 * `structuredSystemPrompt` is what adapters send as the system message and what the
 * spend policy uses for its reservation upper bound.
 */

import { getPrompt } from './prompt-registry.js';
import { SCHEMA_SOURCES } from './schemas.generated.js';
import { UnknownSchemaError } from './errors.js';

type JsonSchema = Readonly<Record<string, unknown>>;

/** Keywords the renderer/generator understand. Anything else is a loud error. */
const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$id',
  '$schema',
  '$defs',
  '$ref',
  'description',
  'title',
  'examples',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'pattern',
  'anyOf',
]);

/** Convention: prompt `<id>@<version>` is validated by schema `llm.<id>.<version>`. */
export function schemaIdForPrompt(promptId: string, version: string): string {
  return `llm.${promptId}.${version}`;
}

function rootSchema(schemaId: string): JsonSchema {
  const schema = SCHEMA_SOURCES[schemaId];
  if (schema === undefined) throw new UnknownSchemaError(schemaId);
  return schema as JsonSchema;
}

function resolve(root: JsonSchema, node: JsonSchema): JsonSchema {
  const ref = node['$ref'];
  if (typeof ref !== 'string') return node;
  const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref);
  const defs = root['$defs'] as Readonly<Record<string, JsonSchema>> | undefined;
  const target = match === null ? undefined : defs?.[match[1] as string];
  if (target === undefined) throw new Error(`unsupported $ref ${ref}`);
  return target;
}

function assertSupported(node: JsonSchema, path: string): void {
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key)) throw new Error(`unsupported schema keyword ${key} at ${path}`);
  }
}

function quoted(value: unknown): string {
  return JSON.stringify(value);
}

function describeScalar(node: JsonSchema): string {
  if (Array.isArray(node['enum'])) return `one of ${(node['enum'] as unknown[]).map(quoted).join(', ')}`;
  if (Array.isArray(node['anyOf'])) {
    return (node['anyOf'] as JsonSchema[]).map((branch) => describeScalar(branch)).join(' or ');
  }
  const type = node['type'];
  const parts: string[] = [];
  if (type === 'string') {
    parts.push('string');
    const min = node['minLength'] as number | undefined;
    const max = node['maxLength'] as number | undefined;
    if (min !== undefined && max !== undefined) parts.push(`${min}-${max} characters`);
    else if (max !== undefined) parts.push(`at most ${max} characters`);
    else if (min !== undefined) parts.push(`at least ${min} characters`);
    if (typeof node['pattern'] === 'string') parts.push(`matching /${node['pattern']}/`);
  } else if (type === 'integer' || type === 'number') {
    parts.push(type === 'integer' ? 'integer' : 'number');
    const min = node['minimum'] as number | undefined;
    const max = node['maximum'] as number | undefined;
    if (min !== undefined && max !== undefined) parts.push(`${min} to ${max}`);
    else if (min !== undefined) parts.push(`>= ${min}`);
    else if (max !== undefined) parts.push(`<= ${max}`);
  } else if (type === 'boolean') {
    parts.push('boolean (true or false)');
  } else if (type === 'null') {
    parts.push('null');
  } else if (type === 'object') {
    parts.push('object');
  } else if (type === 'array') {
    parts.push('array');
  } else {
    throw new Error(`unsupported schema type ${String(type)}`);
  }
  return parts.join(', ');
}

function describeArray(node: JsonSchema): string {
  const min = node['minItems'] as number | undefined;
  const max = node['maxItems'] as number | undefined;
  const count =
    min !== undefined && max !== undefined
      ? `${min} to ${max} items`
      : max !== undefined
        ? `at most ${max} items`
        : min !== undefined
          ? `at least ${min} items`
          : 'any number of items';
  return `array, ${count}`;
}

function renderNode(
  root: JsonSchema,
  raw: JsonSchema,
  path: string,
  required: boolean,
  lines: string[],
): void {
  const node = resolve(root, raw);
  assertSupported(node, path);
  const flag = required ? 'required' : 'optional';
  const type = node['type'];
  if (type === 'object' && !Array.isArray(node['enum'])) {
    const properties = (node['properties'] ?? {}) as Readonly<Record<string, JsonSchema>>;
    const requiredNames = new Set((node['required'] ?? []) as string[]);
    const extra = node['additionalProperties'];
    if (path.length > 0) {
      lines.push(`- \`${path}\` (${flag}): object${extra === false ? ', no other keys' : ''}`);
    }
    for (const [name, child] of Object.entries(properties)) {
      renderNode(root, child, path.length === 0 ? name : `${path}.${name}`, requiredNames.has(name), lines);
    }
    if (extra !== undefined && extra !== false) {
      const keyRule = (node['propertyNames'] as JsonSchema | undefined)?.['pattern'];
      const keyPath = path.length === 0 ? '<key>' : `${path}.<key>`;
      const keyText = typeof keyRule === 'string' ? `other keys matching /${keyRule}/` : 'other keys';
      lines.push(`- \`${keyPath}\` (optional, ${keyText}): ${describeScalar(extra as JsonSchema)}`);
    }
    return;
  }
  if (type === 'array') {
    const items = resolve(root, (node['items'] ?? {}) as JsonSchema);
    lines.push(`- \`${path}\` (${flag}): ${describeArray(node)}`);
    if (items['type'] === 'object' && !Array.isArray(items['enum'])) {
      // Every element has this shape, so its object line reads (required).
      renderNode(root, items, `${path}[]`, true, lines);
    } else {
      assertSupported(items, `${path}[]`);
      lines.push(`- \`${path}[]\` (each item): ${describeScalar(items)}`);
    }
    return;
  }
  lines.push(`- \`${path}\` (${flag}): ${describeScalar(node)}`);
}

/** Smallest string matching a simple anchored pattern (literals, classes, quantifiers). */
export function exampleForPattern(pattern: string): string {
  let index = 0;
  let out = '';
  const take = (): string => pattern[index++] as string;
  if (pattern[index] === '^') index += 1;
  while (index < pattern.length) {
    let unit: string;
    const char = take();
    if (char === '$' && index === pattern.length) break;
    if (char === '[') {
      const close = pattern.indexOf(']', index);
      if (close < 0) throw new Error(`unsupported pattern ${pattern}`);
      const body = pattern.slice(index, close);
      if (body.startsWith('^') || body.length === 0) throw new Error(`unsupported pattern ${pattern}`);
      unit = body[0] === '\\' ? (body[1] as string) : (body[0] as string);
      index = close + 1;
    } else if (char === '\\') {
      const escaped = take();
      if (/[dws]/i.test(escaped)) unit = escaped === 'd' ? '0' : escaped === 'w' ? 'a' : ' ';
      else unit = escaped;
    } else if ('()|.'.includes(char)) {
      throw new Error(`unsupported pattern ${pattern}`);
    } else {
      unit = char;
    }
    let repeat = 1;
    const next = pattern[index];
    if (next === '{') {
      const close = pattern.indexOf('}', index);
      const counts = /^\{(\d+)(?:,(\d*))?\}$/.exec(pattern.slice(index, close + 1));
      if (counts === null) throw new Error(`unsupported pattern ${pattern}`);
      repeat = Number(counts[1]);
      index = close + 1;
    } else if (next === '?' || next === '*') {
      repeat = 0;
      index += 1;
    } else if (next === '+') {
      index += 1;
    }
    out += unit.repeat(repeat);
  }
  return out;
}

function exampleNode(root: JsonSchema, raw: JsonSchema, name: string): unknown {
  const node = resolve(root, raw);
  const examples = node['examples'];
  if (Array.isArray(examples) && examples.length > 0) return examples[0];
  if (Array.isArray(node['enum'])) return (node['enum'] as unknown[])[0];
  if (Array.isArray(node['anyOf'])) return exampleNode(root, (node['anyOf'] as JsonSchema[])[0] as JsonSchema, name);
  switch (node['type']) {
    case 'object': {
      const properties = (node['properties'] ?? {}) as Readonly<Record<string, JsonSchema>>;
      const output: Record<string, unknown> = {};
      for (const key of (node['required'] ?? []) as string[]) {
        const child = properties[key];
        if (child === undefined) throw new Error(`required ${key} has no schema`);
        output[key] = exampleNode(root, child, key);
      }
      return output;
    }
    case 'array': {
      const count = (node['minItems'] as number | undefined) ?? 0;
      return Array.from({ length: count }, () => exampleNode(root, (node['items'] ?? {}) as JsonSchema, name));
    }
    case 'string': {
      if (typeof node['pattern'] === 'string') return exampleForPattern(node['pattern']);
      const min = (node['minLength'] as number | undefined) ?? 0;
      const max = (node['maxLength'] as number | undefined) ?? 1_000;
      const base = name.length > 0 ? name : 'text';
      return base.padEnd(min, 'x').slice(0, max);
    }
    case 'integer':
    case 'number':
      return (node['minimum'] as number | undefined) ?? 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    default:
      throw new Error(`cannot build an example for type ${String(node['type'])}`);
  }
}

const exampleCache = new Map<string, string>();
const contractCache = new Map<string, string>();

/** Minimal valid example for a registered schema (a fresh copy per call). */
export function exampleForSchema(schemaId: string): unknown {
  let cached = exampleCache.get(schemaId);
  if (cached === undefined) {
    const root = rootSchema(schemaId);
    cached = JSON.stringify(exampleNode(root, root, ''));
    exampleCache.set(schemaId, cached);
  }
  return JSON.parse(cached) as unknown;
}

/** The output contract section appended to every structured system prompt. */
export function renderOutputContract(schemaId: string): string {
  const cached = contractCache.get(schemaId);
  if (cached !== undefined) return cached;
  const root = rootSchema(schemaId);
  const lines: string[] = [];
  renderNode(root, root, '', true, lines);
  const contract = [
    `# Output contract (${schemaId})`,
    '',
    'Reply with exactly one JSON object that matches this contract and nothing else: no prose,',
    'no Markdown code fences, no comments, no text before or after the object.',
    '- Use exactly these property names and this nesting. Do not add, rename, flatten or omit',
    '  properties; every property marked (required) must be present, even when empty.',
    '- Respect every type, enum value and limit. Numbers are JSON numbers and booleans are',
    '  true/false, never strings.',
    '',
    'Fields:',
    ...lines,
    '',
    'Minimal valid example (shape only: replace every value with real content and add as many',
    'array items as the rules above require):',
    JSON.stringify(exampleForSchema(schemaId)),
  ].join('\n');
  contractCache.set(schemaId, contract);
  return contract;
}

/** System message for a structured call: the prompt file plus the generated contract. */
export function structuredSystemPrompt(promptId: string, version: string, schemaId: string): string {
  return `${getPrompt(promptId, version).trimEnd()}\n\n${renderOutputContract(schemaId)}\n`;
}
