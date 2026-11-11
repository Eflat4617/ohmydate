import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import {
  createSchema,
  databaseUrl,
  dropSchema,
  hasDatabase,
  makeSchemaName,
  requireDatabaseUrl,
} from './db/helpers.js';
import {
  API_DIST_BUILD_ID_KEY,
  API_DIST_ROOT_KEY,
  apiBuildWorkspaceEnv,
  apiDistArtifact,
  assertApiDistArtifact,
  createApiBuildWorkspace,
  hasApiDistArtifact,
  removeApiBuildWorkspace,
  type ApiBuildWorkspace,
} from './support/dist-artifact.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
// The compiled app is built once by vitest globalSetup into a build workspace
// private to this invocation; nothing else builds into or removes it, so no
// lease is needed. The fixture is the workspace copy, whose `../../dist`
// imports resolve to that same private artifact. See support/dist-artifact.ts.
const distArtifact = apiDistArtifact(inject(API_DIST_ROOT_KEY));
const expectedBuildId = inject(API_DIST_BUILD_ID_KEY);
const distMain = distArtifact.mainPath;
const slowFixture = join(distArtifact.apiRoot, 'test', 'support', 'slow-app.mjs');
assertApiDistArtifact(distArtifact, expectedBuildId);

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HTTP_')) delete env[key];
  }
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a TCP port'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Spawned {
  readonly child: ChildProcess;
  readonly stderr: () => string;
}

function spawnApp(script: string, env: NodeJS.ProcessEnv): Spawned {
  let stderr = '';
  const child = spawn(process.execPath, [script], {
    cwd: apiRoot,
    env: { ...baseEnv(), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => undefined);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, stderr: () => stderr };
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('timed out waiting for the process to exit'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  spawned: Spawned,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawned.child.exitCode !== null) {
      throw new Error(
        `app exited before /healthz (${String(spawned.child.exitCode)})\n${spawned.stderr()}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`timed out waiting for /healthz\n${spawned.stderr()}`);
}

async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (response.status !== 204) {
    throw new Error(`login failed: ${String(response.status)} ${await response.text()}`);
  }
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ');
}

function stop(child: ChildProcess | undefined): void {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
}

describe.skipIf(!hasDatabase)('production HTTP timeout regressions', () => {
  let schema: string;

  beforeEach(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: requireDatabaseUrl(), schema });
  });

  afterEach(async () => {
    await dropSchema(schema);
  });

  test(
    'a trickling body is cut before the shutdown deadline and exits 0',
    async () => {
      const port = await freePort();
      const spawned = spawnApp(distMain, {
        DATABASE_URL: databaseUrl as string,
        PGOPTIONS: `-c search_path=${schema}`,
        PROVIDER: 'vikunja',
        PUSH_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
        VIKUNJA_URL: 'http://127.0.0.1:9',
        VIKUNJA_RECONCILE_INTERVAL_MS: '0',
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'silent',
      });
      let socket: net.Socket | undefined;
      let trickle: NodeJS.Timeout | undefined;
      try {
        await waitForHealth(`http://127.0.0.1:${String(port)}`, spawned);
        socket = net.connect(port, '127.0.0.1');
        await new Promise<void>((resolve, reject) => {
          socket?.once('connect', resolve);
          socket?.once('error', reject);
        });
        socket.write(
          'POST /api/v1/auth/login HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\nContent-Type: application/json\r\n' +
            'Content-Length: 100000\r\n\r\n',
        );
        trickle = setInterval(() => {
          if (socket !== undefined && !socket.destroyed) socket.write(' ');
        }, 200);

        await delay(100);
        const startedAt = Date.now();
        spawned.child.kill('SIGTERM');
        const { code, signal } = await waitForExit(spawned.child, 20_000);
        const elapsed = Date.now() - startedAt;

        expect(code).toBe(0);
        expect(signal).toBeNull();
        expect(elapsed).toBeLessThan(5_000);
        expect(spawned.stderr()).not.toContain('graceful shutdown timed out');
      } finally {
        if (trickle !== undefined) clearInterval(trickle);
        socket?.destroy();
        stop(spawned.child);
        await waitForExit(spawned.child, 5_000).catch(() => undefined);
      }
    },
    60_000,
  );

  test(
    'an authenticated handler over 10s still succeeds with production defaults',
    async () => {
      const port = await freePort();
      const email = `slow-${randomUUID()}@example.com`;
      const password = 'slow-handler-password';
      const spawned = spawnApp(slowFixture, {
        DATABASE_URL: databaseUrl as string,
        PGOPTIONS: `-c search_path=${schema}`,
        HOST: '127.0.0.1',
        PORT: String(port),
        SLOW_HANDLER_MS: '11000',
        TEST_EMAIL: email,
        TEST_PASSWORD: password,
      });
      try {
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        await waitForHealth(baseUrl, spawned);
        const cookie = await login(baseUrl, email, password);

        const startedAt = Date.now();
        const response = await fetch(`${baseUrl}/api/v1/projects`, {
          headers: { cookie },
        });
        const elapsed = Date.now() - startedAt;

        expect(response.status).toBe(200);
        expect(elapsed).toBeGreaterThan(10_500);
        expect(elapsed).toBeLessThan(20_000);
      } finally {
        stop(spawned.child);
        await waitForExit(spawned.child, 5_000).catch(() => undefined);
      }
    },
    60_000,
  );

  test(
    'SIGTERM during an 11s handler drains it, delivers the response and exits 0',
    async () => {
      const port = await freePort();
      const email = `slow-${randomUUID()}@example.com`;
      const password = 'slow-handler-password';
      const spawned = spawnApp(slowFixture, {
        DATABASE_URL: databaseUrl as string,
        PGOPTIONS: `-c search_path=${schema}`,
        HOST: '127.0.0.1',
        PORT: String(port),
        SLOW_HANDLER_MS: '11000',
        TEST_EMAIL: email,
        TEST_PASSWORD: password,
      });
      try {
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        await waitForHealth(baseUrl, spawned);
        const cookie = await login(baseUrl, email, password);

        const pending = fetch(`${baseUrl}/api/v1/projects`, { headers: { cookie } });
        await delay(500);
        const startedAt = Date.now();
        spawned.child.kill('SIGTERM');

        const response = await pending;
        expect(response.status).toBe(200);

        const { code, signal } = await waitForExit(spawned.child, 20_000);
        expect(code).toBe(0);
        expect(signal).toBeNull();
        expect(Date.now() - startedAt).toBeLessThan(15_000);
      } finally {
        stop(spawned.child);
        await waitForExit(spawned.child, 5_000).catch(() => undefined);
      }
    },
    60_000,
  );

  test(
    'a complete handler drains despite an incomplete pipelined body and exits 0',
    async () => {
      const port = await freePort();
      const email = `slow-${randomUUID()}@example.com`;
      const password = 'slow-handler-pipeline-password';
      const spawned = spawnApp(slowFixture, {
        DATABASE_URL: databaseUrl as string,
        PGOPTIONS: `-c search_path=${schema}`,
        HOST: '127.0.0.1',
        PORT: String(port),
        SLOW_HANDLER_MS: '800',
        TEST_EMAIL: email,
        TEST_PASSWORD: password,
      });
      let socket: net.Socket | undefined;
      try {
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        await waitForHealth(baseUrl, spawned);
        const cookie = await login(baseUrl, email, password);

        socket = net.connect(port, '127.0.0.1');
        const connected = socket;
        await new Promise<void>((resolve, reject) => {
          connected.once('connect', resolve);
          connected.once('error', reject);
        });
        let received = '';
        connected.on('data', (chunk: Buffer) => {
          received += chunk.toString();
        });
        connected.write(
          `GET /api/v1/projects HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\n` +
            'Connection: keep-alive\r\n\r\n' +
            'POST /api/v1/auth/login HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
            'Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n',
        );
        await delay(250);

        const startedAt = Date.now();
        spawned.child.kill('SIGTERM');
        const { code, signal } = await waitForExit(spawned.child, 20_000);
        const elapsed = Date.now() - startedAt;

        expect(code).toBe(0);
        expect(signal).toBeNull();
        await vi.waitFor(() => expect(received).toContain('HTTP/1.1 200'), {
          timeout: 2_000,
          interval: 25,
        });
        expect(elapsed).toBeLessThan(5_000);
        expect(spawned.stderr()).not.toContain('graceful shutdown timed out');
      } finally {
        socket?.destroy();
        stop(spawned.child);
        await waitForExit(spawned.child, 5_000).catch(() => undefined);
      }
    },
    60_000,
  );
});

