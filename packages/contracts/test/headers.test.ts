import { IdempotencyKeyHeaderSchema, IdSchema, IfMatchHeaderSchema } from '../src/index.js';
import { compile } from './ajv.js';

test('If-Match accepts weak positive version tags', () => {
  const validate = compile(IfMatchHeaderSchema);
  for (const value of ['W/"3"', 'W/"1"', 'W/"42"']) {
    expect({ value, valid: validate(value) }).toEqual({ value, valid: true });
  }
});

test('If-Match rejects strong tags, zero and malformed values', () => {
  const validate = compile(IfMatchHeaderSchema);
  for (const value of ['"3"', 'W/"0"', 'W/"01"', 'W/"-1"', 'W/3', '3', '']) {
    expect({ value, valid: validate(value) }).toEqual({ value, valid: false });
  }
});

test('Idempotency-Key must be a UUID', () => {
  const validate = compile(IdempotencyKeyHeaderSchema);
  expect(validate('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55')).toBe(true);
  expect(validate('not-a-uuid')).toBe(false);
});

test('Id schema rejects UUIDv4 and random UUIDs', () => {
  const validate = compile(IdSchema);
  expect(validate('0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55')).toBe(true);
  expect(validate('0193a8f2-6c1e-4b41-9a2e-1f1d6a0b3c55')).toBe(false);
  expect(validate('9b2f4c2a-1f3e-4d6a-8b7c-2e5f9a0b1c3d')).toBe(false);
  expect(validate('not-a-uuid')).toBe(false);
  expect(validate(42)).toBe(false);
});
