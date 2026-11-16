import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The core binary under test: `OHMYDATE_CORE_BIN`, else the debug build.
 *
 * It must be the test build (`corepack pnpm run core:build`: cargo feature
 * `test-clock`), because `lifecycle.test.ts` moves the clock. A build
 * without the feature — what gets packaged — refuses `--clock-offset-ms`.
 */
export function coreBinary(): string {
  const binary =
    process.env['OHMYDATE_CORE_BIN'] ?? join(repoRoot, 'core/target/debug/ohmydate-core');
  if (!existsSync(binary)) {
    throw new Error(
      `core binary not found at ${binary}. Build it first: ` +
        '`corepack pnpm run core:build` (which `core:parity` runs before the suite).',
    );
  }
  return binary;
}

export interface CoreResponse {
  readonly status: number;
  readonly headers: Headers;
  /** Parsed JSON body, or `undefined` for an empty body. */
  readonly body: unknown;
}

export interface RequestOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** `false` sends the request without the launch token. */
  readonly authenticated?: boolean;
}

/** A response as it came off the socket: nothing parsed, nothing followed. */
export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A running core process on a private data directory. */
export interface Core {
  readonly baseUrl: string;
  readonly dataDir: string;
  /** The launch token of this process (what the shell would put in `/__boot`). */
  readonly token: string;
  request(method: string, path: string, options?: RequestOptions): Promise<CoreResponse>;
  /**
   * Sends `path` exactly as written — `fetch` would tidy `..` away — with
   * only the headers given: no launch token, no cookie.
   */
  raw(method: string, path: string, headers?: Readonly<Record<string, string>>): Promise<RawResponse>;
  /** Everything the process has written to its log (stderr) so far. */
  logs(): string;
  /** Stops the process (SIGTERM, graceful drain). The data directory is kept. */
  stop(): Promise<number | null>;
  /** Stops the process and deletes its data directory. */
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Reuse an existing data directory (restart tests). */
  readonly dataDir?: string;
  /** Serve the built web app in this directory (`--web-dir`). */
  readonly webDir?: string;
  /** Log level of the process; the default keeps request lines out. */
  readonly logLevel?: 'debug' | 'info' | 'warn';
  /** More command-line arguments. */
  readonly args?: readonly string[];
  /** More environment variables. */
  readonly env?: Readonly<Record<string, string>>;
}

/** The web fixture of the server crate: shaped like the output of `vite build`. */
export const WEB_FIXTURE = join(repoRoot, 'core/crates/server/tests/fixtures/web');

async function waitForReadyFile(
  path: string,
  child: ChildProcess,
): Promise<{ port: number; token: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`core exited with code ${child.exitCode} before it was ready`);
    }
    try {
      return JSON.parse(await readFile(path, 'utf8')) as { port: number; token: string };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('core did not write its ready file within 10 s');
}

/**
 * Starts the Rust core on a temporary data directory and returns a client for
 * it. The owner's time zone and locale are fixed so runs are repeatable.
 */
export async function startCore(options: StartOptions = {}): Promise<Core> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'ohmydate-parity-')));
  const readyFile = join(dataDir, `ready-${process.pid}-${Date.now()}.json`);
  const child = spawn(
    coreBinary(),
    [
      '--data-dir', dataDir,
      '--ready-file', readyFile,
      '--time-zone', 'Asia/Seoul',
      '--locale', 'ko-KR',
      ...(options.webDir === undefined ? [] : ['--web-dir', options.webDir]),
      ...(options.args ?? []),
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...options.env, OHMYDATE_LOG: options.logLevel ?? 'warn' },
    },
  );
  let log = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    log += chunk;
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  const { port, token } = await waitForReadyFile(readyFile, child);
  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<number | null> => {
    if (child.exitCode === null) child.kill('SIGTERM');
    return exited;
  };

  return {
    baseUrl,
    dataDir,
    token,
    logs: () => log,
    raw(method, path, headers = {}) {
      return new Promise<RawResponse>((resolve, reject) => {
        const outgoing = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
          });
          response.on('error', reject);
        });
        outgoing.on('error', reject);
        outgoing.end();
      });
    },
    async request(method, path, requestOptions = {}) {
      const headers = new Headers(requestOptions.headers);
      if (requestOptions.authenticated !== false) headers.set('authorization', `Bearer ${token}`);
      const init: RequestInit = { method, headers, redirect: 'manual' };
      if (requestOptions.body !== undefined) {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(requestOptions.body);
      }
      const response = await fetch(`${baseUrl}${path}`, init);
      const text = await response.text();
      return {
        status: response.status,
        headers: response.headers,
        body: text.length === 0 ? undefined : (JSON.parse(text) as unknown),
      };
    },
    stop,
    async dispose() {
      await stop();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Runs the binary to completion and returns its exit code (lifecycle tests). */
export async function runCoreToExit(args: readonly string[]): Promise<number | null> {
  const child = spawn(coreBinary(), [...args], { stdio: 'ignore' });
  return new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}
