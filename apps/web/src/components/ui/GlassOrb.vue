<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import stillUrl from '../../assets/glass-orb.webp';
import { useTheme } from '../../theme/theme';
import {
  GLASS_FRAME_MS,
  GLASS_MAX_DPR,
  GLASS_SPEED,
  GLASS_STILL_TIME,
  claimGlassRenderer,
  glassShouldAnimate,
  glassTooSlow,
  releaseGlassRenderer,
  webglAvailable,
} from './glassOrb';
import type { GlassScene } from './glassScene';

/**
 * OhMyDate's glass object (HOLO-05), decorative: the brand mark in the round,
 * in physically based glass, drawn by three.js (glassScene.js).
 *
 * - **The still image is always there first.** It is what shows without
 *   WebGL (the desktop shell's WebKitGTK cannot be assumed to have it), while
 *   the scene's chunk loads, when a second object is on the page (one
 *   renderer a page), when the context is lost and when frames come too
 *   slowly. scripts/render-glass-orb.mjs renders it from the same scene.
 * - **three.js is loaded lazily**, by the dynamic import below: its own chunk,
 *   asked for only when an object is on screen with WebGL to draw it.
 * - Live, it turns only while it is on screen, the tab is visible and motion
 *   is allowed, at no more than 30 frames a second and 1.5 device pixels per
 *   CSS pixel. Under `prefers-reduced-motion` it draws one still frame.
 */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 200 });

const canvas = ref<HTMLCanvasElement | null>(null);
/** `still`: the image. `live`: the scene is drawn over it. */
const mode = ref<'still' | 'live'>('still');
const { scheme } = useTheme();
const me = Symbol('glass-orb');

let scene: GlassScene | null = null;
let frame = 0;
let lastDrawn = 0;
let startedAt = 0;
let elapsedMs = 0;
let onScreen = false;
let disposed = false;
let loading = false;
let gaveUp = false;
const gaps: number[] = [];
let observer: IntersectionObserver | null = null;
let motionQuery: MediaQueryList | null = null;

function light(): number {
  return scheme.value === 'light' ? 1 : 0;
}

function drawAt(ms: number): void {
  scene?.draw(GLASS_STILL_TIME + (ms / 1000) * GLASS_SPEED, light());
}

function allowed(): boolean {
  return glassShouldAnimate({
    onScreen,
    tabVisible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    reducedMotion: motionQuery?.matches === true,
  });
}

function tick(now: number): void {
  frame = 0;
  if (scene === null || !allowed()) return;
  if (now - lastDrawn >= GLASS_FRAME_MS) {
    if (startedAt !== 0) {
      elapsedMs += now - startedAt;
      gaps.push(now - lastDrawn);
    }
    startedAt = now;
    lastDrawn = now;
    drawAt(elapsedMs);
    // Too slow to be worth it here: the still image takes over for good.
    if (glassTooSlow(gaps)) {
      gaveUp = true;
      useStill();
      return;
    }
  }
  frame = requestAnimationFrame(tick);
}

/** Start or stop the loop to match what is allowed right now. */
function sync(): void {
  if (scene === null) {
    if (onScreen && !gaveUp) void goLive();
    return;
  }
  if (allowed()) {
    if (frame === 0) {
      startedAt = 0;
      frame = requestAnimationFrame(tick);
    }
    return;
  }
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  // Paused: what is on the canvas stays; reduced motion gets the still pose.
  if (motionQuery?.matches === true) drawAt(0);
}

function useStill(): void {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  scene?.dispose();
  scene = null;
  releaseGlassRenderer(me);
  mode.value = 'still';
}

function onContextLost(event: Event): void {
  event.preventDefault();
  gaveUp = true;
  useStill();
}

/** Load the scene (three.js arrives here, as its own chunk) and draw it over the still. */
async function goLive(): Promise<void> {
  const element = canvas.value;
  if (element === null || scene !== null || loading || disposed || !webglAvailable()) return;
  if (!claimGlassRenderer(me)) return; // another object has the page's one renderer
  loading = true;
  try {
    const { createGlassScene } = await import('./glassScene.js');
    if (disposed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, GLASS_MAX_DPR);
    element.width = Math.round(props.size * ratio);
    element.height = Math.round(props.size * ratio);
    scene = createGlassScene(element);
  } catch {
    scene = null;
  } finally {
    loading = false;
  }
  if (scene === null) {
    gaveUp = true;
    releaseGlassRenderer(me);
    return;
  }
  drawAt(elapsedMs);
  mode.value = 'live';
  sync();
}

onMounted(() => {
  const element = canvas.value;
  if (element === null || !webglAvailable()) return;
  element.addEventListener('webglcontextlost', onContextLost);
  if (typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    motionQuery.addEventListener('change', sync);
  }
  document.addEventListener('visibilitychange', sync);
  if (typeof IntersectionObserver === 'function') {
    // Nothing is loaded until the object is on screen.
    observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    observer.observe(element.parentElement ?? element);
  } else {
    onScreen = true;
    sync();
  }
});

// The studio brightens with the light scheme: redraw when the theme changes.
watch(scheme, () => {
  if (scene !== null && frame === 0) drawAt(elapsedMs);
});

onBeforeUnmount(() => {
  disposed = true;
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  observer?.disconnect();
  motionQuery?.removeEventListener('change', sync);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync);
  canvas.value?.removeEventListener('webglcontextlost', onContextLost);
  scene?.dispose();
  scene = null;
  releaseGlassRenderer(me);
});
</script>

<template>
  <span class="glass-orb" :style="{ '--glass-size': `${size}px` }" :data-glass="mode" aria-hidden="true">
    <img class="glass-orb-still" :src="stillUrl" alt="" :width="size" :height="size" />
    <canvas ref="canvas" class="glass-orb-canvas"></canvas>
  </span>
</template>
