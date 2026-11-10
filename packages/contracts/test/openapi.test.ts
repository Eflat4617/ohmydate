import { readFileSync } from 'node:fs';
import { routes } from '../src/index.js';

interface OpenApiResponse {
  readonly content?: Readonly<Record<string, unknown>>;
}

interface OpenApiOperation {
  readonly responses?: Readonly<Record<string, OpenApiResponse>>;
}

interface OpenApiDocument {
  readonly openapi: string;
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

const document = JSON.parse(
  readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'),
) as OpenApiDocument;

test('openapi document is 3.1.0 and contains every operation', () => {
  expect(document.openapi).toBe('3.1.0');
  for (const route of routes) {
    expect({
      route: route.operationId,
      present: document.paths[route.path]?.[route.method] !== undefined,
    }).toEqual({ route: route.operationId, present: true });
  }
});

test('problem responses use application/problem+json per operation', () => {
  for (const route of routes) {
    const operation = document.paths[route.path]?.[route.method];
    expect(operation).toBeDefined();
    if (operation === undefined) continue;

    for (const status of Object.keys(route.responses)) {
      const response = operation.responses?.[status];
      expect({ route: route.operationId, status, present: response !== undefined }).toEqual({
        route: route.operationId,
        status,
        present: true,
      });
      if (response === undefined) continue;

      if (Number(status) >= 400) {
        expect({
          route: route.operationId,
          status,
          problem: response.content?.['application/problem+json'] !== undefined,
          json: response.content?.['application/json'] !== undefined,
        }).toEqual({
          route: route.operationId,
          status,
          problem: true,
          json: false,
        });
      } else if (route.responses[Number(status)]?.schema !== undefined) {
        expect({
          route: route.operationId,
          status,
          json: response.content?.['application/json'] !== undefined,
          problem: response.content?.['application/problem+json'] !== undefined,
        }).toEqual({
          route: route.operationId,
          status,
          json: true,
          problem: false,
        });
      }
    }
  }
});

test('every route with rejecting input declares a Problem media response', () => {
  for (const route of routes) {
    const hasInput =
      route.params !== undefined ||
      route.query !== undefined ||
      route.headers !== undefined ||
      route.body !== undefined;
    if (!hasInput) continue;

    const responses = document.paths[route.path]?.[route.method]?.responses ?? {};
    const problemJson = (status: string): boolean =>
      responses[status]?.content?.['application/problem+json'] !== undefined;
    const acceptable = problemJson('400') || (route.body !== undefined && problemJson('422'));

    expect({
      route: route.operationId,
      hasInput,
      acceptable,
    }).toEqual({ route: route.operationId, hasInput: true, acceptable: true });
  }
});
