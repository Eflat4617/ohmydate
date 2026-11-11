import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { hash } from '@node-rs/argon2';
import type { Id, Version } from '@ohmydate/domain';
import { createInMemoryRepositories } from '@ohmydate/provider-native/in-memory';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import type { FastifyInstance } from 'fastify';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createApplicationClose } from '../src/main.js';
import { PgMappingStore } from '../src/adapters/vikunja/pg-mapping-store.js';
import { pendingOperationCount } from '../src/http/shutdown-context.js';
import type { Database } from '../src/db/types.js';
import {
  createPgTestStore,
  databaseUrl,
  hasDatabase,
} from './vikunja/pg-support.js';

const { Pool } = pg;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const distMain = join(apiRoot, 'dist', 'main.js');
const neverFixture = join(apiRoot, 'test', 'support', 'never-settling-app.mjs');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

interface Spawned {
  readonly child: ChildProcess;
  readonly output: () => string;
}

function spawnApp(script: string, env: NodeJS.ProcessEnv): Spawned {
  let output = '';
  const child = spawn(process.execPath, [script], {
    cwd: apiRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { child, output: () => output };
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

async function waitForOutput(
  spawned: Spawned,
  marker: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawned.output().includes(marker)) return;
    if (spawned.child.exitCode !== null) {
      throw new Error(
        `app exited before "${marker}" (${String(spawned.child.exitCode)})\n${spawned.output()}`,
      );
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for "${marker}"\n${spawned.output()}`);
}

async function waitForHealth(
  baseUrl: string,
  spawned: Spawned,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawned.child.exitCode !== null) {
      throw new Error(
        `app exited before /healthz (${String(spawned.child.exitCode)})\n${spawned.output()}`,
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
  throw new Error(`timed out waiting for /healthz\n${spawned.output()}`);
}

function stop(child: ChildProcess | undefined): void {
  if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
}

interface SyntheticProvider {
  readonly url: string;
  readonly secondGetStarted: Promise<void>;
  readonly state: () => {
    readonly getCount: number;
    readonly patchApplied: boolean;
    readonly stalledAborted: boolean;
  };
  close(): Promise<void>;
}

async function startSyntheticProvider(): Promise<SyntheticProvider> {
  let getCount = 0;
  let patchApplied = false;
  let stalledAborted = false;
  let resolveSecondGet!: () => void;
  const secondGetStarted = new Promise<void>((resolve) => {
    resolveSecondGet = resolve;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://synthetic.invalid');
    if (request.method === 'GET' && url.pathname === '/api/v2/tasks/77') {
      getCount += 1;
      if (getCount === 1) {
        response.writeHead(200, { 'content-type': 'application/json', etag: 'W/"1"' });
        response.end(
          JSON.stringify({
            id: 77,
            project_id: 55,
            title: 'Original remote title',
            done: false,
            updated: '2026-11-11T00:00:00Z',
          }),
        );
        return;
      }
      response.on('close', () => {
        if (!response.writableEnded) stalledAborted = true;
      });
      request.on('close', () => {
        if (!response.writableEnded) stalledAborted = true;
      });
      // Hold the follow-up GET open until the shutdown signal aborts it.
      resolveSecondGet();
      return;
    }
    if (request.method === 'PATCH' && url.pathname === '/api/v2/tasks/77') {
      request.on('data', () => undefined);
      request.on('end', () => {
        patchApplied = true;
        response.writeHead(200, { 'content-type': 'application/json', etag: 'W/"2"' });
        response.end(
          JSON.stringify({
            id: 77,
            project_id: 55,
            title: 'Remote title applied by PATCH',
            done: false,
            updated: '2026-11-11T00:00:01Z',
          }),
        );
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ message: 'not found' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('synthetic provider did not bind a port');
  }
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    secondGetStarted,
    state: () => ({ getCount, patchApplied, stalledAborted }),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

beforeAll(() => {
  const execPath = process.env['npm_execpath'];
  const isJsEntry = execPath !== undefined && /\.(c|m)?js$/.test(execPath);
  const command = isJsEntry ? process.execPath : (execPath ?? 'pnpm');
  const prefix = isJsEntry ? [execPath as string] : [];
  const build = spawnSync(command, [...prefix, 'run', 'build'], {
    cwd: apiRoot,
    encoding: 'utf8',
  });
  if (build.status !== 0) {
    throw new Error(`build failed: ${build.stdout}\n${build.stderr}`);
  }
}, 120_000);

describe('boot validation', () => {
  test('rejects SHUTDOWN_CLEANUP_BUDGET_MS that reaches the hard deadline', async () => {
    const port = await freePort();
    const spawned = spawnApp(distMain, {
      DATABASE_URL: 'postgres://unused@127.0.0.1:1/unused',
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'silent',
      SHUTDOWN_CLEANUP_BUDGET_MS: '3000',
    });
    try {
      const { code } = await waitForExit(spawned.child, 10_000);
      expect(code).toBe(1);
      expect(spawned.output()).toContain('SHUTDOWN_CLEANUP_BUDGET_MS');
    } finally {
      stop(spawned.child);
      await waitForExit(spawned.child, 5_000).catch(() => undefined);
    }
  }, 20_000);
});

describe.skipIf(!hasDatabase)('disconnected-client mutation survives real SIGTERM', () => {
  test(
    'remote PATCH is reconciled and the idempotency row released after process exit',
    async () => {
      const store = await createPgTestStore();
      const provider = await startSyntheticProvider();
      const tokenDir = await mkdtemp(join(tmpdir(), 'ohmydate-fu42c-'));
      const port = await freePort();
      let spawned: Spawned | undefined;
      try {
        const clock = new FakeClock();
        const ids = createSeededIdGenerator(424243, clock);
        const ownerId: Id = ids.next();
        const taskId: Id = ids.next();
        const email = `disconnect-${ownerId}@example.com`;
        const password = 'correct-horse-battery';
        const idempotencyKey = randomUUID();
        const tokenPath = join(tokenDir, 'tokens.json');
        await writeFile(tokenPath, JSON.stringify({ [ownerId]: 'tk_synthetic' }), 'utf8');

        await store.db
          .insertInto('user')
          .values({ id: ownerId, email, password_hash: await hash(password) })
          .execute();
        await store.db
          .insertInto('vikunja_owner_account')
          .values({
            owner_id: ownerId,
            vikunja_user_id: 1,
            token_secret_ref: `file:${tokenPath}`,
          })
          .execute();
        const mappings = new PgMappingStore(store.db);
        await mappings.put({
          provider: 'vikunja',
          entityType: 'task',
          entityId: taskId,
          externalId: '77',
          ownerId,
          localVersion: 1 as Version,
          createdAt: clock.now(),
          updatedAt: clock.now(),
        });

        spawned = spawnApp(distMain, {
          DATABASE_URL: databaseUrl as string,
          PGOPTIONS: `-c search_path=${store.schema}`,
          PROVIDER: 'vikunja',
          PUSH_KEY: '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
          VIKUNJA_URL: provider.url,
          VIKUNJA_SECRETS_DIR: tokenDir,
          VIKUNJA_RECONCILE_INTERVAL_MS: '0',
          HOST: '127.0.0.1',
          PORT: String(port),
          LOG_LEVEL: 'warn',
        });

        const baseUrl = `http://127.0.0.1:${String(port)}`;
        await waitForHealth(baseUrl, spawned);

        const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        });
        expect(login.status).toBe(204);
        const cookiePairs = login.headers
          .getSetCookie()
          .map((entry) => entry.split(';', 1)[0] ?? '');
        const cookie = cookiePairs.join('; ');
        const csrf =
          cookiePairs.find((pair) => pair.startsWith('csrf='))?.slice('csrf='.length) ?? '';
        expect(csrf.length).toBeGreaterThan(0);

        const clientAbort = new AbortController();
        const pending = fetch(`${baseUrl}/api/v1/tasks/${taskId}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            cookie,
            'x-csrf-token': csrf,
            'idempotency-key': idempotencyKey,
            'if-match': 'W/"1"',
          },
          body: JSON.stringify({ title: 'Remote title applied by PATCH' }),
          signal: clientAbort.signal,
        });
        pending.catch(() => undefined);

        await provider.secondGetStarted;
        // The remote PATCH was applied and the follow-up GET is stalled. Drop
        // the client connection, then shut the process down.
        clientAbort.abort();
        await delay(150);
        expect(spawned.child.exitCode).toBeNull();
        spawned.child.kill('SIGTERM');

        const { code, signal } = await waitForExit(spawned.child, 25_000);
        expect(signal).toBeNull();
        expect(code).toBe(0);

        expect(provider.state().patchApplied).toBe(true);
        expect(provider.state().stalledAborted).toBe(true);

        const mapping = await mappings.get('task', taskId);
        expect(mapping?.needsReconcile).toBe(true);
        const rows = await store.db
          .selectFrom('idempotency_record')
          .select('status')
          .where('owner_id', '=', ownerId)
          .where('key', '=', idempotencyKey)
          .execute();
        expect(rows).toHaveLength(0);

        expect(spawned.output()).not.toContain('driver has already been destroyed');
        expect(spawned.output()).not.toContain('idempotency release failed');
        expect(spawned.output()).not.toContain('unsettled operations');
      } finally {
        stop(spawned?.child);
        await provider.close();
        await store.close();
        await rm(tokenDir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe.skipIf(!hasDatabase)('never-settling handler fails shutdown explicitly', () => {
  test(
    'exit 1 with the unsettled log, database destroyed only after the cleanup budget',
    async () => {
      const port = await freePort();
      const drainMs = 300;
      const cleanupMs = 600;
      const deadlineMs = 5_000;
      const spawned = spawnApp(neverFixture, {
        DATABASE_URL: databaseUrl as string,
        HOST: '127.0.0.1',
        PORT: String(port),
        TEST_DRAIN_MS: String(drainMs),
        TEST_CLEANUP_MS: String(cleanupMs),
        TEST_DEADLINE_MS: String(deadlineMs),
      });
      let socket: net.Socket | undefined;
      try {
        const baseUrl = `http://127.0.0.1:${String(port)}`;
        await waitForHealth(baseUrl, spawned);

        socket = net.connect(port, '127.0.0.1');
        const connected = socket;
        await new Promise<void>((resolve, reject) => {
          connected.once('connect', resolve);
          connected.once('error', reject);
        });
        connected.write('GET /never HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
        await waitForOutput(spawned, 'HANDLER_STARTED');

        const startedAt = Date.now();
        spawned.child.kill('SIGTERM');
        const { code, signal } = await waitForExit(spawned.child, 10_000);
        const elapsed = Date.now() - startedAt;

        expect(signal).toBeNull();
        expect(code).toBe(1);
        expect(elapsed).toBeGreaterThanOrEqual(drainMs + cleanupMs - 100);
        expect(elapsed).toBeLessThan(deadlineMs);

        const output = spawned.output();
        expect(output).toContain('unsettled operations after shutdown cleanup budget');
        expect(output).toContain('DB_DESTROYED');
        expect(output.indexOf('unsettled operations')).toBeLessThan(
          output.indexOf('DB_DESTROYED'),
        );

        const unsettled = output
          .trim()
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((line) => line.msg === 'unsettled operations after shutdown cleanup budget');
        expect(unsettled).toBeDefined();
        expect(unsettled?.count).toBe(1);
        expect(unsettled?.routes).toEqual([
          expect.objectContaining({ route: '/never', method: 'GET' }),
        ]);
      } finally {
        socket?.destroy();
        stop(spawned.child);
        await waitForExit(spawned.child, 5_000).catch(() => undefined);
      }
    },
    30_000,
  );
});

