import { createHash } from 'node:crypto';

function compareCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function encode(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => encode(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodePoint);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${encode(record[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'null' : encoded;
}

/** Stable JSON with sorted object keys and code-point ordering. */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
