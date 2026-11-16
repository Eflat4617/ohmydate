import { describe, expect, it } from 'vitest';
import {
  CORE_READY_FILE_ENV,
  DEFAULT_WEB_PORT,
  UsageError,
  cargoEnv,
  coreArgs,
  devOrigins,
  parseArgs,
  viteArgs,
  viteEnv,
} from './dev.mjs';

// RC-10B: `corepack pnpm run core:dev` (blueprint 15 §7.3 items 8–9). The
// pieces that decide what the two processes are started with; the launch
// token is in none of them.

describe('core:dev — its own arguments', () => {
  it('needs none: a temporary data directory and the usual port', () => {
    expect(parseArgs([])).toEqual({ dataDir: null, port: DEFAULT_WEB_PORT, timeZone: null, locale: null, skipBuild: false, help: false });
    expect(DEFAULT_WEB_PORT).toBe(5173);
  });

  it('takes a data directory, a port, the owner’s zone and locale, and --skip-build (pnpm’s bare `--` is ignored)', () => {
    const parsed = parseArgs(['--', '--data-dir', '/tmp/omd-dev', '--port', '5999', '--time-zone', 'Asia/Seoul', '--locale', 'ko-KR', '--skip-build']);
    expect(parsed).toEqual({ dataDir: '/tmp/omd-dev', port: 5999, timeZone: 'Asia/Seoul', locale: 'ko-KR', skipBuild: true, help: false });
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('refuses what it does not know, a missing value and a port that is not one (negative)', () => {
    expect(() => parseArgs(['--token', 'abc'])).toThrow(UsageError);
    expect(() => parseArgs(['--clock-offset-ms', '5'])).toThrow(UsageError);
    expect(() => parseArgs(['--data-dir'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--data-dir', '--port'])).toThrow(/needs a value/);
    for (const port of ['0', '65536', '-1', '80a', '5173.5', '']) {
      expect(() => parseArgs(['--port', port]), port).toThrow(UsageError);
    }
  });
});

describe('core:dev — what the two processes are started with', () => {
  it('the core allows the dev server’s origin under both of its names, and only those', () => {
    expect(devOrigins(5173)).toEqual(['http://127.0.0.1:5173', 'http://localhost:5173']);
    const args = coreArgs({ dataDir: '/d', readyFile: '/r/ready.json', port: 5999, timeZone: null, locale: null });
    expect(args).toEqual([
      '--data-dir', '/d',
      '--ready-file', '/r/ready.json',
      '--allow-origin', 'http://127.0.0.1:5999',
      '--allow-origin', 'http://localhost:5999',
    ]);
    // Development never moves the clock and never serves the built web.
    expect(args).not.toContain('--clock-offset-ms');
    expect(args).not.toContain('--web-dir');
    expect(coreArgs({ dataDir: '/d', readyFile: '/r', port: 1, timeZone: 'Asia/Seoul', locale: 'ko-KR' }).slice(-4)).toEqual([
      '--time-zone', 'Asia/Seoul', '--locale', 'ko-KR',
    ]);
  });

  it('the dev server runs in desktop mode on exactly the allowed port', () => {
    expect(viteArgs(5999)).toEqual(['--mode', 'desktop', '--host', '127.0.0.1', '--port', '5999', '--strictPort']);
  });

  it('the dev server is told where the ready file is — a path, never a token — and gets no mock switch', () => {
    const env = viteEnv({ PATH: '/usr/bin', VITE_MOCK: '1', HOME: '/home/x' }, '/run/ready.json');
    expect(env[CORE_READY_FILE_ENV]).toBe('/run/ready.json');
    expect(CORE_READY_FILE_ENV.startsWith('VITE_')).toBe(false);
    expect(env).not.toHaveProperty('VITE_MOCK');
    expect(env.PATH).toBe('/usr/bin');
    // Nothing the browser bundle can see was added (Vite exposes only VITE_*).
    expect(Object.keys(env).filter((name) => name.startsWith('VITE_'))).toEqual([]);
  });

  it('cargo is found where rustup puts it, and the build takes four jobs unless told otherwise', () => {
    const env = cargoEnv({ PATH: '/usr/bin', HOME: '/home/x' });
    expect(env.PATH.split(':')[0]).toMatch(/\.cargo\/bin$/);
    expect(env.PATH.endsWith('/usr/bin')).toBe(true);
    expect(env.CARGO_BUILD_JOBS).toBe('4');
    expect(cargoEnv({ PATH: env.PATH, CARGO_BUILD_JOBS: '2' })).toMatchObject({ PATH: env.PATH, CARGO_BUILD_JOBS: '2' });
  });
});
