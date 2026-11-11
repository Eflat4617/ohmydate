import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TSchema } from '@sinclair/typebox';
import { contractRoutes, schemaRegistry } from '../src/index.js';

const outputPath = fileURLToPath(new URL('../openapi.json', import.meta.url));

const METHOD_ORDER: Readonly<Record<string, number>> = {
  get: 0,
  post: 1,
  patch: 2,
  put: 3,
  delete: 4,
};

const nameBySchema = new Map<TSchema, string>();
for (const [name, schema] of Object.entries(schemaRegistry)) {
  nameBySchema.set(schema, name);
}

function clone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function stripIds(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) stripIds(item);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    delete record.$id;
    delete record.$schema;
    for (const key of Object.keys(record)) stripIds(record[key]);
  }
}

function schemaJson(schema: TSchema): unknown {
  return clone(schema);
}

function componentName(schema: TSchema): string | undefined {
  return nameBySchema.get(schema);
}

function schemaRefOrInline(schema: TSchema): unknown {
  const name = componentName(schema);
  return name === undefined ? schemaJson(schema) : { $ref: `#/components/schemas/${name}` };
}

interface ObjectSchemaShape {
  readonly properties?: Readonly<Record<string, TSchema>>;
  readonly required?: readonly string[];
}

function objectShape(schema: TSchema): ObjectSchemaShape {
  return schema as unknown as ObjectSchemaShape;
}

interface ParameterObject {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly schema: unknown;
}

function parametersFor(route: (typeof contractRoutes)[number]): ParameterObject[] {
  const parameters: ParameterObject[] = [];

  if (route.params !== undefined) {
    const shape = objectShape(route.params);
    for (const [name, schema] of Object.entries(shape.properties ?? {})) {
      parameters.push({ name, in: 'path', required: true, schema: schemaJson(schema) });
    }
  }

  if (route.query !== undefined) {
    const shape = objectShape(route.query);
    const required = new Set(shape.required ?? []);
    for (const [name, schema] of Object.entries(shape.properties ?? {})) {
      parameters.push({
        name,
        in: 'query',
        required: required.has(name),
        schema: schemaJson(schema),
      });
    }
  }

  if (route.headers !== undefined) {
    const shape = objectShape(route.headers);
    const required = new Set(shape.required ?? []);
    for (const [name, schema] of Object.entries(shape.properties ?? {})) {
      parameters.push({
        name,
        in: 'header',
        required: required.has(name),
        schema: schemaJson(schema),
      });
    }
  }

  return parameters;
}

function mediaTypeFor(schema: TSchema): string {
  return componentName(schema) === 'Problem' ? 'application/problem+json' : 'application/json';
}

function responsesFor(route: (typeof contractRoutes)[number]): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const [status, response] of Object.entries(route.responses)) {
    responses[status] =
      response.schema === undefined
        ? { description: response.description }
        : {
            description: response.description,
            content: {
              [mediaTypeFor(response.schema)]: { schema: schemaRefOrInline(response.schema) },
            },
          };
  }
  return responses;
}

function buildPaths(): Record<string, unknown> {
  const sorted = [...contractRoutes].sort((left, right) => {
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return (METHOD_ORDER[left.method] ?? 99) - (METHOD_ORDER[right.method] ?? 99);
  });

  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of sorted) {
    const operation: Record<string, unknown> = {
      operationId: route.operationId,
      summary: route.summary,
      responses: responsesFor(route),
    };
    if (route.description !== undefined) operation.description = route.description;

    const parameters = parametersFor(route);
    if (parameters.length > 0) operation.parameters = parameters;

    if (route.body !== undefined) {
      operation.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaRefOrInline(route.body) } },
      };
    }

    const pathItem = paths[route.path] ?? {};
    pathItem[route.method] = operation;
    paths[route.path] = pathItem;
  }

  return paths;
}

function buildComponents(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  const names = Object.keys(schemaRegistry).sort();
  for (const name of names) {
    const schema = schemaRegistry[name as keyof typeof schemaRegistry];
    const json = clone(schema);
    stripIds(json);
    schemas[name] = json;
  }
  return { schemas };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

const document = {
  openapi: '3.1.0',
  info: {
    title: 'OhMyDate API',
    version: '0.1.0',
    description: 'Adaptive AI personal planner HTTP contract generated from TypeBox schemas.',
  },
  servers: [{ url: '/api/v1' }],
  paths: buildPaths(),
  components: buildComponents(),
};

const output = `${JSON.stringify(sortKeys(document), null, 2)}\n`;
await writeFile(outputPath, output, 'utf8');
console.log(`Wrote ${outputPath}`);
