// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config';

/**
 * RC-10BR (review finding): the guard in rc-10b-desktop-mode.spec.ts catches a
 * source regression, but not a build that is configured wrong. `local:start`
 * serves `dist/`; a desktop bundle there would be a deployed app with no login
 * form. So the build's own wiring is pinned: the deployed build is the server
 * mode and lands in `dist/`, and only the desktop build lands elsewhere.
 */
type ConfigFn = (env: { mode: string; command: 'build' | 'serve' }) => {
  build?: { outDir?: string };
  publicDir?: string | false;
};

const configFor = (mode: string, command: 'build' | 'serve' = 'build') => (viteConfig as unknown as ConfigFn)({ mode, command });

const here = dirname(fileURLToPath(import.meta.url));
const scripts = (JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;

describe('the two bundles never share a directory', () => {
  it('the deployed build is the server bundle, in dist/', () => {
    expect(configFor('production').build?.outDir).toBe('dist');
    expect(configFor('production').publicDir).toBe('public');
    // `vite build` with no --mode is mode "production": the script must not name another.
    expect(scripts['build']).toBe('vite build');
  });

  it('only the desktop mode builds a desktop bundle, and never into dist/ (negative)', () => {
    expect(configFor('desktop').build?.outDir).toBe('desktop/dist');
    expect(configFor('desktop').build?.outDir).not.toBe('dist');
    expect(scripts['build:desktop']).toContain('--mode desktop');
    for (const mode of ['production', 'development', 'test', 'staging', '']) {
      expect(configFor(mode).build?.outDir, `mode "${mode}"`).toBe('dist');
    }
  });
});
