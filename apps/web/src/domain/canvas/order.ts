/**
 * The order of the 할 일 canvas (HOLO-05) for whoever does not point at it:
 * the reading order (what a screen reader walks, where Home and End go) and
 * the neighbour an arrow key moves to. Pure; bodies are plain centres and sizes.
 */
export interface Placed {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Bodies whose centres are within this of a row's first body belong to that row. */
export const ROW_BAND = 30;

/**
 * Top to bottom, and left to right within a row. A row is every body whose
 * centre is within ROW_BAND of the highest one not yet in a row, so bodies
 * that sit a few pixels apart read as one line.
 */
export function readingOrder<T extends Placed>(bodies: readonly T[]): T[] {
  const rest = [...bodies].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const ordered: T[] = [];
  while (rest.length > 0) {
    const top = (rest[0] as T).y;
    const row: T[] = [];
    while (rest.length > 0 && (rest[0] as T).y <= top + ROW_BAND) row.push(rest.shift() as T);
    row.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1));
    ordered.push(...row);
  }
  return ordered;
}

export type Direction = 'left' | 'right' | 'up' | 'down';

/** How much being off the arrow's line costs against being far along it. */
const ACROSS_WEIGHT = 2.4;
/** A body further off the line than this many times its distance along it is not "that way". */
const CONE = 3;

/**
 * The body an arrow key moves to from `fromId`: the nearest one that way,
 * where being off the arrow's line counts more than being far along it. Null
 * when nothing lies that way (the focus stays where it is).
 */
export function neighbour(bodies: readonly Placed[], fromId: string, direction: Direction): string | null {
  const from = bodies.find((body) => body.id === fromId);
  if (from === undefined) return null;
  const horizontal = direction === 'left' || direction === 'right';
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  let best: string | null = null;
  let bestCost = Infinity;
  for (const body of bodies) {
    if (body.id === fromId) continue;
    const dx = body.x - from.x;
    const dy = body.y - from.y;
    const along = (horizontal ? dx : dy) * sign;
    const across = Math.abs(horizontal ? dy : dx);
    if (along <= 1 || across > along * CONE) continue;
    const cost = along + across * ACROSS_WEIGHT;
    if (cost < bestCost || (cost === bestCost && best !== null && body.id < best)) {
      bestCost = cost;
      best = body.id;
    }
  }
  return best;
}

/** Home and End: the first and the last body in reading order. */
export function edgeOf(bodies: readonly Placed[], edge: 'first' | 'last'): string | null {
  const ordered = readingOrder(bodies);
  const body = edge === 'first' ? ordered[0] : ordered[ordered.length - 1];
  return body?.id ?? null;
}
