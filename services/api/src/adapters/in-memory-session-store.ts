import { randomBytes } from 'node:crypto';
import { epochMsToInstant, instantToEpochMs, type Clock, type Id } from '@ohmydate/domain';
import type { SessionRecord, SessionStore } from '../application/ports.js';

export interface InMemorySessionStoreOptions {
  readonly clock: Clock;
  readonly ttlMs: number;
}

export class InMemorySessionStore implements SessionStore {
  readonly #clock: InMemorySessionStoreOptions['clock'];
  readonly #ttlMs: number;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(options: InMemorySessionStoreOptions) {
    this.#clock = options.clock;
    this.#ttlMs = options.ttlMs;
  }

  async create(userId: Id, csrfToken: string): Promise<SessionRecord> {
    const id = randomBytes(32).toString('base64url');
    const now = epochMsToInstant(instantToEpochMs(this.#clock.now()));
    const record: SessionRecord = {
      id,
      userId,
      csrfToken,
      createdAt: now,
      expiresAt: instantToEpochMs(now) + this.#ttlMs,
    };
    this.#sessions.set(id, record);
    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return null;
    if (record.expiresAt <= instantToEpochMs(this.#clock.now())) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return record;
  }

  async touch(sessionId: string): Promise<SessionRecord | null> {
    const current = await this.get(sessionId);
    if (current === null) return null;
    const record: SessionRecord = {
      ...current,
      expiresAt: instantToEpochMs(this.#clock.now()) + this.#ttlMs,
    };
    this.#sessions.set(sessionId, record);
    return record;
  }

  async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}

export function createCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}
