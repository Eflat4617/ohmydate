// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { AllowedHostError, WEB_ALLOWED_HOSTS_ENV, allowedHostsFromEnv } from '../config/allowedHosts';
import viteConfig from '../vite.config';

/**
 * Reaching the app from a phone through a private network name
 * (`tailscale serve`): the built web answers loopback names, plus the exact
 * names this machine's settings list — and nothing looser.
 */
type ConfigFn = (env: { mode: string; command: 'build' | 'serve' }) => { preview?: { allowedHosts?: string[] } };
const configFor = (mode: string) => (viteConfig as unknown as ConfigFn)({ mode, command: 'serve' });

const saved = process.env[WEB_ALLOWED_HOSTS_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[WEB_ALLOWED_HOSTS_ENV];
  else process.env[WEB_ALLOWED_HOSTS_ENV] = saved;
});

describe('allowedHostsFromEnv', () => {
  it('reads exact names: trimmed, lower-cased, without a trailing dot, once each', () => {
    expect(
      allowedHostsFromEnv({ [WEB_ALLOWED_HOSTS_ENV]: ' Laptop.Tail1234.ts.net. , laptop.tail1234.ts.net,other.example.org ' }),
    ).toEqual(['laptop.tail1234.ts.net', 'other.example.org']);
  });

  it('is empty when nothing is set (loopback only)', () => {
    expect(allowedHostsFromEnv({})).toEqual([]);
    expect(allowedHostsFromEnv({ [WEB_ALLOWED_HOSTS_ENV]: '  ' })).toEqual([]);
    expect(allowedHostsFromEnv({ [WEB_ALLOWED_HOSTS_ENV]: ' , ,' })).toEqual([]);
  });

  it.each([
    ['a wildcard', '*.ts.net'],
    ['a leading dot (a whole domain)', '.ts.net'],
    ['a port', 'laptop.tail1234.ts.net:443'],
    ['a scheme', 'https://laptop.tail1234.ts.net'],
    ['a path', 'laptop.tail1234.ts.net/x'],
    ['a single label', 'laptop'],
    ['a space inside', 'lap top.ts.net'],
    ['an underscore', 'lap_top.ts.net'],
    ['"true" (allow everything)', 'true'],
  ])('refuses %s (negative)', (_what, value) => {
    expect(() => allowedHostsFromEnv({ [WEB_ALLOWED_HOSTS_ENV]: value })).toThrow(AllowedHostError);
    // One bad entry spoils the list: the server must not start half-open.
    expect(() => allowedHostsFromEnv({ [WEB_ALLOWED_HOSTS_ENV]: `ok.example.org,${value}` })).toThrow(AllowedHostError);
  });
});

describe('the preview server', () => {
  it('answers the listed names in the server web', () => {
    process.env[WEB_ALLOWED_HOSTS_ENV] = 'laptop.tail1234.ts.net';
    expect(configFor('production').preview?.allowedHosts).toEqual(['laptop.tail1234.ts.net']);
  });

  it('keeps Vite\'s loopback-only default when nothing is listed (negative)', () => {
    delete process.env[WEB_ALLOWED_HOSTS_ENV];
    expect(configFor('production').preview).toBeUndefined();
  });

  it('never opens the desktop web to other names (negative)', () => {
    process.env[WEB_ALLOWED_HOSTS_ENV] = 'laptop.tail1234.ts.net';
    const desktop = (viteConfig as unknown as (env: { mode: string; command: 'build' }) => { preview?: unknown })({
      mode: 'desktop',
      command: 'build',
    });
    expect(desktop.preview).toBeUndefined();
  });
});
