import { hashSeed, seededRandom } from './random';

/**
 * The motion of the 할 일 canvas (HOLO-05), as pure functions.
 *
 * A to-do on the canvas is a **moored buoy**. It has an anchor — the place
 * the owner left it, which is what is remembered — and it sways a few pixels
 * around that anchor on a slow current of its own. Two things follow:
 *
 * - **The place means something.** A body never wanders away from where it
 *   was put; only `relax` moves an anchor, and only to keep bodies apart,
 *   out of a folder's dish, and on the surface.
 * - **Stillness is the same picture.** With the sway at zero (reduced
 *   motion, a hidden tab, the pointer close by) every body is exactly on its
 *   anchor, so the still layout is the layout.
 *
 * The sway is a closed form of time (`swayAt`), not an integration: it cannot
 * drift, it costs two sines a body, and the same clock gives the same frame.
 * Bodies are kept `gap` apart at their anchors and `gap` is more than twice
 * the sway's reach, so two bodies never touch however they sway.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The slow current of one body: two periods, their phases, how far it reaches. */
export interface Sway {
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
  readonly px: number;
  readonly py: number;
  readonly pz: number;
  /** 0.7 … 1 of the canvas's reach: bodies do not all sway alike. */
  readonly reach: number;
}

export interface Body {
  readonly id: string;
  /** The anchor: the centre the body is moored to, in the surface's pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The folder it floats in; null on the open water. */
  region: string | null;
  /** In the hand: nothing but the pointer moves it. */
  held: boolean;
  /** How freely it sways: 0 holds still, 1 is the full current. */
  drift: number;
  readonly sway: Sway;
}

/** A folder's inside: where its bodies stay. */
export interface Region {
  readonly id: string;
  readonly box: Box;
}

export interface World {
  readonly width: number;
  readonly height: number;
  readonly regions: readonly Region[];
  /** What the open water's bodies keep out of: every folder's dish, open or folded. */
  readonly obstacles: readonly Box[];
}

const TAU = Math.PI * 2;

/** The shortest and the span of a sway period, in seconds: slow enough to read as water. */
export const SWAY_PERIOD_MIN_S = 9;
export const SWAY_PERIOD_SPAN_S = 8;
/** The most a body leans while it sways, in degrees. */
export const SWAY_TILT_DEG = 0.7;

/** The current of a body, from its id alone. */
export function swayOf(id: string): Sway {
  const next = seededRandom(hashSeed(id));
  const frequency = (): number => TAU / (SWAY_PERIOD_MIN_S + next() * SWAY_PERIOD_SPAN_S);
  return {
    wx: frequency(),
    wy: frequency(),
    wz: frequency() * 0.6,
    px: next() * TAU,
    py: next() * TAU,
    pz: next() * TAU,
    reach: 0.7 + next() * 0.3,
  };
}

export function createBody(id: string, size: { w: number; h: number }, at: Point, region: string | null = null): Body {
  return { id, x: at.x, y: at.y, w: size.w, h: size.h, region, held: false, drift: 0, sway: swayOf(id) };
}

export interface SwayOffset {
  readonly dx: number;
  readonly dy: number;
  /** Degrees. */
  readonly tilt: number;
}

/**
 * Where the current has carried a body at `timeSec`: at most `reach` pixels
 * from its anchor on either axis, and nothing at all while `drift` is 0.
 */
export function swayAt(body: Pick<Body, 'drift' | 'sway'>, timeSec: number, reach: number): SwayOffset {
  if (body.drift <= 0 || reach <= 0) return { dx: 0, dy: 0, tilt: 0 };
  const { wx, wy, wz, px, py, pz } = body.sway;
  const k = body.drift * body.sway.reach * reach;
  const slow = Math.sin(wz * timeSec + pz);
  return {
    dx: k * (0.72 * Math.sin(wx * timeSec + px) + 0.28 * slow),
    dy: k * (0.72 * Math.cos(wy * timeSec + py) + 0.28 * Math.sin(wz * 0.8 * timeSec + pz + 1.3)),
    tilt: body.drift * SWAY_TILT_DEG * Math.sin(wz * timeSec + px),
  };
}

