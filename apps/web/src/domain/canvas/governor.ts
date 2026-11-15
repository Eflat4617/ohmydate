/**
 * The frame governor of the 할 일 canvas (HOLO-05): the sway is thinned
 * before it stutters. It watches the time between frames and steps the
 * motion down — never back up within a visit, so the surface does not flap
 * between two looks.
 *
 *   full   every frame, sway and lean
 *   thin   every other frame (about 30 a second), sway without the lean
 *   still  no sway: every body on its anchor
 */
export type MotionLevel = 'full' | 'thin' | 'still';

export interface Governor {
  level: MotionLevel;
  /** A running mean of the time between frames, in ms. */
  mean: number;
  /** How long (ms) the mean has been over the level's limit. */
  slowFor: number;
}

/** Slower than this on average (about 42 frames a second) is too slow for the full motion. */
export const THIN_ABOVE_MS = 24;
/** At the thin level frames are drawn every other tick; slower than this and the sway stops. */
export const STILL_ABOVE_MS = 30;
/** How long the mean has to stay over a limit before the level steps down. */
export const SLOW_FOR_MS = 1500;
/** A gap this long is a tab coming back or a debugger, not a slow frame. */
export const IGNORE_ABOVE_MS = 400;

export function createGovernor(): Governor {
  return { level: 'full', mean: 16.7, slowFor: 0 };
}

/** Feed it the time since the last animation frame; it answers the level to draw at. */
export function governorTick(governor: Governor, frameMs: number): MotionLevel {
  if (governor.level === 'still' || !(frameMs > 0) || frameMs > IGNORE_ABOVE_MS) return governor.level;
  governor.mean = governor.mean * 0.9 + frameMs * 0.1;
  const limit = governor.level === 'full' ? THIN_ABOVE_MS : STILL_ABOVE_MS;
  if (governor.mean <= limit) {
    governor.slowFor = 0;
    return governor.level;
  }
  governor.slowFor += frameMs;
  if (governor.slowFor >= SLOW_FOR_MS) {
    governor.level = governor.level === 'full' ? 'thin' : 'still';
    governor.slowFor = 0;
    // The next level starts from a clean reading.
    governor.mean = 16.7;
  }
  return governor.level;
}
