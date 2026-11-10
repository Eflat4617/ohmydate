import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash } from '@node-rs/argon2';
import type { Id } from '@ohmydate/domain';
import { VikunjaClient } from '@ohmydate/provider-vikunja';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { createConfig } from '../../src/config.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './pg-support.js';
import {
  authHeaders,
  sessionFromResponse,
  type TestSession,
} from '../support/test-context.js';

const baseUrl = process.env['VIKUNJA_URL'];
const live = hasDatabase && baseUrl !== undefined && baseUrl.length > 0;

const TOKEN_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  projects: ['create', 'read_all', 'read_one', 'update', 'delete', 'permanent'],
  tasks: ['create', 'read_all', 'read_one', 'update', 'delete', 'deleted', 'permanent'],
  tasks_relations: ['create', 'delete'],
  other: ['user'],
};

interface SyntheticAccount {
  readonly client: VikunjaClient;
  readonly token: string;
}

async function createAccount(url: string): Promise<SyntheticAccount> {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const username = `m110-${suffix}`;
  const password = `pw-${suffix}-${suffix}`;
  const client = new VikunjaClient({ baseUrl: url });
  await client.register({
    username,
    email: `${username}@example.invalid`,
    password,
  });
  const jwt = await client.login(username, password);
  client.setToken(jwt);
  const created = await client.createApiToken({
    title: `m1-10 smoke ${username}`,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    permissions: TOKEN_PERMISSIONS,
  });
  client.setToken(created.token);
  return { client, token: created.token };
}

describe.skipIf(!live)('API smoke against live Vikunja with PG stores', () => {
  let store: PgTestStore;
  let app: FastifyInstance | undefined;
  let account: SyntheticAccount | undefined;
  let tokenDir: string | undefined;

  afterEach(async () => {
    if (account !== undefined) {
      for (const task of await account.client.listAllTasks().catch(() => [])) {
        await account.client.deleteTask(String(task.id)).catch(() => undefined);
        await account.client.permanentDeleteTask(String(task.id)).catch(() => undefined);
      }
    }
    await app?.close();
    app = undefined;
    await store.close();
    if (tokenDir !== undefined) await rm(tokenDir, { recursive: true, force: true });
  });

  test('login -> POST /tasks -> Vikunja has the task -> PATCH -> GET', async () => {
    const url = baseUrl as string;
    store = await createPgTestStore();
    account = await createAccount(url);

    const clock = new FakeClock();
    const ids = createSeededIdGenerator(991199, clock);
    const ownerId = ids.next();
    const email = `planner-${ownerId}@example.com`;
    const password = 'correct-horse';
    await store.db
      .insertInto('user')
      .values({ id: ownerId, email, password_hash: await hash(password) })
      .execute();

    tokenDir = await mkdtemp(join(tmpdir(), 'ohmydate-m1-10-'));
    const tokenPath = join(tokenDir, 'tokens.json');
    await writeFile(tokenPath, JSON.stringify({ [ownerId]: account.token }), 'utf8');
    await store.db
      .insertInto('vikunja_owner_account')
      .values({
        owner_id: ownerId,
        vikunja_user_id: 1,
        token_secret_ref: `file:${tokenPath}`,
      })
      .execute();

    app = await buildApp({
      config: createConfig({
        provider: 'vikunja',
        vikunjaUrl: url,
        vikunjaSecretsDir: tokenDir,
        reconcileIntervalMs: 0,
        cookieSecure: false,
        logLevel: 'silent',
        loginRateLimit: { limit: 1_000, windowMs: 60_000 },
      }),
      clock,
      ids,
      db: store.db,
      logger: false,
    });
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password },
    });
    expect(login.statusCode).toBe(204);
    const session: TestSession = sessionFromResponse(login.headers['set-cookie']);

    const created = await app.inject({
      method: 'POST',
      url: '/tasks',
      headers: authHeaders(session, { 'idempotency-key': randomUUID() }),
      payload: { title: 'M1-10 smoke task' },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json() as { id: Id; version: number };
    expect(task.version).toBe(1);

    const remoteTasks = await account.client.listAllTasks();
    const remote = remoteTasks.find((candidate) => candidate.title === 'M1-10 smoke task');
    expect(remote).toBeDefined();
    if (remote === undefined) throw new Error('task missing from Vikunja');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/tasks/${task.id}`,
      headers: authHeaders(session, {
        'idempotency-key': randomUUID(),
        'if-match': 'W/"1"',
      }),
      payload: { title: 'M1-10 smoke task updated' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { version: number }).version).toBe(2);

    const fetched = await app.inject({
      method: 'GET',
      url: `/tasks/${task.id}`,
      headers: authHeaders(session),
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { title: string }).title).toBe('M1-10 smoke task updated');

    const remoteAfter = await account.client.getTask(String(remote.id));
    expect(remoteAfter.data.title).toBe('M1-10 smoke task updated');
  });
});
