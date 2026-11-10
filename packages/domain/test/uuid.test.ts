import {
  createUuidV7Generator,
  isUuidV7,
  uuidV7,
  type Clock,
  type Instant,
  type RandomBytes,
} from '../src/index.js';

const NOW = 1_700_000_000_000;

const sequentialRand: RandomBytes = (length) => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 7 + 3) & 0xff;
  return bytes;
};

function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}

test('uuidV7 sets version 7 and RFC 9562 variant bits', () => {
  const id = uuidV7(sequentialRand, NOW);
  expect(isUuidV7(id)).toBe(true);
  expect(id).toHaveLength(36);
  expect(id[14]).toBe('7');
  expect(['8', '9', 'a', 'b']).toContain(id[19]);
  expect(timestampOf(id)).toBe(NOW);
});

test('uuidV7 is deterministic for injected rand and timestamp', () => {
  expect(uuidV7(sequentialRand, NOW)).toBe(uuidV7(sequentialRand, NOW));
});

test('uuidV7 rejects a random source with the wrong length', () => {
  expect(() => uuidV7(() => new Uint8Array(8), NOW)).toThrow(RangeError);
});

test('uuidV7 rejects invalid timestamps', () => {
  expect(() => uuidV7(sequentialRand, -1)).toThrow(RangeError);
  expect(() => uuidV7(sequentialRand, 1.5)).toThrow(RangeError);
});

test('uuidV7 accepts the 48-bit timestamp boundary and rejects overflow', () => {
  const zeroRand: RandomBytes = (length) => new Uint8Array(length);
  const max = 0xffffffffffff;
  const boundary = uuidV7(zeroRand, max);
  expect(timestampOf(boundary)).toBe(max);
  expect(boundary.startsWith('ffffffff-ffff-7')).toBe(true);
  expect(timestampOf(uuidV7(zeroRand, 0))).toBe(0);
  expect(uuidV7(zeroRand, max)).not.toBe(uuidV7(zeroRand, 0));
  expect(() => uuidV7(zeroRand, max + 1)).toThrow(RangeError);
});

test('the generator is monotonic when the clock stalls', () => {
  const clock: Clock = { now: () => '2026-11-11T00:00:00.000Z' as Instant };
  const generator = createUuidV7Generator({ rand: sequentialRand, clock });
  const ids = Array.from({ length: 25 }, () => generator.next());

  for (const id of ids) {
    expect(isUuidV7(id)).toBe(true);
    expect(id[14]).toBe('7');
  }
  const sorted = [...ids].sort();
  expect(sorted).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});

test('the generator stays monotonic across advancing and regressing clocks', () => {
  let tick = 0;
  const clock: Clock = {
    now: () => new Date(NOW + tick).toISOString() as Instant,
  };
  const generator = createUuidV7Generator({ rand: sequentialRand, clock });

  const first = generator.next();
  tick = 1000;
  const second = generator.next();
  tick = 500;
  const third = generator.next();

  expect([first, second, third]).toEqual([...[first, second, third]].sort());
  expect(timestampOf(second)).toBeGreaterThan(timestampOf(first));
  expect(timestampOf(third)).toBe(timestampOf(second));
});