describe('build smoke without DATABASE_URL', () => {
  // build-smoke removes and rebuilds `services/api/dist` next to itself. It runs
  // here as a byte copy inside its own build workspace, so it can neither touch
  // the checkout's dist nor the artifact the other test files spawn from.
  let workspace: ApiBuildWorkspace;

  beforeAll(async () => {
    workspace = await createApiBuildWorkspace();
  });

  afterAll(async () => {
    await removeApiBuildWorkspace(workspace);
  });

  function run(args: readonly string[]) {
    const env = apiBuildWorkspaceEnv(workspace, { ...process.env, CI: '' });
    delete env['DATABASE_URL'];
    return spawnSync(
      process.execPath,
      [join(workspace.root, 'scripts', 'ci', 'build-smoke.mjs'), ...args],
      {
        cwd: workspace.root,
        env,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
  }

  test(
    'always compiles, then skips only for the optional developer command',
    () => {
      const optional = run([]);
      expect(optional.status).toBe(0);
      expect(optional.stdout).toContain('[build-smoke] build');
      expect(optional.stdout).toContain('SKIPPED (optional developer command)');

      const required = run(['--required']);
      expect(required.status).toBe(1);
      expect(required.stdout).toContain('[build-smoke] build');
      expect(required.stderr).toContain('required from pnpm run ci');

      // It compiled inside its own workspace and left this invocation's
      // artifact (same build id, still complete) alone.
      expect(hasApiDistArtifact(apiDistArtifact(workspace.apiRoot))).toBe(true);
      expect(() => assertApiDistArtifact(distArtifact, expectedBuildId)).not.toThrow();
    },
    120_000,
  );
});
