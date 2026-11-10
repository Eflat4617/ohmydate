import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { UnknownSchemaError } from './errors.js';
import { SCHEMA_SOURCES } from './schemas.generated.js';

export interface SchemaIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface SchemaValidation {
  readonly valid: boolean;
  readonly issues: readonly SchemaIssue[];
  readonly errors: readonly string[];
}

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: false, verbose: false });

const validators = new Map<string, ValidateFunction>();
for (const [schemaId, schema] of Object.entries(SCHEMA_SOURCES)) {
  validators.set(schemaId, ajv.compile(schema as object));
}

export const SCHEMA_IDS: readonly string[] = Object.freeze([...validators.keys()].sort());

export function hasSchema(schemaId: string): boolean {
  return validators.has(schemaId);
}

export function getValidator(schemaId: string): ValidateFunction {
  const validator = validators.get(schemaId);
  if (validator === undefined) throw new UnknownSchemaError(schemaId);
  return validator;
}

function toIssue(error: ErrorObject): SchemaIssue {
  return {
    path: error.instancePath === '' ? '/' : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'invalid value',
  };
}

export function formatIssues(issues: readonly SchemaIssue[]): readonly string[] {
  return issues.map((issue) => `${issue.path} ${issue.message} [${issue.keyword}]`);
}

/** Validate an untrusted provider value against a registered schema. */
export function validateOutput(schemaId: string, value: unknown): SchemaValidation {
  const validator = getValidator(schemaId);
  const valid = validator(value) === true;
  if (valid) return { valid: true, issues: [], errors: [] };
  const issues = (validator.errors ?? []).map(toIssue);
  return { valid: false, issues, errors: formatIssues(issues) };
}
