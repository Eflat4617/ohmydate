// @vitest-environment node
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORE_READY_FILE_ENV, CoreReadyFileError, coreApiProxy, readCoreReadyFile } from '../config/coreProxy';

/**
 * RC-10B: the desktop dev server's `/api` proxy (config/coreProxy.ts;
 * blueprint 15 §7.3 items 8–9). It adds the core's launch token on the way
 * to the core, and the token is found nowhere else.
 */
const TOKEN = 'synthetic-launch-token-0123456789abcdef0123456789abcdef';
let dir: string;

function readyFile(content: string, mode = 0o600): string {
  const path = join(dir, 'ready.json');
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omd-core-proxy-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the core’s ready file', () => {
  it('gives the port and the token', () => {
    expect(readCoreReadyFile(readyFile(JSON.stringify({ port: 40123, token: TOKEN, pid: 7 })))).toEqual({ port: 40123, token: TOKEN });
  });

  it('is refused when it is missing, not JSON, incomplete or readable by others — without repeating what it holds (negative)', () => {
    const failures: unknown[] = [];
    const attempt = (path: string): void => {
      try {
        readCoreReadyFile(path);
        failures.push(null);
      } catch (error) {
        failures.push(error);
      }
    };
    attempt(join(dir, 'absent.json'));
    attempt(readyFile(`{"port": 40123, "token": "${TOKEN}"`));
    attempt(readyFile(JSON.stringify({ token: TOKEN })));
    attempt(readyFile(JSON.stringify({ port: 0, token: TOKEN })));
    attempt(readyFile(JSON.stringify({ port: 70000, token: TOKEN })));
    attempt(readyFile(JSON.stringify({ port: '40123', token: TOKEN })));
    attempt(readyFile(JSON.stringify({ port: 40123, token: '' })));
    attempt(readyFile('null'));
    attempt(readyFile(JSON.stringify({ port: 40123, token: TOKEN }), 0o644));
    attempt(readyFile(JSON.stringify({ port: 40123, token: TOKEN }), 0o640));
    expect(failures).toHaveLength(10);
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(CoreReadyFileError);
      expect((failure as Error).message).not.toContain(TOKEN);
      expect(inspect(failure)).not.toContain(TOKEN);
    }
    expect((failures[8] as Error).message).toContain('0600');
  });
});

describe('the `/api` proxy to the core', () => {
  function headersSentBy(options: ReturnType<typeof coreApiProxy>, fromPage: Record<string, string> = {}): Record<string, string> {
    const proxy = new EventEmitter();
    options.configure?.(proxy as never, {} as never);
    const headers: Record<string, string> = { ...fromPage };
    proxy.emit('proxyReq', {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
    });
    return headers;
  }

  it('reaches the core on loopback with its own Host, and adds the token to the upstream request', () => {
    const options = coreApiProxy(readyFile(JSON.stringify({ port: 40123, token: TOKEN })));
    expect(options.target).toBe('http://127.0.0.1:40123');
    expect(options.changeOrigin).toBe(true);
    expect(headersSentBy(options)).toEqual({ authorization: `Bearer ${TOKEN}` });
    // The browser's Origin is left as it is (the core allows the dev server's).
    expect(headersSentBy(options, { origin: 'http://127.0.0.1:5173' })).toMatchObject({ origin: 'http://127.0.0.1:5173' });
  });

  it('replaces whatever the page sent under that name (negative: a page cannot pick the token)', () => {
    const options = coreApiProxy(readyFile(JSON.stringify({ port: 40123, token: TOKEN })));
    expect(headersSentBy(options, { authorization: 'Bearer from-the-page' }).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('keeps the token out of the options themselves: a printed config does not show it', () => {
    const options = coreApiProxy(readyFile(JSON.stringify({ port: 40123, token: TOKEN })));
    expect(JSON.stringify(options)).not.toContain(TOKEN);
    expect(inspect(options, { depth: 10, showHidden: true })).not.toContain(TOKEN);
    expect(options).not.toHaveProperty('headers');
    expect(options).not.toHaveProperty('auth');
  });

  it('is given the file by a variable the browser bundle never sees', () => {
    // Vite exposes only `VITE_*` to the page.
    expect(CORE_READY_FILE_ENV).toBe('OHMYDATE_CORE_READY_FILE');
    expect(CORE_READY_FILE_ENV.startsWith('VITE_')).toBe(false);
  });

  it('without a usable ready file there is no proxy at all (negative)', () => {
    expect(() => coreApiProxy(join(dir, 'absent.json'))).toThrow(CoreReadyFileError);
  });
});
