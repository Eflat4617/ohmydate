import { epochMsToInstant, isUuidV7 } from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '../src/index.js';

describe('FakeClock', () => {
  it('starts at a fixed instant and only advances when told', () => {
    const clock = new FakeClock(epochMsToInstant(Date.UTC(2026, 0, 1)));
    const start = clock.now();
    expect(start).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now()).toBe(start);

    expect(clock.advance(1_500)).toBe('2026-01-01T00:00:01.500Z');
    expect(clock.now()).toBe('2026-01-01T00:00:01.500Z');
  });

  it('can be set to any valid instant', () => {
    const clock = new FakeClock();
    clock.set(epochMsToInstant(Date.UTC(2030, 5, 15, 12)));
    expect(clock.now()).toBe('2030-06-15T12:00:00.000Z');
  });

  it('rejects negative or fractional advances', () => {
    const clock = new FakeClock();
    expect(() => clock.advance(-1)).toThrow(RangeError);
    expect(() => clock.advance(0.5)).toThrow(RangeError);
  });
});

describe('createSeededIdGenerator', () => {
  it('is deterministic for the same seed and clock', () => {
    const first = createSeededIdGenerator(42, new FakeClock());
    const second = createSeededIdGenerator(42, new FakeClock());
    const firstIds = Array.from({ length: 5 }, () => first.next());
    const secondIds = Array.from({ length: 5 }, () => second.next());
    expect(firstIds).toEqual(secondIds);
    expect(firstIds.every((id) => isUuidV7(id))).toBe(true);
  });

  it('differs across seeds', () => {
    const first = createSeededIdGenerator(1, new FakeClock());
    const second = createSeededIdGenerator(2, new FakeClock());
    expect(first.next()).not.toBe(second.next());
  });

  it('stays unique when the clock does not advance', () => {
    const clock = new FakeClock();
    const generator = createSeededIdGenerator(7, clock);
    const ids = new Set(Array.from({ length: 100 }, () => generator.next()));
    expect(ids.size).toBe(100);
  });
});
