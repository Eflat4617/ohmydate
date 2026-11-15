/**
 * A seeded generator for the 할 일 canvas (HOLO-05). The canvas never calls
 * `Math.random`: the drift of a to-do and the place a new one is given both
 * come from its id, so the same to-dos on the same surface always make the
 * same picture — and a test can say what that picture is.
 */

/** FNV-1a over the UTF-16 code units: a 32-bit seed from any text. */
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: numbers in [0, 1), the same sequence for the same seed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
