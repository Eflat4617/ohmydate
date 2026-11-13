import type { Id } from '@ohmydate/domain';
import { GoogleSyncJob } from '../src/application/google-sync-job.js';
import {
  GoogleApiError,
  type CallOptions,
  type GoogleEventResource,
  type GooglePage,
} from '../src/application/google-calendar-ports.js';
import { FakeGoogle, ManualScheduler, testGoogleSecrets } from './support/google-fakes.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

describe('GoogleSyncJob (leader-locked interval)', () => {
  test('interval 0 never schedules', () => {
    const scheduler = vi.fn(() => ({ stop: () => undefined }));
    const job = new GoogleSyncJob({ runner: { runScheduledSync: async () => 0 }, intervalMs: 0, scheduler });
    job.start();
    expect(scheduler).not.toHaveBeenCalled();
  });

  test('only the leader runs the sync', async () => {
    const runner = { runScheduledSync: vi.fn(async () => 1) };
    const follower = new GoogleSyncJob({
      runner,
      intervalMs: 1_000,
      leaderLock: async (run) => {
        await run({ signal: new AbortController().signal, isLeader: async () => false });
        return true;
      },
    });
    await follower.runOnce();
    expect(runner.runScheduledSync).not.toHaveBeenCalled();

    const leader = new GoogleSyncJob({
      runner,
      intervalMs: 1_000,
      leaderLock: async (run) => {
        await run({ signal: new AbortController().signal, isLeader: async () => true });
        return true;
      },
    });
    await leader.runOnce();
    expect(runner.runScheduledSync).toHaveBeenCalledTimes(1);
  });

  test('a tick that is still running skips the next one, and stop waits for it', async () => {
    let release: () => void = () => undefined;
    const runner = {
      runScheduledSync: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(1);
          }),
      ),
    };
    let tick: () => void = () => undefined;
    const job = new GoogleSyncJob({
      runner,
      intervalMs: 1_000,
      scheduler: (callback) => {
        tick = callback;
        return { stop: () => undefined };
      },
    });
    job.start();
    tick();
    tick();
    expect(runner.runScheduledSync).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = job.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
  });
});

/** listEvents hangs until the run's signal aborts it. */
class HangingGoogle extends FakeGoogle {
  aborts = 0;
  hanging = 0;
  hang = false;

  override async listEvents(
    accessToken: string,
    calendarId: string,
    query: { readonly timeMin: string; readonly timeMax: string; readonly pageToken?: string | undefined },
    options?: CallOptions,
  ): Promise<GooglePage<GoogleEventResource>> {
    if (!this.hang) return super.listEvents(accessToken, calendarId, query, options);
    this.hanging += 1;
    return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => {
          this.aborts += 1;
          reject(new GoogleApiError('events.list', 'aborted', 0));
        },
        { once: true },
      );
    });
  }
}

describe.skipIf(!hasDatabase)('Google sync runs (CAL-03)', () => {
  let ctx: TestContext;
  let google: HangingGoogle;
  let closed = false;

  async function setup(options: { runBoundMs?: number; jobScheduler?: (callback: () => void) => { stop(): void } } = {}) {
    google = new HangingGoogle();
    closed = false;
    ctx = await createTestContext({
      google: {
        secrets: testGoogleSecrets(),
        oauth: google,
        calendar: google,
        nudgeScheduler: new ManualScheduler().scheduler,
        ...(options.runBoundMs === undefined ? {} : { runBoundMs: options.runBoundMs }),
      },
      ...(options.jobScheduler === undefined
        ? {}
        : {
            jobOverrides: {
              notificationIntervalMs: 0,
              exportPurgeIntervalMs: 0,
              googleSyncIntervalMs: 60_000,
              scheduler: options.jobScheduler,
            },
          }),
    });
  }

  afterEach(async () => {
    if (!closed) await ctx.close();
  });

  async function connect(email: string): Promise<{ id: Id; session: TestSession }> {
    const id = (await ctx.seedUser({ email, password: 'correct-horse' })) as Id;
    const session = await login(ctx, email, 'correct-horse');
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:connect',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    });
    const state = new URL((response.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state');
    await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?code=c&state=${state ?? ''}`,
      headers: { cookie: session.cookie },
    });
    return { id, session };
  }

  test('the composed job ticks every connected owner; one broken owner does not stop the next', async () => {
    let tick: () => void = () => undefined;
    await setup({
      jobScheduler: (callback) => {
        tick = callback;
        return { stop: () => undefined };
      },
    });
    const a = await connect('job-a@example.com');
    const b = await connect('job-b@example.com');
    // Owner A's stored token can no longer be decrypted (e.g. the key file was replaced).
    await ctx.db
      .updateTable('google_calendar_connection')
      .set({ refresh_token_ciphertext: Buffer.alloc(64, 7) })
      .where('owner_id', '=', a.id)
      .execute();
    ctx.clock.advance(2 * 60 * 60_000);

    tick();
    await vi.waitFor(async () => {
      const rows = await ctx.db
        .selectFrom('google_calendar_connection')
        .select(['owner_id', 'status', 'last_sync_at', 'last_error'])
        .orderBy('owner_id')
        .execute();
      const byOwner = new Map(rows.map((row) => [row.owner_id, row]));
      expect(byOwner.get(a.id)).toMatchObject({ status: 'needs_reauth', last_error: 'auth_revoked' });
      expect(byOwner.get(b.id)?.status).toBe('connected');
      expect(byOwner.get(b.id)?.last_sync_at).not.toBeNull();
    });
  });

  test('the per-run wall-clock bound aborts a hung Google call: 503 and lastError run_deadline', async () => {
    await setup({ runBoundMs: 150 });
    const owner = await connect('deadline@example.com');
    google.hang = true;
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:sync',
      headers: authHeaders(owner.session, { 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'provider_unavailable' });
    expect(google.aborts).toBe(1);
    const status = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/integrations/google',
      headers: authHeaders(owner.session),
    });
    expect(status.json()).toMatchObject({ status: 'connected', lastError: 'run_deadline' });
  });

  test('shutdown aborts a running sync and closes cleanly', async () => {
    await setup();
    const owner = await connect('shutdown@example.com');
    google.hang = true;
    const running = ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:sync',
      headers: authHeaders(owner.session, { 'idempotency-key': newIdempotencyKey() }),
    });
    await vi.waitFor(() => expect(google.hanging).toBe(1));
    const started = Date.now();
    closed = true;
    await ctx.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(google.aborts).toBe(1);
    const response = await running;
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});
