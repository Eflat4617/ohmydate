import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import GlassOrb from '../src/components/ui/GlassOrb.vue';
import {
  GLASS_FRAME_MS,
  GLASS_MAX_DPR,
  createGlassRenderer,
  glassShouldAnimate,
  webglAvailable,
} from '../src/components/ui/glassOrb';
import { GLASS_FRAGMENT_SHADER, GLASS_STILL_TIME, GLASS_VERTEX_SHADER } from '../src/components/ui/glassOrbShader';

/**
 * HOLO-01 glass object: the project's own WebGL shader on a canvas, with a
 * still image where WebGL is missing (jsdom has none, so that is what these
 * tests see), and rules for when it may animate.
 */
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

  it('falls back when the browser has the API but gives no context (negative)', () => {
    vi.stubGlobal('WebGLRenderingContext', class {});
    const canvas = document.createElement('canvas');
    canvas.getContext = (() => null) as typeof canvas.getContext;
    expect(createGlassRenderer(canvas)).toBeNull();
    canvas.getContext = (() => {
      throw new Error('blocked');
    }) as typeof canvas.getContext;
    expect(createGlassRenderer(canvas)).toBeNull();
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
  });

  it('is this project’s own shader: three uniforms, no texture, nothing fetched', () => {
    expect(GLASS_VERTEX_SHADER).toContain('attribute vec2 a_pos');
    expect(GLASS_FRAGMENT_SHADER).toContain('uniform vec2 u_res');
    expect(GLASS_FRAGMENT_SHADER).toContain('uniform float u_time');
    expect(GLASS_FRAGMENT_SHADER).toContain('uniform float u_light');
    expect(/sampler2D|texture2D|https?:/.test(GLASS_FRAGMENT_SHADER)).toBe(false);
  });
});
