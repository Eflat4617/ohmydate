/**
 * The rules of OhMyDate's glass object (HOLO-05), kept apart from the scene
 * so that nothing here needs three.js: when it may be drawn live, when it may
 * move, how much it may cost, and that there is one renderer on a page.
 *
 * The scene itself is components/ui/glassScene.js, loaded only when a live
 * object is about to be drawn; without WebGL (the desktop shell's WebKitGTK
 * cannot be assumed to have it), while the chunk loads, when a second object
 * is on the page or when frames come too slowly, the still image stands in.
 */

/** Frames are at least this far apart: 30 a second is plenty for a slow turn. */
export const GLASS_FRAME_MS = 1000 / 30;
/** The backing store never exceeds this many device pixels per CSS pixel. */
export const GLASS_MAX_DPR = 1.5;
/** How fast the scene's clock runs against the wall clock: a slow, calm turn. */
export const GLASS_SPEED = 0.35;
/** The pose the still image is rendered at, and where a live object starts. */
export const GLASS_STILL_TIME = 47;

/**
 * The glass, as physically based numbers (the scene reads them from here and
 * the tests hold them): light goes through it (transmission) across a real
 * thickness, bends by an index of refraction, and picks up a little
 * thin-film colour on the way.
 */
export const GLASS_MATERIAL = {
  transmission: 1,
  thickness: 1.25,
  ior: 1.46,
  roughness: 0.07,
  /** A little of the colours splitting on the way out. */
  dispersion: 3,
  iridescence: 0.45,
  iridescenceIOR: 1.3,
  clearcoat: 1,
} as const;

/** Does this browser have the WebGL API at all? (A context may still be refused.) */
export function webglAvailable(): boolean {
  return typeof WebGLRenderingContext !== 'undefined' || typeof WebGL2RenderingContext !== 'undefined';
}

/** May the object animate right now? Only on screen, in a visible tab, with motion allowed. */
export function glassShouldAnimate(state: {
  readonly onScreen: boolean;
  readonly tabVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.onScreen && state.tabVisible && !state.reducedMotion;
}

/** Frames watched before the object is judged, and the mean gap (ms) above which it is "slow". */
export const GLASS_PROBE_FRAMES = 24;
export const GLASS_SLOW_MS = 55;

/**
 * Is WebGL here too slow to be worth it? `gaps` are the times between the
 * first drawn frames; once enough are in, a mean above GLASS_SLOW_MS (about
 * 18 a second, against the 30 it asks for) says yes — and the still image
 * takes over for good.
 */
export function glassTooSlow(gaps: readonly number[]): boolean {
  if (gaps.length < GLASS_PROBE_FRAMES) return false;
  const recent = gaps.slice(-GLASS_PROBE_FRAMES);
  return recent.reduce((sum, gap) => sum + gap, 0) / recent.length > GLASS_SLOW_MS;
}

// ── One renderer per page ───────────────────────────────────────────────
let holder: symbol | null = null;

/** Ask for the page's one live renderer. False when another glass object already has it. */
export function claimGlassRenderer(who: symbol): boolean {
  if (holder !== null && holder !== who) return false;
  holder = who;
  return true;
}

export function releaseGlassRenderer(who: symbol): void {
  if (holder === who) holder = null;
}
