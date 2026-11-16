import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext, localSettings } from './common.mjs';
import { webEnvironment } from './start.mjs';

/**
 * This machine's own settings (`.local/local.override.env`, never committed)
 * are read after `deploy/local/local.env`, and the web server is told which
 * extra host names it may answer — only when some are listed.
 */
const tempDirs = [];
afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop(), { recursive: true, force: true });
});

async function files(base, override) {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-hosts-'));
  tempDirs.push(dir);
  const env = { OHMYDATE_LOCAL_ENV_FILE: join(dir, 'local.env'), OHMYDATE_LOCAL_OVERRIDE_FILE: join(dir, 'override.env') };
  await writeFile(env.OHMYDATE_LOCAL_ENV_FILE, base);
  if (override !== null) await writeFile(env.OHMYDATE_LOCAL_OVERRIDE_FILE, override);
  return env;
}

describe('local settings: the per-machine override file', () => {
  test('is read after the committed file and wins', async () => {
    const env = await files('WEB_PORT=5180\nAPI_PORT=3100\n', 'WEB_ALLOWED_HOSTS=laptop.tail1234.ts.net\nWEB_PORT=5999\n');
    const settings = localSettings(env);
    expect(settings.WEB_ALLOWED_HOSTS).toBe('laptop.tail1234.ts.net');
    expect(settings.WEB_PORT).toBe('5999');
    expect(settings.API_PORT).toBe('3100');
    expect(createContext(env).webAllowedHosts).toBe('laptop.tail1234.ts.net');
  });

  test('a missing override file changes nothing (negative)', async () => {
    const env = await files('WEB_PORT=5180\n', null);
    expect(localSettings(env).WEB_PORT).toBe('5180');
    expect(localSettings(env).WEB_ALLOWED_HOSTS).toBeUndefined();
    expect(createContext(env).webAllowedHosts).toBe('');
  });
});

describe('the web server process', () => {
  test('is told the extra host names when some are listed', async () => {
    const env = await files('', 'WEB_ALLOWED_HOSTS=laptop.tail1234.ts.net\n');
    expect(webEnvironment(createContext(env), 'marker')['OHMYDATE_WEB_ALLOWED_HOSTS']).toBe('laptop.tail1234.ts.net');
  });

  test('gets no such setting otherwise: loopback only (negative)', async () => {
    const env = await files('', null);
    const web = webEnvironment(createContext(env), 'marker');
    expect('OHMYDATE_WEB_ALLOWED_HOSTS' in web).toBe(false);
    expect(webEnvironment({ ...createContext(env), webAllowedHosts: '   ' }, 'marker')).not.toHaveProperty('OHMYDATE_WEB_ALLOWED_HOSTS');
  });
});
