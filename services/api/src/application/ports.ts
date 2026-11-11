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
  readonly id: string;
  readonly userId: Id;
  readonly csrfToken: string;
  readonly createdAt: Instant;
  readonly expiresAt: number;
}

/**
 * Server-side session store. The in-memory implementation is sufficient for a
 * single API process in M1; the interface is intentionally storage agnostic so
 * a PostgreSQL-backed store can replace it without touching routes.
 */
export interface SessionStore {
  create(userId: Id, csrfToken: string): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  touch(sessionId: string): Promise<SessionRecord | null>;
  delete(sessionId: string): Promise<void>;
}

export interface LoginRateLimiter {
  /** Returns false when the attempt is over the configured window budget. */
  consume(key: string): boolean;
  /** Clears all windows. Only the E2E reset route calls this. */
  reset?(): void;
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
