import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { hash } from '@node-rs/argon2';
import type { Id, Version } from '@ohmydate/domain';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { PgMappingStore } from '../src/adapters/vikunja/pg-mapping-store.js';
import { buildApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { createApplicationClose, createShutdownController } from '../src/main.js';
import { shutdownControllerFor } from '../src/http/shutdown-context.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './vikunja/pg-support.js';
import { authHeaders, sessionFromResponse } from './support/test-context.js';

function captureStream(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, output: () => chunks.join('') };
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
        response.writeHead(200, {
          'content-type': 'application/json',
          etag: 'W/"1"',
        });
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
        response.writeHead(200, {
          'content-type': 'application/json',
          etag: 'W/"2"',
        });
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

interface Fixture {
  readonly app: FastifyInstance;
  readonly store: PgTestStore;
  readonly provider: SyntheticProvider;
  readonly tokenDir: string;
  readonly mappings: PgMappingStore;
  readonly ownerId: Id;
  readonly taskId: Id;
  readonly email: string;
  readonly password: string;
  readonly idempotencyKey: string;
  readonly output: () => string;
}

async function createFixture(): Promise<Fixture> {
  const store = await createPgTestStore();
  const provider = await startSyntheticProvider();
  const tokenDir = await mkdtemp(join(tmpdir(), 'ohmydate-fu42r-'));
  try {
    const { stream, output } = captureStream();
    const logger = pino({ level: 'warn' }, stream);
    const clock = new FakeClock();
    const ids = createSeededIdGenerator(424242, clock);
    const ownerId: Id = ids.next();
    const taskId: Id = ids.next();
    const email = `mutation-${ownerId}@example.com`;
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

    const app = await buildApp({
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: provider.url,
        vikunjaSecretsDir: tokenDir,
        reconcileIntervalMs: 0,
        cookieSecure: false,
        logLevel: 'warn',
        loginRateLimit: { limit: 1_000, windowMs: 60_000 },
      }),
      clock,
      ids,
      db: store.db,
      loggerInstance: logger,
    });

    return {
      app,
      store,
      provider,
      tokenDir,
      mappings,
      ownerId,
      taskId,
      email,
      password,
      idempotencyKey,
      output,
    };
  } catch (error) {
    await store.close();
    await provider.close();
    await rm(tokenDir, { recursive: true, force: true });
    throw error;
  }
}

async function cleanup(fixture: Fixture, closeApp: boolean): Promise<void> {
  if (closeApp) await fixture.app.close().catch(() => undefined);
  await fixture.store.close();
  await fixture.provider.close();
  await rm(fixture.tokenDir, { recursive: true, force: true });
}

