import { createHash } from 'node:crypto';
import type { Id, Instant } from '@ohmydate/domain';
import type { FastifyInstance } from 'fastify';
import { PgSessionStore } from '../src/adapters/pg-session-store.js';
import { buildApp, usesPersistentSessions } from '../src/app.js';
import { createConfig, DEFAULT_SESSION_TTL_MS, type AppConfig } from '../src/config.js';
import { createCsrfToken } from '../src/application/session-tokens.js';
import {
  createTestContext,
  databaseUrl,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

/**
 * FU-92: with the planner database behind the provider (PROVIDER=vikunja),
 * login sessions are stored in `auth_session` and survive an API restart.
 * Repositories are injected in-memory, so Vikunja is never contacted.
 */

const PERSISTENT: Partial<AppConfig> = {
  provider: 'vikunja',
  vikunjaUrl: 'http://127.0.0.1:9',
  reconcileIntervalMs: 0,
};

const PASSWORD = 'correct-horse-battery';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tamper(value: string): string {
  return `${value.slice(0, -1)}${value.at(-1) === 'A' ? 'B' : 'A'}`;
}

function cookieFor(sid: string, csrf: string): string {
  return `sid=${sid}; csrf=${csrf}`;
}

async function eventually(check: () => Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe.skipIf(!hasDatabase)('persistent login sessions (FU-92)', () => {
  let ctx: TestContext;
  const restarted: FastifyInstance[] = [];

  beforeEach(async () => {
    ctx = await createTestContext({ config: PERSISTENT });
    ctx.clock.set('2026-11-12T08:00:00.000Z' as Instant);
  });

  afterEach(async () => {
    for (const app of restarted.splice(0)) await app.close();
    await ctx.close();
  });

  /** Closes the running app and boots a new one on the same database. */
  async function restart(): Promise<FastifyInstance> {
    await ctx.app.close();
    for (const app of restarted) await app.close();
    const app = await buildApp({
      config: createConfig({
        databaseUrl: databaseUrl ?? null,
        cookieSecure: false,
        logLevel: 'silent',
        loginRateLimit: { limit: 1_000, windowMs: 60_000 },
        ...PERSISTENT,
      }),
      repos: ctx.repos,
      clock: ctx.clock,
      ids: ctx.ids,
      db: ctx.db,
      logger: false,
      jobOverrides: { notificationIntervalMs: 0, exportPurgeIntervalMs: 0 },
    });
    await app.ready();
    restarted.push(app);
    return app;
  }

  async function sessionRows() {
    return ctx.db.selectFrom('auth_session').selectAll().orderBy('created_at').execute();
  }

  async function me(app: FastifyInstance, cookie: string) {
    return app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
  }

  function createProject(
    app: FastifyInstance,
    headers: Record<string, string>,
    title = 'Persistent project',
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: { 'idempotency-key': newIdempotencyKey(), ...headers },
      payload: { title },
    });
  }

  async function seedAndLogin(email: string): Promise<{ id: Id; session: TestSession }> {
    const id = await ctx.seedUser({ email, password: PASSWORD });
    return { id, session: await login(ctx, email, PASSWORD) };
  }

  test('composition: vikunja provider with a database persists sessions, nothing else does', () => {
    const url = 'postgres://owner:pw@127.0.0.1:55432/planner';
    expect(usesPersistentSessions({ provider: 'vikunja', databaseUrl: url })).toBe(true);
    expect(usesPersistentSessions({ provider: 'vikunja', databaseUrl: null })).toBe(false);
    expect(usesPersistentSessions({ provider: 'vikunja', databaseUrl: '' })).toBe(false);
    expect(usesPersistentSessions({ provider: 'memory', databaseUrl: url })).toBe(false);
    expect(usesPersistentSessions({ provider: 'memory', databaseUrl: null })).toBe(false);
  });

  test('login stores only digests, and the cookies keep working after an API restart', async () => {
    const { session } = await seedAndLogin('restart@example.com');
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.id_hash).not.toBe(session.sid);
    expect(rows[0]?.id_hash).toBe(sha256(session.sid));
    expect(rows[0]?.csrf_token_hash).toBe(sha256(session.csrf));

    ctx.clock.advance(24 * 60 * 60_000);
    const app = await restart();

    const read = await me(app, session.cookie);
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ email: 'restart@example.com' });

    // CSRF double-submit still verifies against the stored digest.
    const created = await createProject(app, {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    });
    expect(created.statusCode).toBe(201);

    // Logout after the restart deletes the persisted row.
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    });
    expect(logout.statusCode).toBe(204);
    expect(await sessionRows()).toEqual([]);
    expect((await me(app, session.cookie)).statusCode).toBe(401);
  });

  test('tampered, unknown and malformed sids are 401 after a restart', async () => {
    const { session } = await seedAndLogin('tamper@example.com');
    const app = await restart();
    const unknown = Buffer.alloc(32, 9).toString('base64url');
    for (const sid of [tamper(session.sid), unknown, sha256(session.sid), 'garbage', '']) {
      const response = await me(app, cookieFor(sid, session.csrf));
      expect({ sid, status: response.statusCode }).toEqual({ sid, status: 401 });
      expect(response.json()).toMatchObject({ code: 'unauthenticated' });
      const mutation = await createProject(app, {
        cookie: cookieFor(sid, session.csrf),
        'x-csrf-token': session.csrf,
      });
      expect(mutation.statusCode).toBe(401);
    }
    // The stored digest itself is not a usable cookie value either.
    const row = (await sessionRows())[0];
    expect((await me(app, cookieFor(row?.id_hash ?? '', session.csrf))).statusCode).toBe(401);
    expect((await me(app, session.cookie)).statusCode).toBe(200);
  });

  test('a wrong CSRF token is 403 after a restart', async () => {
    const { session } = await seedAndLogin('csrf@example.com');
    const app = await restart();
    const forged = createCsrfToken();

    const missing = await createProject(app, { cookie: session.cookie });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'forbidden' });

    const mismatch = await createProject(app, {
      cookie: session.cookie,
      'x-csrf-token': forged,
    });
    expect(mismatch.statusCode).toBe(403);

    // Header and cookie agree but are not this session's token.
    const doubleForged = await createProject(app, {
      cookie: cookieFor(session.sid, forged),
      'x-csrf-token': forged,
    });
    expect(doubleForged.statusCode).toBe(403);

    // The stored digest is not accepted in place of the token.
    const digest = sha256(session.csrf);
    const asDigest = await createProject(app, {
      cookie: cookieFor(session.sid, digest),
      'x-csrf-token': digest,
    });
    expect(asDigest.statusCode).toBe(403);

    const ok = await createProject(app, {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
    });
    expect(ok.statusCode).toBe(201);
  });

  test("one owner's session can never act for another owner", async () => {
    const alice = await seedAndLogin('alice-persist@example.com');
    const bob = await seedAndLogin('bob-persist@example.com');
    const app = await restart();

    expect((await me(app, alice.session.cookie)).json()).toMatchObject({ id: alice.id });
    expect((await me(app, bob.session.cookie)).json()).toMatchObject({ id: bob.id });

    // Alice's sid with Bob's CSRF token (cookie + header): rejected.
    const mixed = await createProject(app, {
      cookie: cookieFor(alice.session.sid, bob.session.csrf),
      'x-csrf-token': bob.session.csrf,
    });
    expect(mixed.statusCode).toBe(403);

    // Bob's project is invisible through Alice's session.
    const bobsProject = await createProject(
      app,
      { cookie: bob.session.cookie, 'x-csrf-token': bob.session.csrf },
      'Bob only',
    );
    expect(bobsProject.statusCode).toBe(201);
    const aliceList = await app.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: { cookie: alice.session.cookie },
    });
    expect(aliceList.statusCode).toBe(200);
    const titles = (aliceList.json() as { items: Array<{ title: string }> }).items.map(
      (item) => item.title,
    );
    expect(titles).not.toContain('Bob only');

    // Bob logging out ends only Bob's session.
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: bob.session.cookie, 'x-csrf-token': bob.session.csrf },
    });
    expect(logout.statusCode).toBe(204);
    expect((await me(app, bob.session.cookie)).statusCode).toBe(401);
    expect((await me(app, alice.session.cookie)).json()).toMatchObject({ id: alice.id });
    expect((await sessionRows()).map((row) => row.user_id)).toEqual([alice.id]);
  });

  test('requests slide the persisted expiry; an idle session expires across a restart', async () => {
    const { session } = await seedAndLogin('expiry@example.com');
    const loginRow = (await sessionRows())[0];

    ctx.clock.advance(10 * 60_000);
    expect((await me(ctx.app, session.cookie)).statusCode).toBe(200);
    const slid = (await sessionRows())[0];
    expect(slid?.expires_at.getTime()).toBe(
      (loginRow?.expires_at.getTime() ?? 0) + 10 * 60_000,
    );

    ctx.clock.advance(DEFAULT_SESSION_TTL_MS);
    const app = await restart();
    const expired = await me(app, session.cookie);
    expect(expired.statusCode).toBe(401);
    expect(await sessionRows()).toEqual([]);
  });

  test('boot sweeps expired session rows and keeps live ones', async () => {
    const { session } = await seedAndLogin('sweep-live@example.com');
    const staleOwner = await ctx.seedUser({ email: 'sweep-stale@example.com', password: PASSWORD });
    // A session that expired long ago, written as an older process would have.
    const past = new PgSessionStore({
      db: ctx.db,
      clock: { now: () => '2026-10-01T00:00:00.000Z' as Instant },
      ttlMs: DEFAULT_SESSION_TTL_MS,
    });
    const stale = await past.create(staleOwner, createCsrfToken());
    expect(await sessionRows()).toHaveLength(2);

    const app = await restart();
    await eventually(async () => {
      const rows = await sessionRows();
      expect(rows.map((row) => row.id_hash)).toEqual([sha256(session.sid)]);
    });
    expect((await sessionRows()).map((row) => row.id_hash)).not.toContain(sha256(stale.id));
    expect((await me(app, session.cookie)).statusCode).toBe(200);
  });

  test('deleting a user ends their persisted sessions', async () => {
    const alice = await seedAndLogin('cascade-alice@example.com');
    const bob = await seedAndLogin('cascade-bob@example.com');
    await ctx.db.deleteFrom('user').where('id', '=', alice.id).execute();
    const app = await restart();
    expect((await me(app, alice.session.cookie)).statusCode).toBe(401);
    expect((await me(app, bob.session.cookie)).statusCode).toBe(200);
    expect((await sessionRows()).map((row) => row.user_id)).toEqual([bob.id]);
  });
});

describe.skipIf(!hasDatabase)('memory provider keeps process-local sessions (FU-92)', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestContext();
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('login works but writes no auth_session row', async () => {
    await ctx.seedUser({ email: 'memory@example.com', password: PASSWORD });
    const session = await login(ctx, 'memory@example.com', PASSWORD);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: session.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(await ctx.db.selectFrom('auth_session').selectAll().execute()).toEqual([]);
  });
});
