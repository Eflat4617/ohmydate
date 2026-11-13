import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The core binary under test: `OHMYDATE_CORE_BIN`, else the debug build. */
export function coreBinary(): string {
  const binary =
    process.env['OHMYDATE_CORE_BIN'] ?? join(repoRoot, 'core/target/debug/ohmydate-core');
  if (!existsSync(binary)) {
    throw new Error(
      `core binary not found at ${binary}. Build it first: ` +
        '`corepack pnpm run core:parity` does, or run `cargo build -p ohmydate-server` in core/.',
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

/** A running core process on a private data directory. */
export interface Core {
  readonly baseUrl: string;
  readonly dataDir: string;
  request(method: string, path: string, options?: RequestOptions): Promise<CoreResponse>;
  /** Stops the process (SIGTERM, graceful drain). The data directory is kept. */
  stop(): Promise<number | null>;
  /** Stops the process and deletes its data directory. */
  dispose(): Promise<void>;
}

export interface StartOptions {
  /** Reuse an existing data directory (restart tests). */
  readonly dataDir?: string;
}

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
    ],
    { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, OHMYDATE_LOG: 'warn' } },
  );
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
