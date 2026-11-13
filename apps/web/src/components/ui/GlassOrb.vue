<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import stillUrl from '../../assets/glass-orb.webp';
import { useTheme } from '../../theme/theme';
import {
  createGlassRenderer,
  GLASS_FRAME_MS,
  GLASS_MAX_DPR,
  GLASS_SPEED,
  glassShouldAnimate,
  type GlassRenderer,
} from './glassOrb';
import { GLASS_STILL_TIME } from './glassOrbShader';

/**
 * OhMyDate's glass object (HOLO-01), decorative: a small WebGL canvas drawn
 * by this project's own shader (glassOrbShader.ts).
 *
 * - It animates only while it is on screen, the tab is visible and motion is
 *   allowed, at no more than 30 frames a second.
 * - Under `prefers-reduced-motion` it draws one still frame.
 * - Without WebGL (or when the context is lost) it shows the still image that
 *   scripts/render-glass-orb.mjs rendered from the same shader.
 */
const props = withDefaults(defineProps<{ size?: number }>(), { size: 200 });

const canvas = ref<HTMLCanvasElement | null>(null);
const mode = ref<'pending' | 'live' | 'still'>('pending');
const { scheme } = useTheme();

let renderer: GlassRenderer | null = null;
let frame = 0;
let lastDrawn = 0;
let startedAt = 0;
let elapsedMs = 0;
let onScreen = true;
let observer: IntersectionObserver | null = null;
let motionQuery: MediaQueryList | null = null;

function light(): number {
  return scheme.value === 'light' ? 1 : 0;
}

function drawAt(ms: number): void {
  renderer?.draw(GLASS_STILL_TIME + (ms / 1000) * GLASS_SPEED, light());
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
  if (renderer === null || !allowed()) return;
  if (now - lastDrawn >= GLASS_FRAME_MS) {
    elapsedMs += startedAt === 0 ? 0 : now - startedAt;
    startedAt = now;
    lastDrawn = now;
    drawAt(elapsedMs);
  }
  frame = requestAnimationFrame(tick);
}

/** Start or stop the loop to match what is allowed right now. */
function sync(): void {
  if (renderer === null) return;
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
  renderer = null;
  mode.value = 'still';
}

function onContextLost(event: Event): void {
  event.preventDefault();
  useStill();
}

onMounted(() => {
  const element = canvas.value;
  if (element === null) return;
  const ratio = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, GLASS_MAX_DPR);
  element.width = Math.round(props.size * ratio);
  element.height = Math.round(props.size * ratio);
  renderer = createGlassRenderer(element);
  if (renderer === null) {
    mode.value = 'still';
    return;
  }
  mode.value = 'live';
  element.addEventListener('webglcontextlost', onContextLost);
  if (typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    motionQuery.addEventListener('change', sync);
  }
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      sync();
    });
    observer.observe(element);
  }
  document.addEventListener('visibilitychange', sync);
  drawAt(0);
  sync();
});

// The studio brightens with the light scheme: redraw when the theme changes.
watch(scheme, () => {
  if (renderer !== null && frame === 0) drawAt(elapsedMs);
});

onBeforeUnmount(() => {
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  observer?.disconnect();
  motionQuery?.removeEventListener('change', sync);
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync);
  canvas.value?.removeEventListener('webglcontextlost', onContextLost);
  renderer?.dispose();
  renderer = null;
});
</script>

<template>
  <span class="glass-orb" :style="{ '--glass-size': `${size}px` }" :data-glass="mode" aria-hidden="true">
    <canvas v-show="mode !== 'still'" ref="canvas" class="glass-orb-canvas"></canvas>
    <img v-if="mode === 'still'" class="glass-orb-still" :src="stillUrl" alt="" :width="size" :height="size" />
  </span>
</template>
