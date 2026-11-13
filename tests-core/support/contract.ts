import {
  ProblemSchema,
  dailyRoutes,
  integrationRoutes,
  notesRoutes,
  planningRoutes,
  registerIanaTimeZoneFormat,
  replanningRoutes,
  routes,
  type RouteDefinition,
} from '@ohmydate/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import type { CoreResponse } from './core.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => unknown;

/** Every operation of the contract (`packages/contracts`), all route groups. */
export const contractRoutes: readonly RouteDefinition[] = [
  ...routes,
  ...planningRoutes,
  ...dailyRoutes,
  ...replanningRoutes,
  ...notesRoutes,
  ...integrationRoutes,
];

export const API_PREFIX = '/api/v1';

/** A syntactically valid id that names nothing. */
export const UNKNOWN_ID = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
registerIanaTimeZoneFormat(ajv);
const compiled = new WeakMap<object, ValidateFunction>();

/** Compiles a contract schema the same way the TypeScript API tests do. */
export function validatorFor(schema: object): ValidateFunction {
  let validate = compiled.get(schema);
  if (validate === undefined) {
    // `$id` values repeat across compiled schemas; strip them like the API does.
    validate = ajv.compile(JSON.parse(JSON.stringify(schema, (key, value: unknown) =>
      key === '$id' ? undefined : value,
    )) as object);
    compiled.set(schema, validate);
  }
  return validate;
}

export function routeById(operationId: string): RouteDefinition {
  const route = contractRoutes.find((entry) => entry.operationId === operationId);
  if (route === undefined) throw new Error(`operation ${operationId} is not in the contract`);
  return route;
}

export function requiredHeaders(route: RouteDefinition): readonly string[] {
  const headers = route.headers as { readonly required?: readonly string[] } | undefined;
  return headers?.required ?? [];
}

export function declaredStatuses(route: RouteDefinition): readonly number[] {
  return Object.keys(route.responses).map(Number);
}

/** `/tasks/{id}:complete` with `{id: 'x'}` → `/api/v1/tasks/x:complete`. */
export function concretePath(
  route: RouteDefinition,
  params: Readonly<Record<string, string>> = {},
): string {
  const path = route.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    return params[name] ?? UNKNOWN_ID;
  });
  return `${API_PREFIX}${path}`;
}

function describeResponse(route: RouteDefinition, response: CoreResponse): string {
  return `${route.operationId} answered ${response.status}: ${JSON.stringify(response.body)}`;
}

/** The status must be one the contract declares for this operation. */
export function expectDeclared(route: RouteDefinition, response: CoreResponse): void {
  expect(
    declaredStatuses(route).includes(response.status),
    `${describeResponse(route, response)} — not a declared status (${declaredStatuses(route).join(', ')})`,
  ).toBe(true);
}

/**
 * A problem response as the contract defines it: declared status,
 * `application/problem+json`, a body matching the Problem schema, the given
 * code, and a trace id that equals the `x-trace-id` header.
 */
export function expectProblem(
  route: RouteDefinition,
  response: CoreResponse,
  status: number,
  code: string,
): void {
  expect(response.status, describeResponse(route, response)).toBe(status);
  expectDeclared(route, response);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const validate = validatorFor(ProblemSchema);
  expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
  const body = response.body as { code: string; status: number; traceId?: unknown };
  expect(body.code).toBe(code);
  expect(body.status).toBe(status);
  expect(typeof body.traceId).toBe('string');
  expect(response.headers.get('x-trace-id')).toBe(body.traceId);
}

/** A success response: declared status and a body matching its contract schema. */
export function expectSuccess(
  route: RouteDefinition,
  response: CoreResponse,
  status: number,
): void {
  expect(response.status, describeResponse(route, response)).toBe(status);
  expectDeclared(route, response);
  const schema = route.responses[status]?.schema;
  if (schema === undefined) {
    expect(response.body, `${route.operationId} ${status} must have no body`).toBeUndefined();
    return;
  }
  expect(response.headers.get('content-type')).toContain('application/json');
  const validate = validatorFor(schema);
  expect(validate(response.body), JSON.stringify(validate.errors)).toBe(true);
}
