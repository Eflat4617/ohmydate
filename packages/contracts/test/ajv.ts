import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => unknown;

export function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}
