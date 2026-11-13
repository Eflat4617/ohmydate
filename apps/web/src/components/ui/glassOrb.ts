import { GLASS_FRAGMENT_SHADER, GLASS_VERTEX_SHADER } from './glassOrbShader';

/**
 * The WebGL side of the glass object (HOLO-01): one program, one full-canvas
 * triangle, three uniforms. `createGlassRenderer` returns null whenever WebGL
 * cannot be used (no API, no context, a shader that does not compile), and
 * the component then shows the still image instead.
 */
export interface GlassRenderer {
  /** Draw one frame. `light` is 0 on the dark scheme and 1 on the light one. */
  draw(timeSec: number, light: number): void;
  dispose(): void;
}

function compile(gl: WebGLRenderingContext, kind: number, source: string): WebGLShader | null {
  const shader = gl.createShader(kind);
  if (shader === null) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS) !== true) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function webglAvailable(): boolean {
  return typeof WebGLRenderingContext !== 'undefined';
}

/** A WebGL context for the canvas, or null when the browser will not give one. */
function contextOf(canvas: HTMLCanvasElement): WebGLRenderingContext | null {
  try {
    return canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
  } catch {
    return null;
  }
}

export function createGlassRenderer(canvas: HTMLCanvasElement): GlassRenderer | null {
  if (!webglAvailable()) return null;
  const context = contextOf(canvas);
  if (context === null) return null;

  const vertex = compile(context, context.VERTEX_SHADER, GLASS_VERTEX_SHADER);
  const fragment = compile(context, context.FRAGMENT_SHADER, GLASS_FRAGMENT_SHADER);
  const program = context.createProgram();
  if (vertex === null || fragment === null || program === null) return null;
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  if (context.getProgramParameter(program, context.LINK_STATUS) !== true) return null;
  context.useProgram(program);

  const buffer = context.createBuffer();
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  // One triangle that covers the canvas.
  context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), context.STATIC_DRAW);
  const position = context.getAttribLocation(program, 'a_pos');
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

  const resolution = context.getUniformLocation(program, 'u_res');
  const time = context.getUniformLocation(program, 'u_time');
  const scheme = context.getUniformLocation(program, 'u_light');
  context.clearColor(0, 0, 0, 0);

  return {
    draw(timeSec, light) {
      context.viewport(0, 0, canvas.width, canvas.height);
      context.uniform2f(resolution, canvas.width, canvas.height);
      context.uniform1f(time, timeSec);
      context.uniform1f(scheme, light);
      context.clear(context.COLOR_BUFFER_BIT);
      context.drawArrays(context.TRIANGLES, 0, 3);
    },
    dispose() {
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
      context.deleteShader(vertex);
      context.deleteShader(fragment);
    },
  };
}

/** Frames are at least this far apart: 30 a second is plenty for a slow turn. */
export const GLASS_FRAME_MS = 1000 / 30;
/** The backing store never exceeds this many device pixels per CSS pixel. */
export const GLASS_MAX_DPR = 1.5;
/** How fast shader time runs against the clock: a slow, calm turn. */
export const GLASS_SPEED = 0.35;

/** May the object animate right now? Only on screen, in a visible tab, with motion allowed. */
export function glassShouldAnimate(state: {
  readonly onScreen: boolean;
  readonly tabVisible: boolean;
  readonly reducedMotion: boolean;
}): boolean {
  return state.onScreen && state.tabVisible && !state.reducedMotion;
}
