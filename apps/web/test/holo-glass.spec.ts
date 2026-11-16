import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import GlassOrb from '../src/components/ui/GlassOrb.vue';
import {
  GLASS_FRAME_MS,
  GLASS_MATERIAL,
  GLASS_MAX_DPR,
  GLASS_PROBE_FRAMES,
  GLASS_SLOW_MS,
  GLASS_STILL_TIME,
  claimGlassRenderer,
  glassShouldAnimate,
  glassTooSlow,
  releaseGlassRenderer,
  webglAvailable,
} from '../src/components/ui/glassOrb';

/**
 * HOLO-05 glass object: the brand mark in physically based glass, drawn by
 * three.js where WebGL can draw it and by a still image everywhere else.
 * jsdom has no WebGL, so what these tests see mounted is the still — which is
 * exactly the desktop shell's case (WebKitGTK cannot be assumed to have it).
 * The rules for when it may be live, move, and what it may cost are pure.
 */
const sources = import.meta.glob<string>('../src/**/*.{ts,js,vue}', { query: '?raw', import: 'default', eager: true });
const sceneSource = sources['../src/components/ui/glassScene.js'] ?? '';
const orbSource = sources['../src/components/ui/GlassOrb.vue'] ?? '';

describe('glass object', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the still image when WebGL is missing, and stays out of the accessibility tree', async () => {
    expect(webglAvailable()).toBe(false);
    const wrapper = mount(GlassOrb, { props: { size: 160 }, attachTo: document.body });
    await nextTick();
    const root = wrapper.get('.glass-orb');
    expect(root.attributes('data-glass')).toBe('still');
    expect(root.attributes('aria-hidden')).toBe('true');
    const still = wrapper.get('img.glass-orb-still');
    expect(still.attributes('alt')).toBe('');
    expect(still.attributes('src')).toContain('glass-orb');
    expect(still.attributes('width')).toBe('160');
    wrapper.unmount();
  });

  it('the still is there from the first frame: it does not wait for WebGL, the scene or anything else', () => {
    // No `v-if` on the image: it is the base, and the live scene is drawn over it.
    expect(orbSource).toMatch(/<img class="glass-orb-still"[^>]*\/>/);
    expect(orbSource).not.toMatch(/<img[^>]*v-if/);
  });

  it('animates only on screen, in a visible tab, with motion allowed', () => {
    expect(glassShouldAnimate({ onScreen: true, tabVisible: true, reducedMotion: false })).toBe(true);
    expect(glassShouldAnimate({ onScreen: false, tabVisible: true, reducedMotion: false })).toBe(false);
    expect(glassShouldAnimate({ onScreen: true, tabVisible: false, reducedMotion: false })).toBe(false);
    expect(glassShouldAnimate({ onScreen: true, tabVisible: true, reducedMotion: true })).toBe(false);
  });

  it('caps the frame rate and the backing resolution', () => {
    expect(GLASS_FRAME_MS).toBeGreaterThanOrEqual(1000 / 30);
    expect(GLASS_MAX_DPR).toBeLessThanOrEqual(2);
    expect(GLASS_STILL_TIME).toBeGreaterThan(0);
    expect(orbSource).toContain('Math.min(window.devicePixelRatio || 1, GLASS_MAX_DPR)');
  });

  it('gives up on a slow WebGL: once enough frames are in and they come too slowly, the still takes over', () => {
    const fast = Array.from({ length: GLASS_PROBE_FRAMES }, () => GLASS_FRAME_MS);
    const slow = Array.from({ length: GLASS_PROBE_FRAMES }, () => GLASS_SLOW_MS + 20);
    expect(glassTooSlow(fast)).toBe(false);
    expect(glassTooSlow(slow)).toBe(true);
    // A good start followed by a sustained slow stretch is slow too.
    expect(glassTooSlow([...fast, ...slow])).toBe(true);
  });

  it('does not judge on a few frames, or on one long one (negative)', () => {
    expect(glassTooSlow([])).toBe(false);
    expect(glassTooSlow([400, 400, 400])).toBe(false);
    const oneHiccup = Array.from({ length: GLASS_PROBE_FRAMES }, (_unused, index) => (index === 3 ? 300 : GLASS_FRAME_MS));
    expect(glassTooSlow(oneHiccup)).toBe(false);
  });

  it('one renderer on a page: a second object does not get one until the first lets go', () => {
    const first = Symbol('first');
    const second = Symbol('second');
    expect(claimGlassRenderer(first)).toBe(true);
    expect(claimGlassRenderer(first)).toBe(true);
    expect(claimGlassRenderer(second)).toBe(false);
    // Letting go of what is not yours changes nothing.
    releaseGlassRenderer(second);
    expect(claimGlassRenderer(second)).toBe(false);
    releaseGlassRenderer(first);
    expect(claimGlassRenderer(second)).toBe(true);
    releaseGlassRenderer(second);
  });

  it('is physically based glass: transmission across a thickness, an index of refraction, a little iridescence', () => {
    expect(GLASS_MATERIAL.transmission).toBe(1);
    expect(GLASS_MATERIAL.thickness).toBeGreaterThan(0);
    expect(GLASS_MATERIAL.ior).toBeGreaterThan(1.3);
    expect(GLASS_MATERIAL.ior).toBeLessThan(1.7);
    expect(GLASS_MATERIAL.iridescence).toBeGreaterThan(0);
    expect(GLASS_MATERIAL.iridescence).toBeLessThan(1);
    expect(GLASS_MATERIAL.roughness).toBeLessThan(0.2);
    // …and the scene uses exactly those numbers.
    expect(sceneSource).toContain('new MeshPhysicalMaterial({');
    for (const name of ['transmission', 'thickness', 'ior', 'iridescence', 'dispersion']) {
      expect(sceneSource, name).toContain(`${name}: GLASS_MATERIAL.${name}`);
    }
  });

  it('is this project’s own scene: geometry and a studio made in code — no model, no texture file, nothing fetched', () => {
    expect(sceneSource).toContain('TorusGeometry');
    expect(sceneSource).toContain('PMREMGenerator');
    expect(/TextureLoader|GLTFLoader|ImageLoader|FileLoader|fetch\(|https?:\/\//.test(sceneSource)).toBe(false);
    expect(/\.(png|jpe?g|webp|hdr|exr|glb|gltf)['"`]/.test(sceneSource)).toBe(false);
  });

  it('three.js is loaded lazily, from one place: only the scene imports it, and the scene is a dynamic import', () => {
    const importers = Object.entries(sources)
      .filter(([, source]) => /from\s+['"]three(\/[^'"]*)?['"]|import\(\s*['"]three/.test(source))
      .map(([path]) => path);
    expect(importers).toEqual(['../src/components/ui/glassScene.js']);
    // The scene itself is reached only through `import()`, so three is a chunk of its own.
    const staticScene = Object.entries(sources)
      .filter(([, source]) => /import\s+[^;]*from\s+['"][^'"]*glassScene(\.js)?['"]/.test(source.replace(/import\s+type\s+[^;]*;/g, '')))
      .map(([path]) => path);
    expect(staticScene).toEqual([]);
    expect(orbSource).toContain("await import('./glassScene.js')");
  });

  it('does not load the scene at all without WebGL (negative)', async () => {
    const wrapper = mount(GlassOrb, { props: { size: 120 }, attachTo: document.body });
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(wrapper.get('.glass-orb').attributes('data-glass')).toBe('still');
    // Nothing claimed the page's renderer either.
    const probe = Symbol('probe');
    expect(claimGlassRenderer(probe)).toBe(true);
    releaseGlassRenderer(probe);
    wrapper.unmount();
  });
});