export interface RelaxOptions {
  /** Seconds since the last step. */
  readonly dt: number;
  /** The least distance between two bodies' edges at rest. */
  readonly gap: number;
  /** The least distance between a body's edge and the edge of what holds it. */
  readonly pad: number;
  /** The gap between two bodies inside a folder, where things are put away closer together (default: `gap`). */
  readonly insideGap?: number;
  /** …and their distance from the dish's own edge (default: `pad`). */
  readonly insidePad?: number;
}

/** How fast an overlap closes: about nine tenths of it in a quarter second. */
export const RELAX_RATE = 9;
/** A step that moves nothing further than this has come to rest. */
export const REST_EPSILON = 0.05;

function boxOf(world: World, region: string | null): Box {
  if (region !== null) {
    const found = world.regions.find((item) => item.id === region);
    if (found !== undefined) return found.box;
  }
  return { left: 0, top: 0, width: world.width, height: world.height };
}

/** The nearest value to `value` that keeps a span of `size` inside [min, min + room]. */
function inside(value: number, size: number, min: number, room: number, pad: number): number {
  const low = min + pad + size / 2;
  const high = min + room - pad - size / 2;
  // Too big for what holds it: the middle is the best it can do.
  if (low > high) return min + room / 2;
  return Math.max(low, Math.min(value, high));
}

/**
 * One step of the anchors: bodies of the same water push each other apart
 * until they are `gap` apart, the open water's bodies are pushed out of every
 * folder's dish, and every body is drawn back inside what holds it. A held
 * body is not moved; what it overlaps gives way entirely.
 *
 * The push is along the line between two centres measured in the pair's own
 * proportions, so wide bodies slide past each other diagonally instead of
 * stacking into rows. Returns the furthest any anchor moved (px): below
 * REST_EPSILON the surface is at rest and the caller may stop stepping.
 */
export function relax(bodies: readonly Body[], world: World, options: RelaxOptions): number {
  const count = bodies.length;
  const moveX = new Float64Array(count);
  const moveY = new Float64Array(count);
  const insideGap = options.insideGap ?? options.gap;
  const insidePad = options.insidePad ?? options.pad;

  for (let i = 0; i < count; i += 1) {
    const a = bodies[i] as Body;
    for (let j = i + 1; j < count; j += 1) {
      const b = bodies[j] as Body;
      if (a.region !== b.region) continue;
      const gap = a.region === null ? options.gap : insideGap;
      const reachX = (a.w + b.w) / 2 + gap;
      const dx = b.x - a.x;
      const overlapX = reachX - Math.abs(dx);
      if (overlapX <= 0) continue;
      const reachY = (a.h + b.h) / 2 + gap;
      const dy = b.y - a.y;
      const overlapY = reachY - Math.abs(dy);
      if (overlapY <= 0) continue;
      if (a.held && b.held) continue;

      let nx = dx / reachX;
      let ny = dy / reachY;
      let length = Math.hypot(nx, ny);
      if (length < 1e-6) {
        // Exactly on top of each other: a direction from the two ids, always the same one.
        const angle = (((hashSeed(a.id) ^ hashSeed(b.id)) >>> 0) / 4294967296) * TAU;
        nx = Math.cos(angle);
        ny = Math.sin(angle);
        length = 1;
      }
      nx /= length;
      ny /= length;
      // Along (nx, ny), how far until one axis is clear.
      const push = Math.min(
        overlapX / Math.max(Math.abs(nx), 1e-3),
        overlapY / Math.max(Math.abs(ny), 1e-3),
        Math.max(reachX, reachY),
      );
      const shareA = a.held ? 0 : b.held ? 1 : 0.5;
      const shareB = 1 - shareA;
      moveX[i] = (moveX[i] as number) - nx * push * shareA;
      moveY[i] = (moveY[i] as number) - ny * push * shareA;
      moveX[j] = (moveX[j] as number) + nx * push * (a.held ? 1 : shareB);
      moveY[j] = (moveY[j] as number) + ny * push * (a.held ? 1 : shareB);
    }
  }

  const ease = 1 - Math.exp(-Math.max(0, options.dt) * RELAX_RATE);
  let furthest = 0;
  for (let i = 0; i < count; i += 1) {
    const body = bodies[i] as Body;
    if (body.held) continue;
    let targetX = body.x + (moveX[i] as number);
    let targetY = body.y + (moveY[i] as number);

    if (body.region === null) {
      // Out of every dish, by the nearer edge.
      for (const dish of world.obstacles) {
        const reachX = (body.w + dish.width) / 2 + options.gap;
        const reachY = (body.h + dish.height) / 2 + options.gap;
        const dx = targetX - (dish.left + dish.width / 2);
        const dy = targetY - (dish.top + dish.height / 2);
        const overlapX = reachX - Math.abs(dx);
        const overlapY = reachY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) targetX += dx < 0 ? -overlapX : overlapX;
        else targetY += dy < 0 ? -overlapY : overlapY;
      }
    }

    const box = boxOf(world, body.region);
    const pad = body.region === null ? options.pad : insidePad;
    targetX = inside(targetX, body.w, box.left, box.width, pad);
    targetY = inside(targetY, body.h, box.top, box.height, pad);

    const stepX = (targetX - body.x) * ease;
    const stepY = (targetY - body.y) * ease;
    body.x += stepX;
    body.y += stepY;
    furthest = Math.max(furthest, Math.abs(stepX), Math.abs(stepY));
  }
  return furthest;
}