interface InProcessApp {
  readonly app: FastifyInstance;
  readonly db: Kysely<Database>;
  readonly output: () => string;
}

async function buildInProcessApp(): Promise<InProcessApp> {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'warn' }, stream);
  const pool = new Pool({ connectionString: 'postgres://ohmydate@127.0.0.1:1/unused' });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  const clock = new FakeClock();
  const ids = createSeededIdGenerator(99, clock);
  const repos = createInMemoryRepositories({ clock, ids });
  const app = await buildApp({
    config: createConfig({ provider: 'memory', cookieSecure: false, logLevel: 'warn' }),
    repos,
    clock,
    ids,
    db,
    loggerInstance: logger,
  });
  return { app, db, output: () => chunks.join('') };
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('handler-promise operation tracking', () => {
  test('shutdown listeners installed at boot settle a normally completed request', async () => {
    const { app, db, output } = await buildInProcessApp();
    // Production creates the shutdown controller before listening.
    const close = createApplicationClose(app, 2_000);
    try {
      app.get('/ok', async () => ({ ok: true }));
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const response = await fetch(`${address.toString()}ok`);
      expect(response.status).toBe(200);

      expect(pendingOperationCount(app)).toBe(0);
      const startedAt = Date.now();
      await close();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(output()).not.toContain('forced shutdown closure');
      expect(output()).not.toContain('unsettled operations');
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 15_000);

  test('a completed handler is released despite its socket being aborted', async () => {
    const { app, db } = await buildInProcessApp();
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      app.get('/abort-after-complete', async () => {
        started();
        await delay(150);
        return { ok: true };
      });
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const socket = await connect(Number(address.port));
      socket.write('GET /abort-after-complete HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await handlerStarted;
      socket.destroy();

      // A client disconnect does not settle the operation while the handler
      // promise still runs.
      await delay(50);
      expect(pendingOperationCount(app)).toBe(1);

      await vi.waitFor(() => expect(pendingOperationCount(app)).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 15_000);

  test('an aborted stream releases its operation once the handler returns', async () => {
    const { app, db } = await buildInProcessApp();
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      app.get('/stream-abort', async (_request, reply) => {
        started();
        const stream = new Readable({
          read() {
            this.push('partial');
            setTimeout(() => this.destroy(new Error('stream aborted')), 50);
          },
        });
        return reply.send(stream);
      });
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const socket = await connect(Number(address.port));
      socket.write('GET /stream-abort HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await handlerStarted;
      socket.destroy();

      await vi.waitFor(() => expect(pendingOperationCount(app)).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 15_000);

  test('a hijacked response releases its operation even when never ended', async () => {
    const { app, db } = await buildInProcessApp();
    let started!: () => void;
    const handlerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      app.get('/hijack', async (_request, reply) => {
        started();
        reply.hijack();
        return undefined;
      });
      const address = new URL(await app.listen({ host: '127.0.0.1', port: 0 }));
      const socket = await connect(Number(address.port));
      socket.write('GET /hijack HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
      await handlerStarted;

      await vi.waitFor(() => expect(pendingOperationCount(app)).toBe(0), {
        timeout: 2_000,
        interval: 10,
      });
      socket.destroy();
    } finally {
      await app.close().catch(() => undefined);
      await db.destroy();
    }
  }, 15_000);
});
