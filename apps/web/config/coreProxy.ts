import { readFileSync, statSync } from 'node:fs';
import type { ProxyOptions } from 'vite';

/**
 * The dev server's `/api` proxy to a running Rust core (blueprint 15 §7.3,
 * items 8–9; `corepack pnpm run core:dev` starts both).
 *
 * The core lets a request in only with its launch token (15 §1.3). A page
 * served by Vite has no launch cookie — the cookie belongs to the core's own
 * origin — so the proxy adds the token as `Authorization: Bearer …` on the
 * way through. The token is a secret:
 *
 * - it is read from the core's ready file (0600), whose **path** is all the
 *   launcher passes on — never the token in an argument or an environment
 *   variable;
 * - it never reaches the browser: nothing here goes through `define` or a
 *   `VITE_` variable, the header is added to the upstream request only;
 * - it is not part of the options object (it lives in a closure), so a
 *   printed Vite config (`DEBUG=vite:config`) does not show it.
 *
 * `changeOrigin` stays on: the core checks `Host` against its own address.
 * The browser's `Origin` (the dev server's) is passed through untouched; the
 * core is started with `--allow-origin` for it.
 */
export interface CoreReady {
  readonly port: number;
  readonly token: string;
}

/** Thrown for a ready file that cannot be used. Its message never holds the file's contents. */
export class CoreReadyFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreReadyFileError';
  }
}

/** Reads `{port, token}` from the core's ready file. The file must be private to its owner. */
export function readCoreReadyFile(path: string): CoreReady {
  let mode: number;
  let text: string;
  try {
    mode = statSync(path).mode & 0o777;
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CoreReadyFileError(`the core's ready file cannot be read: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new CoreReadyFileError(`the core's ready file must be private (0600), not ${mode.toString(8)}: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CoreReadyFileError(`the core's ready file is not JSON: ${path}`);
  }
  const ready = parsed as { port?: unknown; token?: unknown } | null;
  if (
    ready === null ||
    typeof ready !== 'object' ||
    typeof ready.port !== 'number' ||
    !Number.isInteger(ready.port) ||
    ready.port < 1 ||
    ready.port > 65535 ||
    typeof ready.token !== 'string' ||
    ready.token.length === 0
  ) {
    throw new CoreReadyFileError(`the core's ready file has no port and token: ${path}`);
  }
  return { port: ready.port, token: ready.token };
}

/** Proxy options for `/api` that reach the core named by `readyFile` and carry its token. */
export function coreApiProxy(readyFile: string): ProxyOptions {
  const { port, token } = readCoreReadyFile(readyFile);
  return {
    target: `http://127.0.0.1:${port}`,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (upstream) => {
        // Whatever the page sent under this name is replaced, never forwarded.
        upstream.setHeader('authorization', `Bearer ${token}`);
      });
    },
  };
}

/** The variable `core:dev` sets for the dev server: the path of the core's ready file. */
export const CORE_READY_FILE_ENV = 'OHMYDATE_CORE_READY_FILE';
