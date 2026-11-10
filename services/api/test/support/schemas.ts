import { registerIanaTimeZoneFormat } from '@ohmydate/contracts';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

const addFormats = addFormatsModule as unknown as (ajv: Ajv) => unknown;

export function compile(schema: object): ValidateFunction {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  registerIanaTimeZoneFormat(ajv);
  return ajv.compile(schema);
}

export function parseJson(body: string): unknown {
  return JSON.parse(body) as unknown;
}
