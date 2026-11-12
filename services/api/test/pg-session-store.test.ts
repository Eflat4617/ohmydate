import { createHash, randomUUID } from 'node:crypto';
import type { Id, Instant } from '@ohmydate/domain';
import { instantToEpochMs } from '@ohmydate/domain';
import { FakeClock } from '@ohmydate/testkit';
import { sql } from 'kysely';
import {
  DEFAULT_SESSION_TOUCH_INTERVAL_MS,
  PgSessionStore,
} from '../src/adapters/pg-session-store.js';
import { createCsrfToken } from '../src/application/session-tokens.js';
import { queryFailure } from './db/helpers.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './vikunja/pg-support.js';

const TTL_MS = 14 * 24 * 60 * 60_000;
const START = '2026-11-12T08:00:00.000Z' as Instant;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe.skipIf(!hasDatabase)('PgSessionStore (FU-92)', () => {
  let pg: PgTestStore;
  let clock: FakeClock;
  let store: PgSessionStore;

  beforeEach(async () => {
    pg = await createPgTestStore();
    clock = new FakeClock(START);
    store = new PgSessionStore({ db: pg.db, clock, ttlMs: TTL_MS });
  });

  afterEach(async () => {
    await pg.close();
  });

  async function insertUser(): Promise<Id> {
    const id = randomUUID() as Id;
    await pg.db
      .insertInto('user')
      .values({ id, email: `${id}@example.test`, password_hash: 'argon2id-placeholder' })
      .execute();
    return id;
  }

  async function rows() {
    return pg.db.selectFrom('auth_session').selectAll().orderBy('expires_at').execute();
  }

  test('stores only SHA-256 digests of the session id and CSRF token', async () => {
    const userId = await insertUser();
    const csrf = createCsrfToken();
    const created = await store.create(userId, csrf);

    const stored = await rows();
    expect(stored).toHaveLength(1);
    const row = stored[0];
    if (row === undefined) throw new Error('expected a session row');
    expect(row.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.id_hash).not.toBe(created.id);
    expect(row.id_hash).toBe(sha256(created.id));
    expect(row.csrf_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.csrf_token_hash).not.toBe(csrf);
    expect(row.csrf_token_hash).toBe(sha256(csrf));
    expect(row.user_id).toBe(userId);
    expect(row.created_at.toISOString()).toBe(START);
    expect(row.last_seen_at.toISOString()).toBe(START);
    expect(row.expires_at.getTime()).toBe(instantToEpochMs(START) + TTL_MS);

    // Neither raw secret appears anywhere in the row.
    const text = JSON.stringify(row);
    expect(text).not.toContain(created.id);
    expect(text).not.toContain(csrf);
    const raw = await sql<{ row: string }>`SELECT t::text AS row FROM ${sql.table(
      `${pg.schema}.auth_session`,
    )} AS t`.execute(pg.db);
    expect(raw.rows[0]?.row).not.toContain(created.id);
    expect(raw.rows[0]?.row).not.toContain(csrf);
  });

  test('the schema rejects anything but a hex SHA-256 digest', async () => {
    const userId = await insertUser();
    const insert = (idHash: string, csrfHash: string) =>
      pg.db
        .insertInto('auth_session')
        .values({
          id_hash: idHash,
          user_id: userId,
          csrf_token_hash: csrfHash,
          expires_at: new Date(instantToEpochMs(START) + TTL_MS),
        })
        .execute();
    const rawSid = createCsrfToken();
    const sidFailure = await queryFailure(insert(rawSid, sha256('csrf')));
    expect(sidFailure.code).toBe('23514');
    expect(sidFailure.constraint).toBe('auth_session_id_hash_sha256');
    const csrfFailure = await queryFailure(insert(sha256(rawSid), 'raw-csrf-token'));
    expect(csrfFailure.code).toBe('23514');
    expect(csrfFailure.constraint).toBe('auth_session_csrf_token_hash_sha256');
    const upperFailure = await queryFailure(
      insert(sha256(rawSid).toUpperCase(), sha256('csrf')),
    );
    expect(upperFailure.code).toBe('23514');
  });

  test('a session survives a store re-instantiation (simulated restart)', async () => {
    const userId = await insertUser();
    const csrf = createCsrfToken();
    const created = await store.create(userId, csrf);

    const restartedClock = new FakeClock(START);
    restartedClock.advance(3 * 24 * 60 * 60_000);
    const restarted = new PgSessionStore({ db: pg.db, clock: restartedClock, ttlMs: TTL_MS });
    const record = await restarted.touch(created.id);
    expect(record).toMatchObject({
      id: created.id,
      userId,
      csrfTokenHash: sha256(csrf),
      createdAt: START,
      expiresAt: instantToEpochMs(restartedClock.now()) + TTL_MS,
    });
  });

  test('touch writes at most once per interval', async () => {
    expect(DEFAULT_SESSION_TOUCH_INTERVAL_MS).toBe(60_000);
    const userId = await insertUser();
    const created = await store.create(userId, createCsrfToken());

    clock.advance(30_000);
    const early = await store.touch(created.id);
    expect(early?.expiresAt).toBe(created.expiresAt);
    let [row] = await rows();
    expect(row?.last_seen_at.toISOString()).toBe(START);
    expect(row?.expires_at.getTime()).toBe(created.expiresAt);

    clock.advance(29_999);
    await store.touch(created.id);
    [row] = await rows();
    expect(row?.last_seen_at.toISOString()).toBe(START);

    clock.advance(1);
    const late = await store.touch(created.id);
    const nowMs = instantToEpochMs(clock.now());
    expect(late?.expiresAt).toBe(nowMs + TTL_MS);
    [row] = await rows();
    expect(row?.last_seen_at.getTime()).toBe(nowMs);
    expect(row?.expires_at.getTime()).toBe(nowMs + TTL_MS);
    expect(row?.created_at.toISOString()).toBe(START);
  });

  test('a clock that moved backwards re-anchors the expiry on touch', async () => {
    const userId = await insertUser();
    const created = await store.create(userId, createCsrfToken());
    clock.set('2026-11-11T08:00:00.000Z' as Instant);
    const touched = await store.touch(created.id);
    const nowMs = instantToEpochMs(clock.now());
    expect(touched?.expiresAt).toBe(nowMs + TTL_MS);
    const [row] = await rows();
    expect(row?.last_seen_at.getTime()).toBe(nowMs);
  });

  test('logout (delete) removes the row', async () => {
    const userId = await insertUser();
    const kept = await store.create(userId, createCsrfToken());
    const ended = await store.create(userId, createCsrfToken());
    await store.delete(ended.id);
    const remaining = await rows();
    expect(remaining.map((row) => row.id_hash)).toEqual([sha256(kept.id)]);
  });

  test('reading an expired session deletes its row', async () => {
    const userId = await insertUser();
    const created = await store.create(userId, createCsrfToken());
    clock.advance(TTL_MS);
    expect(await store.get(created.id)).toBeNull();
    expect(await rows()).toEqual([]);
  });

  test('touch after another process logged the session out returns null', async () => {
    const userId = await insertUser();
    const created = await store.create(userId, createCsrfToken());
    clock.advance(2 * 60_000);
    const other = new PgSessionStore({ db: pg.db, clock, ttlMs: TTL_MS });
    await other.delete(created.id);
    // Past the write interval, so a buggy upsert would recreate the row here.
    expect(await store.touch(created.id)).toBeNull();
    expect(await rows()).toEqual([]);
  });

  test('sweepExpired deletes only expired rows, oldest first, in bounded batches', async () => {
    const userId = await insertUser();
    const expired: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      expired.push((await store.create(userId, createCsrfToken())).id);
      clock.advance(60_000);
    }
    clock.set(START);
    clock.advance(TTL_MS + 5 * 60_000);
    const live = await store.create(userId, createCsrfToken());

    expect(await store.sweepExpired(2)).toBe(2);
    let remaining = (await rows()).map((row) => row.id_hash);
    expect(remaining).toEqual([sha256(expired[2] ?? ''), sha256(live.id)]);

    expect(await store.sweepExpired()).toBe(1);
    remaining = (await rows()).map((row) => row.id_hash);
    expect(remaining).toEqual([sha256(live.id)]);

    expect(await store.sweepExpired()).toBe(0);
    expect((await store.get(live.id))?.userId).toBe(userId);
  });

  test('deleting the user deletes their sessions (ON DELETE CASCADE)', async () => {
    const alice = await insertUser();
    const bob = await insertUser();
    const alices = await store.create(alice, createCsrfToken());
    const bobs = await store.create(bob, createCsrfToken());

    await pg.db.deleteFrom('user').where('id', '=', alice).execute();

    expect(await store.get(alices.id)).toBeNull();
    expect((await store.get(bobs.id))?.userId).toBe(bob);
    expect((await rows()).map((row) => row.user_id)).toEqual([bob]);
  });

  test('a session cannot be created for a user that does not exist', async () => {
    const failure = await queryFailure(store.create(randomUUID() as Id, createCsrfToken()));
    expect(failure.code).toBe('23503');
    expect(await rows()).toEqual([]);
  });
});
