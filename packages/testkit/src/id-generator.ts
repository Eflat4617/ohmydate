import {
  createUuidV7Generator,
  type Clock,
  type IdGenerator,
  type RandomBytes,
} from '@ohmydate/domain';

export function seededRandom(seed: number): RandomBytes {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    if (!Number.isInteger(length) || length < 0) {
      throw new RangeError('random byte length must be a non-negative integer');
    }
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      bytes[index] = ((value ^ (value >>> 14)) >>> 0) & 0xff;
    }
    return bytes;
  };
}

export function createSeededIdGenerator(seed: number, clock: Clock): IdGenerator {
  return createUuidV7Generator({ rand: seededRandom(seed), clock });
}
