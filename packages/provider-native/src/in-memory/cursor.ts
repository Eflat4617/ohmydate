import { ValidationFailedError, isInstant, isUuidV7, type Id } from '@ohmydate/domain';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export interface ListCursor {
  readonly createdAt: string;
  readonly id: Id;
}

function toBase64Url(input: string): string {
  let output = '';
  for (let index = 0; index < input.length; index += 3) {
    const first = input.charCodeAt(index);
    const second = index + 1 < input.length ? input.charCodeAt(index + 1) : null;
    const third = index + 2 < input.length ? input.charCodeAt(index + 2) : null;
    const byte1 = first >> 2;
    const byte2 = ((first & 0b11) << 4) | ((second ?? 0) >> 4);
    output += ALPHABET.charAt(byte1);
    output += ALPHABET.charAt(byte2);
    if (second !== null) {
      const byte3 = ((second & 0b1111) << 2) | ((third ?? 0) >> 6);
      output += ALPHABET.charAt(byte3);
    }
    if (third !== null) output += ALPHABET.charAt(third & 0b111111);
  }
  return output;
}

function fromBase64Url(input: string): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const character of input) {
    const value = ALPHABET.indexOf(character);
    if (value < 0) throw new Error('invalid base64url input');
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output;
}

function decode(value: string): unknown {
  try {
    return JSON.parse(fromBase64Url(value)) as unknown;
  } catch {
    return undefined;
  }
}

export function encodeListCursor(cursor: ListCursor): string {
  return toBase64Url(JSON.stringify({ c: cursor.createdAt, i: cursor.id }));
}

export function decodeListCursor(value: string): ListCursor {
  const parsed = decode(value) as { c?: unknown; i?: unknown } | null;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.c === 'string' &&
    isInstant(parsed.c) &&
    typeof parsed.i === 'string' &&
    isUuidV7(parsed.i)
  ) {
    return { createdAt: parsed.c, id: parsed.i };
  }
  throw new ValidationFailedError([{ path: 'cursor', message: 'invalid list cursor' }]);
}

export function encodeChangeCursor(sequence: number): string {
  return toBase64Url(JSON.stringify({ s: sequence }));
}

export function decodeChangeCursor(value: string | null): number {
  if (value === null) return 0;
  const parsed = decode(value) as { s?: unknown } | null;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.s === 'number' &&
    Number.isInteger(parsed.s) &&
    parsed.s >= 0
  ) {
    return parsed.s;
  }
  throw new ValidationFailedError([{ path: 'cursor', message: 'invalid change cursor' }]);
}
