import { createHash, randomUUID } from 'node:crypto';
import type { Id, Instant } from '@ohmydate/domain';
import { instantToEpochMs } from '@ohmydate/domain';
import { FakeClock } from '@ohmydate/testkit';
import { InMemorySessionStore } from '../src/adapters/in-memory-session-store.js';
import { PgSessionStore } from '../src/adapters/pg-session-store.js';
import type { SessionStore } from '../src/application/ports.js';
import { createCsrfToken } from '../src/application/session-tokens.js';
import { createPgTestStore, hasDatabase, type PgTestStore } from './vikunja/pg-support.js';

/**
 * FU-92: one behavioural contract for every SessionStore. Both stores are
 * driven through the same cases; PG-only properties live in
 * pg-session-store.test.ts.
 */

const TTL_MS = 10 * 60_000;
const MINUTE = 60_000;
const START = '2026-11-12T08:00:00.000Z' as Instant;

interface Harness {
  readonly clock: FakeClock;
  readonly store: SessionStore;
  /** A user the store may reference (PG enforces the FK). */
  newUser(): Promise<Id>;
  close(): Promise<void>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function tamper(sessionId: string): string {
  const last = sessionId.at(-1) === 'A' ? 'B' : 'A';
  return `${sessionId.slice(0, -1)}${last}`;
}

function runContract(
  name: string,
  skip: boolean,
  makeHarness: () => Promise<Harness>,
): void {
  describe.skipIf(skip)(`SessionStore contract: ${name}`, () => {
    let h: Harness;

    beforeEach(async () => {
      h = await makeHarness();
    });

    afterEach(async () => {
      await h.close();
    });

    test('create returns a random sid, the raw CSRF token once and its digest', async () => {
      const userId = await h.newUser();
      const csrf = createCsrfToken();
      const created = await h.store.create(userId, csrf);
      expect(created.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(created.userId).toBe(userId);
      expect(created.csrfToken).toBe(csrf);
      expect(created.csrfTokenHash).toBe(sha256(csrf));
      expect(created.createdAt).toBe(START);
      expect(created.expiresAt).toBe(instantToEpochMs(START) + TTL_MS);

      const other = await h.store.create(userId, csrf);
      expect(other.id).not.toBe(created.id);
    });

    test('get returns the session without the raw CSRF token', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      const record = await h.store.get(created.id);
      expect(record).toEqual({
        id: created.id,
        userId,
        csrfTokenHash: created.csrfTokenHash,
        createdAt: START,
        expiresAt: created.expiresAt,
      });
      expect(record).not.toHaveProperty('csrfToken');
    });

    test('unknown, tampered and malformed session ids read as null', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      const unknown = Buffer.alloc(32, 7).toString('base64url');
      for (const sid of [
        unknown,
        tamper(created.id),
        created.id.toUpperCase() === created.id ? created.id.toLowerCase() : created.id.toUpperCase(),
        `${created.id}x`,
        created.id.slice(1),
        '',
        ' ',
        sha256(created.id),
        'x'.repeat(10_000),
      ]) {
        expect(await h.store.get(sid)).toBeNull();
        expect(await h.store.touch(sid)).toBeNull();
      }
      // None of the probes disturbed the real session.
      expect((await h.store.get(created.id))?.userId).toBe(userId);
    });

    test('touch slides the expiry to now + TTL', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      h.clock.advance(5 * MINUTE);
      const touched = await h.store.touch(created.id);
      expect(touched?.expiresAt).toBe(instantToEpochMs(h.clock.now()) + TTL_MS);
      expect(touched?.createdAt).toBe(START);
      expect((await h.store.get(created.id))?.expiresAt).toBe(touched?.expiresAt);
    });

    test('regular use keeps a session alive past the original TTL', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      for (let step = 0; step < 4; step += 1) {
        h.clock.advance(8 * MINUTE);
        expect(await h.store.touch(created.id)).not.toBeNull();
      }
      // 32 minutes after login with a 10-minute TTL.
      expect((await h.store.get(created.id))?.userId).toBe(userId);
    });

    test('a session expires TTL after its last touch and stays gone', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      h.clock.advance(TTL_MS - 1);
      expect(await h.store.get(created.id)).not.toBeNull();
      h.clock.advance(1);
      // Exactly at expiresAt the session is no longer valid.
      expect(await h.store.get(created.id)).toBeNull();
      expect(await h.store.touch(created.id)).toBeNull();
      // Expired sessions are deleted, so a clock that moves back cannot revive them.
      h.clock.set(START);
      expect(await h.store.get(created.id)).toBeNull();
    });

    test('get does not slide the expiry', async () => {
      const userId = await h.newUser();
      const created = await h.store.create(userId, createCsrfToken());
      h.clock.advance(5 * MINUTE);
      expect((await h.store.get(created.id))?.expiresAt).toBe(created.expiresAt);
      h.clock.advance(5 * MINUTE);
      expect(await h.store.get(created.id)).toBeNull();
    });

    test('delete ends only that session and tolerates unknown ids', async () => {
      const alice = await h.newUser();
      const bob = await h.newUser();
      const first = await h.store.create(alice, createCsrfToken());
      const second = await h.store.create(alice, createCsrfToken());
      const bobs = await h.store.create(bob, createCsrfToken());

      await h.store.delete(first.id);
      expect(await h.store.get(first.id)).toBeNull();
      expect(await h.store.touch(first.id)).toBeNull();
      expect((await h.store.get(second.id))?.userId).toBe(alice);
      expect((await h.store.get(bobs.id))?.userId).toBe(bob);

      await expect(h.store.delete(first.id)).resolves.toBeUndefined();
      await expect(h.store.delete('not-a-session')).resolves.toBeUndefined();
      await expect(h.store.delete('')).resolves.toBeUndefined();
    });

    test('each session is bound to the user it was created for', async () => {
      const alice = await h.newUser();
      const bob = await h.newUser();
      const csrf = createCsrfToken();
      const a = await h.store.create(alice, csrf);
      const b = await h.store.create(bob, csrf);
      expect((await h.store.touch(a.id))?.userId).toBe(alice);
      expect((await h.store.touch(b.id))?.userId).toBe(bob);
    });
  });
}

runContract('InMemorySessionStore', false, async () => {
  const clock = new FakeClock(START);
  return {
    clock,
    store: new InMemorySessionStore({ clock, ttlMs: TTL_MS }),
    newUser: async () => randomUUID() as Id,
    close: async () => undefined,
  };
});

runContract('PgSessionStore', !hasDatabase, async () => {
  const pg: PgTestStore = await createPgTestStore();
  const clock = new FakeClock(START);
  return {
    clock,
    store: new PgSessionStore({ db: pg.db, clock, ttlMs: TTL_MS }),
    async newUser() {
      const id = randomUUID() as Id;
      await pg.db
        .insertInto('user')
        .values({ id, email: `${id}@example.test`, password_hash: 'argon2id-placeholder' })
        .execute();
      return id;
    },
    close: () => pg.close(),
  };
});