describe.skipIf(!hasDatabase)('drain-aborted mutation recovery', () => {
  test(
    'remote PATCH survives an aborted follow-up GET with recovery and idempotency cleanup',
    async () => {
      const fixture = await createFixture();
      // Production installs the shutdown controller before it ever listens.
      const close = createApplicationClose(fixture.app, 300, 2_000);
      const address = new URL(
        await fixture.app.listen({ host: '127.0.0.1', port: 0 }),
      );
      let closeApp = true;
      try {
        const login = await fetch(`${address.toString()}api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: fixture.email, password: fixture.password }),
        });
        expect(login.status).toBe(204);
        const setCookies = login.headers.getSetCookie();
        const cookiePairs = setCookies.map((entry) => entry.split(';', 1)[0] ?? '');
        const cookie = cookiePairs.join('; ');
        const csrf =
          cookiePairs
            .find((pair) => pair.startsWith('csrf='))
            ?.slice('csrf='.length) ?? '';
        expect(csrf.length).toBeGreaterThan(0);

        const pending = fetch(`${address.toString()}api/v1/tasks/${fixture.taskId}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            cookie,
            'x-csrf-token': csrf,
            'idempotency-key': fixture.idempotencyKey,
            'if-match': 'W/"1"',
          },
          body: JSON.stringify({ title: 'Remote title applied by PATCH' }),
        }).catch((error: unknown) => error);

        await fixture.provider.secondGetStarted;

        let exitCode: number | undefined;
        let snapshot:
          | {
              readonly needsReconcile: boolean;
              readonly idempotencyStatus: string | undefined;
              readonly idempotencyRows: number;
            }
          | undefined;
        let resolveExit!: () => void;
        const exited = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });

        const shutdown = createShutdownController({
          logger: { info: () => undefined, error: () => undefined },
          close,
          destroy: async () => {
            const mapping = await fixture.mappings.get('task', fixture.taskId);
            const rows = await fixture.store.db
              .selectFrom('idempotency_record')
              .select('status')
              .where('owner_id', '=', fixture.ownerId)
              .where('key', '=', fixture.idempotencyKey)
              .execute();
            snapshot = {
              needsReconcile: mapping?.needsReconcile === true,
              idempotencyStatus: rows[0]?.status,
              idempotencyRows: rows.length,
            };
            await fixture.store.db.destroy();
          },
          exit: (code) => {
            exitCode = code;
            resolveExit();
          },
          deadlineMs: 5_000,
        });

        shutdown('SIGTERM');
        await exited;
        closeApp = false;

        expect(exitCode).toBe(0);
        expect(fixture.provider.state().patchApplied).toBe(true);
        expect(fixture.provider.state().stalledAborted).toBe(true);
        expect(snapshot?.needsReconcile).toBe(true);
        expect(snapshot?.idempotencyRows).toBe(0);
        expect(fixture.output()).not.toContain('driver has already been destroyed');
        expect(fixture.output()).not.toContain('idempotency release failed');
        await pending;
      } finally {
        await cleanup(fixture, closeApp);
      }
    },
    30_000,
  );

  test(
    'an application abort during the mutation maps to 503 provider_unavailable',
    async () => {
      const fixture = await createFixture();
      try {
        const login = await fixture.app.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: { email: fixture.email, password: fixture.password },
        });
        expect(login.statusCode).toBe(204);
        const session = sessionFromResponse(login.headers['set-cookie']);

        const pending = fixture.app.inject({
          method: 'PATCH',
          url: `/api/v1/tasks/${fixture.taskId}`,
          headers: authHeaders(session, {
            'idempotency-key': fixture.idempotencyKey,
            'if-match': 'W/"1"',
          }),
          payload: { title: 'Remote title applied by PATCH' },
        });

        await fixture.provider.secondGetStarted;
        shutdownControllerFor(fixture.app)?.abort();

        const response = await pending;
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({ code: 'provider_unavailable' });

        const mapping = await fixture.mappings.get('task', fixture.taskId);
        expect(mapping?.needsReconcile).toBe(true);
        const rows = await fixture.store.db
          .selectFrom('idempotency_record')
          .select('status')
          .where('owner_id', '=', fixture.ownerId)
          .where('key', '=', fixture.idempotencyKey)
          .execute();
        expect(rows).toHaveLength(0);
        expect(fixture.output()).not.toContain('driver has already been destroyed');
      } finally {
        await cleanup(fixture, true);
      }
    },
    30_000,
  );

  test(
    'a connected client receives the 503 provider_unavailable instead of a transport error',
    async () => {
      const fixture = await createFixture();
      // Production installs the shutdown controller before it ever listens.
      const close = createApplicationClose(fixture.app, 200, 2_000);
      const address = new URL(
        await fixture.app.listen({ host: '127.0.0.1', port: 0 }),
      );
      let closeApp = true;
      try {
        const login = await fetch(`${address.toString()}api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: fixture.email, password: fixture.password }),
        });
        expect(login.status).toBe(204);
        const cookiePairs = login.headers
          .getSetCookie()
          .map((entry) => entry.split(';', 1)[0] ?? '');
        const cookie = cookiePairs.join('; ');
        const csrf =
          cookiePairs.find((pair) => pair.startsWith('csrf='))?.slice('csrf='.length) ?? '';

        const pending = fetch(`${address.toString()}api/v1/tasks/${fixture.taskId}`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            cookie,
            'x-csrf-token': csrf,
            'idempotency-key': fixture.idempotencyKey,
            'if-match': 'W/"1"',
          },
          body: JSON.stringify({ title: 'Remote title applied by PATCH' }),
        });

        await fixture.provider.secondGetStarted;
        let exitCode: number | undefined;
        const exited = new Promise<void>((resolve) => {
          const shutdown = createShutdownController({
            logger: { info: () => undefined, error: () => undefined },
            close,
            destroy: async () => {
              await fixture.store.db.destroy();
            },
            exit: (code) => {
              exitCode = code;
              resolve();
            },
            deadlineMs: 5_000,
          });
          shutdown('SIGTERM');
        });

        const response = await pending;
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'provider_unavailable' });

        await exited;
        closeApp = false;
        expect(exitCode).toBe(0);
        expect(fixture.output()).not.toContain('unsettled operations');
      } finally {
        await cleanup(fixture, closeApp);
      }
    },
    30_000,
  );
});