/**
 * Relax until the surface is at rest (or `maxSteps` ran out): the layout a
 * screen opens with, and what a still screen shows. Returns the steps taken.
 */
export function settle(bodies: readonly Body[], world: World, options: Omit<RelaxOptions, 'dt'>, maxSteps = 400): number {
  for (let step = 1; step <= maxSteps; step += 1) {
    // A long step: most of every overlap closes at once.
    if (relax(bodies, world, { ...options, dt: 0.12 }) < REST_EPSILON) return step;
  }
  return maxSteps;
}

/** True when two bodies of the same water are closer than `gap` at their anchors. */
export function overlapping(a: Body, b: Body, gap: number): boolean {
  if (a.region !== b.region) return false;
  return Math.abs(b.x - a.x) < (a.w + b.w) / 2 + gap && Math.abs(b.y - a.y) < (a.h + b.h) / 2 + gap;
}

/** How far a point is from a body's edge (0 on or inside it). */
export function distanceTo(body: Pick<Body, 'x' | 'y' | 'w' | 'h'>, point: Point): number {
  const dx = Math.max(Math.abs(point.x - body.x) - body.w / 2, 0);
  const dy = Math.max(Math.abs(point.y - body.y) - body.h / 2, 0);
  return Math.hypot(dx, dy);
}

/** Within this many pixels of the pointer a body holds still. */
export const CALM_INNER = 28;
/** …and from here on it sways freely. */
export const CALM_OUTER = 180;
/** Settling is quick (things you are about to click hold still at once)… */
export const SETTLE_RATE = 10;
/** …and waking is slow. */
export const WAKE_RATE = 1.3;

function smoothstep(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

/** How freely a body may sway with the pointer at `distance` from it. */
export function calmAt(distance: number): number {
  return smoothstep((distance - CALM_INNER) / (CALM_OUTER - CALM_INNER));
}

export interface EaseOptions {
  readonly dt: number;
  /** Where the pointer is on the surface; null when it is not over it. */
  readonly pointer: Point | null;
  /** Bodies that hold still whatever the pointer does: in focus, picked, open. */
  readonly still?: ReadonlySet<string> | null;
}

/**
 * Move every body's `drift` toward what the pointer allows: quickly down as
 * it comes near, gently back up as it leaves.
 */
export function easeDrift(bodies: readonly Body[], options: EaseOptions): void {
  const dt = Math.max(0, options.dt);
  const down = 1 - Math.exp(-dt * SETTLE_RATE);
  const up = 1 - Math.exp(-dt * WAKE_RATE);
  for (const body of bodies) {
    let target = 1;
    if (body.held || options.still?.has(body.id) === true) target = 0;
    else if (options.pointer !== null) target = calmAt(distanceTo(body, options.pointer));
    body.drift += (target - body.drift) * (target < body.drift ? down : up);
    if (body.drift < 1e-4) body.drift = 0;
    else if (body.drift > 1 - 1e-4) body.drift = 1;
  }
}
