import type { Id } from './brand.js';
import type { Clock, IdGenerator } from './ports.js';
import { instantToEpochMs } from './time.js';

export type RandomBytes = (length: number) => Uint8Array;

const MAX_RAND_A = 0xfff;
const MAX_TIMESTAMP_MS = 0xffffffffffff;
const HEX = '0123456789abcdef';

function assertRandomBytes(bytes: Uint8Array, length: number): Uint8Array {
  if (bytes.length !== length) {
    throw new RangeError(`random byte source must return exactly ${length} bytes`);
  }
  return bytes;
}

function formatUuid(bytes: Uint8Array): Id {
  let out = '';
  for (let index = 0; index < 16; index += 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new RangeError('uuid buffer too short');
    if (index === 4 || index === 6 || index === 8 || index === 10) out += '-';
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out as Id;
}

function writeTimestamp(bytes: Uint8Array, nowMs: number): void {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_TIMESTAMP_MS) {
    throw new RangeError('nowMs must be an integer between 0 and 0xffffffffffff');
  }
  const timestamp = BigInt(nowMs);
  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
}

export function uuidV7(rand: RandomBytes, nowMs: number): Id {
  const bytes = new Uint8Array(assertRandomBytes(rand(16), 16));
  writeTimestamp(bytes, nowMs);

  const byte6 = bytes[6];
  const byte8 = bytes[8];
  if (byte6 === undefined || byte8 === undefined) throw new RangeError('uuid buffer too short');
  bytes[6] = (byte6 & 0x0f) | 0x70;
  bytes[8] = (byte8 & 0x3f) | 0x80;

  return formatUuid(bytes);
}

export interface UuidV7GeneratorOptions {
  readonly rand: RandomBytes;
  readonly clock: Clock;
}

export function createUuidV7Generator(options: UuidV7GeneratorOptions): IdGenerator {
  let lastMs = -1;
  let sequence = 0;

  return {
    next(): Id {
      const nowMs = instantToEpochMs(options.clock.now());
      let effectiveMs = nowMs;

      if (nowMs > lastMs) {
        sequence = 0;
      } else {
        effectiveMs = lastMs;
        sequence += 1;
        if (sequence > MAX_RAND_A) {
          effectiveMs = lastMs + 1;
          sequence = 0;
        }
      }

      lastMs = effectiveMs;
      const random = assertRandomBytes(options.rand(8), 8);
      const bytes = new Uint8Array(16);
      writeTimestamp(bytes, effectiveMs);
      bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
      bytes[7] = sequence & 0xff;
      bytes[8] = ((random[0] ?? 0) & 0x3f) | 0x80;
      for (let index = 1; index < 8; index += 1) {
        bytes[8 + index] = random[index] ?? 0;
      }

      return formatUuid(bytes);
    },
  };
}
