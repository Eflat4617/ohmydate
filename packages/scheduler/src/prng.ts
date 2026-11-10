/**
 * Small deterministic PRNG (mulberry32).
 *
 * The scheduler must never use `Math.random` or wall-clock time; every random
 * choice in generation is driven by `ScheduleInput.seed` through this object.
 */
export interface Prng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive); 0 when the range is empty. */
  nextInt(maxExclusive: number): number;
}

export function createPrng(seed: number): Prng {
  let state = (Math.trunc(seed) >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    nextInt(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
        return 0;
      }
      return Math.floor(next() * maxExclusive);
    },
  };
}
