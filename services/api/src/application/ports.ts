import type { Id, Instant, ProjectRepository, TaskRepository } from '@ohmydate/domain';

export interface AppRepositories {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
}

export interface LlmConsentSettings {
  readonly granted: boolean;
  readonly at: Instant;
  readonly provider: string;
}

export interface LlmBudgetSettings {
  readonly dailyUsd: number;
  readonly monthlyUsd: number;
}

/** 05 §12 / ADR-022: owner-scoped consent + budget in `user.settings.llm`. */
export interface LlmUserSettings {
  readonly consent?: LlmConsentSettings;
  readonly budget?: LlmBudgetSettings;
}

export interface UserSettings {
  readonly llm?: LlmUserSettings;
}

export interface UserRecord {
  readonly id: Id;
  readonly email: string;
  readonly passwordHash: string;
  readonly timeZone: string;
  readonly locale: string;
  readonly settings: UserSettings;
  readonly version: number;
  readonly createdAt: Instant;
  readonly updatedAt: Instant;
}

export interface UserSettingsPatch {
  readonly timeZone?: string;
  readonly locale?: string;
  /** Already-normalized consent timestamp/provider from the route handler. */
  readonly llm?: LlmUserSettings;
}

export interface UserRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  get(id: Id): Promise<UserRecord | null>;
  insert(input: {
    readonly id: Id;
    readonly email: string;
    readonly passwordHash: string;
    readonly timeZone?: string;
    readonly locale?: string;
  }): Promise<UserRecord>;
  updateSettings(
    id: Id,
    patch: UserSettingsPatch,
    expectedVersion: number,
  ): Promise<UserRecord>;
}

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(passwordHash: string, password: string): Promise<boolean>;
}

export interface SessionRecord {
  /** The raw session id the caller presented (`sid` cookie); never persisted. */
  readonly id: string;
  readonly userId: Id;
  /**
   * Lowercase hex SHA-256 of the session's CSRF token (FU-92). The raw token
   * lives only in the browser's `csrf` cookie; verify with
   * `sessionSecretMatches` (constant time).
   */
  readonly csrfTokenHash: string;
  readonly createdAt: Instant;
  readonly expiresAt: number;
}

/** Returned once by `create`: the only point where the raw CSRF token is known. */
export interface CreatedSession extends SessionRecord {
  readonly csrfToken: string;
}

/**
 * Server-side login-session store (14-day sliding expiry). FU-92:
 * `PgSessionStore` persists sessions (digests only) so a login survives API
 * restarts whenever a database backs the Vikunja provider
 * (`PROVIDER=vikunja` + DATABASE_URL); `InMemorySessionStore` stays for
 * `PROVIDER=memory` and unit tests. Expired sessions read as null.
 */
export interface SessionStore {
  create(userId: Id, csrfToken: string): Promise<CreatedSession>;
  get(sessionId: string): Promise<SessionRecord | null>;
  /** Like `get`, and slides the expiry to now + TTL. */
  touch(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
}

export interface LoginRateLimiter {
  /** Returns false when the attempt is over the configured window budget. */
  consume(key: string): boolean;
  /** Clears all windows. Only the E2E reset route calls this. */
  reset(): void;
}

export interface OutboxEventInput {
  readonly topic: string;
  readonly taskId: Id;
  readonly version: number;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type IdempotencyReservation =
  | { readonly kind: 'reserved' }
  | { readonly kind: 'replay'; readonly response: StoredResponse }
  | { readonly kind: 'pending' }
  | { readonly kind: 'mismatch' };

export interface IdempotencyReserveInput {
  readonly ownerId: Id;
  readonly key: string;
  readonly route: string;
  readonly requestHash: string;
}

export interface IdempotencyCompleteInput {
  readonly ownerId: Id;
  readonly key: string;
  readonly response: StoredResponse;
  readonly outbox: readonly OutboxEventInput[];
}

export interface IdempotencyStore {
  reserve(input: IdempotencyReserveInput): Promise<IdempotencyReservation>;
  complete(input: IdempotencyCompleteInput): Promise<void>;
  release(ownerId: Id, key: string): Promise<void>;
}
