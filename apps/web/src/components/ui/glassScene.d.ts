/** The live glass object: components/ui/glassScene.js (plain JavaScript — three.js ships no types). */
export interface GlassScene {
  /** Draw one frame. `timeSec` is the scene's own clock; `light` is 0 on the dark scheme and 1 on the light one. */
  draw(timeSec: number, light: number): void;
  dispose(): void;
}

/** Build the scene on `canvas` (its width and height are the backing size). Null when WebGL will not give a context. */
export function createGlassScene(canvas: HTMLCanvasElement): GlassScene | null;
