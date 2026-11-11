import { Writable } from 'node:stream';
import pino from 'pino';
import type { Export, Notification, PushSubscription, WorkSession } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import { defaultLoggerOptions } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { PgNotificationStore } from '../src/adapters/pg-notification-store.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';
import { seedActivePlan, seedAvailability, seedM4Task } from './support/m4-fixtures.js';

describe.skipIf(!hasDatabase)('notifications, push subscriptions and exports (M4-02)', () => {
  let ctx: TestContext;
  let alice: TestSession;
  let ownerId: Id;
  let taskId: Id;

  beforeEach(async () => {
    ctx = await createTestContext();
    ownerId = await ctx.seedUser({ email: 'daily@example.com', password: 'correct-horse' });
    ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
    alice = await login(ctx, 'daily@example.com', 'correct-horse');
    await seedAvailability(ctx, ownerId);
    const seeded = await seedM4Task(ctx, ownerId, { title: 'Notify me' });
    taskId = seeded.task.id;
    await seedActivePlan(ctx, ownerId, taskId, {
      horizonStart: '2026-11-12T00:00:00Z',
      horizonEnd: '2026-11-15T00:00:00Z',
      blockStart: '2026-11-12T08:05:00Z',
      blockEnd: '2026-11-12T09:05:00Z',
    });
  });

  afterEach(async () => {
    await ctx.close();
  });

  test('two notification leaders dedupe by dedupe_key and dismiss works', async () => {
    const left = new PgNotificationStore({ db: ctx.db, ids: ctx.ids });
    const right = new PgNotificationStore({ db: ctx.db, ids: ctx.ids });
    const counts = await Promise.all([
      left.runUpcoming(ctx.clock.now()),
      right.runUpcoming(ctx.clock.now()),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);

    await left.runUpcoming(ctx.clock.now());
    const rows = await ctx.db
      .selectFrom('notification')
      .selectAll()
      .where('owner_id', '=', ownerId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dedupe_key).toBe(
      `session_reminder:${String((await ctx.db.selectFrom('schedule_block').select('id').where('owner_id', '=', ownerId).executeTakeFirstOrThrow()).id)}:2026-11-12T08:05:00.000Z`,
    );

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: authHeaders(alice),
    });
    expect(list.statusCode).toBe(200);
    const page = list.json() as { items: Notification[] };
    expect(page.items).toHaveLength(1);
    const notification = page.items[0] as Notification;
    expect(notification).toMatchObject({ kind: 'session_reminder', state: 'sent', channel: 'in_app' });

    const dismiss = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${notification.id}:dismiss`,
      headers: authHeaders(alice, {
        'if-match': `W/"${String(notification.version)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json()).toMatchObject({ state: 'dismissed' });
  });

  test('push subscriptions store only ciphertext and never echo keys', async () => {
    const keys = {
      p256dh: 'BOrT6n0m6e2L5g2d5r2C1v0r2e9Y8u7I6o5P4a3S2d1F0g9H8j7K6l5M4n3B2v1C0x9Z8y7W6v5U4t3S2r1Q0',
      auth: 'aVerySecretAuthValue123',
    };
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/push-subscriptions',
      headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
      payload: { endpoint: 'https://push.example.test/sub/1', keys, deviceLabel: 'laptop' },
    });
    expect(create.statusCode).toBe(201);
    const subscription = create.json() as PushSubscription;
    expect(subscription).not.toHaveProperty('keys');
    expect(JSON.stringify(subscription)).not.toContain(keys.p256dh);

    const row = await ctx.db
      .selectFrom('push_subscription')
      .select(['p256dh_ciphertext', 'auth_ciphertext', 'key_id'])
      .where('owner_id', '=', ownerId)
      .executeTakeFirstOrThrow();
    expect(row.p256dh_ciphertext.toString('utf8')).not.toContain(keys.p256dh);
    expect(row.auth_ciphertext.toString('utf8')).not.toContain(keys.auth);
    expect(row.key_id.length).toBeGreaterThan(0);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/push-subscriptions/${subscription.id}`,
      headers: authHeaders(alice, {
        'if-match': `W/"${String(subscription.version)}"`,
        'idempotency-key': newIdempotencyKey(),
      }),
    });
    expect(removed.statusCode).toBe(204);
  });

  test('exports build owner JSON, download as attachment and isolate owners', async () => {
    const key = newIdempotencyKey();
    const start = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: authHeaders(alice, { 'idempotency-key': key }),
      payload: {},
    });
    expect(start.statusCode).toBe(202);
    const { exportId } = start.json() as { exportId: string };

    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/exports',
      headers: authHeaders(alice, { 'idempotency-key': key }),
      payload: {},
    });
    expect(replay.statusCode).toBe(202);
    expect((replay.json() as { exportId: string }).exportId).toBe(exportId);

    const state = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: authHeaders(alice),
    });
    expect(state.statusCode).toBe(200);
    const record = state.json() as Export;
    expect(record.state).toBe('ready');
    expect(record.downloadUrl).toContain('download=1');

    const download = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}?download=1`,
      headers: authHeaders(alice),
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/json');
    expect(download.headers['content-disposition']).toContain('attachment');
    const payload = JSON.parse(download.body) as {
      tasks: Array<{ id: string }>;
      plans: Array<{ id: string }>;
      sessions: unknown[];
      reviews: unknown[];
    };
    expect(payload.tasks.map((task) => task.id)).toContain(taskId);
    expect(payload.plans).toHaveLength(1);
    expect(payload.sessions).toEqual([]);
    expect(download.body).not.toContain('p256dh');
    expect(download.body).not.toContain('password');

    await ctx.seedUser({ email: 'other-daily@example.com', password: 'correct-horse' });
    const other = await login(ctx, 'other-daily@example.com', 'correct-horse');
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/exports/${exportId}`,
      headers: authHeaders(other),
    });
    expect(hidden.statusCode).toBe(404);
  });
});

describe.skipIf(!hasDatabase)('daily log redaction (M4-02)', () => {
  test('review notes and push key material never reach logs', async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino(
      defaultLoggerOptions(createConfig()) as unknown as pino.LoggerOptions,
      stream,
    );
    const ctx = await createTestContext({ loggerInstance: logger });
    try {
      const ownerId = await ctx.seedUser({ email: 'logs@example.com', password: 'correct-horse' });
      ctx.clock.set('2026-11-12T08:00:00Z' as Instant);
      const alice = await login(ctx, 'logs@example.com', 'correct-horse');
      const seeded = await seedM4Task(ctx, ownerId, { p50Min: 60, p90Min: 60 });
      const session = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          taskId: seeded.task.id,
          clientId: 'device',
          clientStartedAt: '2026-11-12T08:00:00Z',
        },
      });
      const created = session.json() as WorkSession;
      ctx.clock.set('2026-11-12T08:10:00Z' as Instant);
      const complete = await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${created.id}:complete`,
        headers: authHeaders(alice, {
          'if-match': 'W/"1"',
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { clientAt: '2026-11-12T08:10:00Z' },
      });
      const completed = complete.json() as WorkSession;
      const note = 'log-redaction-secret-note';
      await ctx.app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${created.id}/review`,
        headers: authHeaders(alice, {
          'if-match': `W/"${String(completed.version)}"`,
          'idempotency-key': newIdempotencyKey(),
        }),
        payload: { outcome: 'done', reasonChips: [], note },
      });
      const keyMaterial = 'log-redaction-secret-push-key';
      await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/push-subscriptions',
        headers: authHeaders(alice, { 'idempotency-key': newIdempotencyKey() }),
        payload: {
          endpoint: 'https://push.example.test/log',
          keys: { p256dh: keyMaterial, auth: keyMaterial },
        },
      });
      const output = chunks.join('');
      expect(output).not.toContain(note);
      expect(output).not.toContain(keyMaterial);
    } finally {
      await ctx.close();
    }
  });
});
