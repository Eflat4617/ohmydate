import type { Id } from '@ohmydate/domain';
import { createCsrfToken } from '../adapters/in-memory-session-store.js';
import { normalizeEmail } from '../adapters/pg-user-repository.js';
import { ProblemError } from '../http/problem.js';
import type {
  LoginRateLimiter,
  PasswordHasher,
  SessionRecord,
  SessionStore,
  UserRecord,
  UserRepository,
  UserSettingsPatch,
} from './ports.js';

export interface AuthServiceDeps {
  readonly users: UserRepository;
  readonly hasher: PasswordHasher;
  readonly sessions: SessionStore;
  readonly rateLimiter: LoginRateLimiter;
  /**
   * Argon2id hash produced with the same parameters as real users. Unknown
   * emails verify against it so login latency does not reveal account existence.
   */
  readonly dummyPasswordHash: string;
}

export interface LoginResult {
  readonly user: UserRecord;
  readonly session: SessionRecord;
}

export class AuthService {
  readonly #users: AuthServiceDeps['users'];
  readonly #hasher: AuthServiceDeps['hasher'];
  readonly #sessions: AuthServiceDeps['sessions'];
  readonly #rateLimiter: AuthServiceDeps['rateLimiter'];
  readonly #dummyPasswordHash: string;

  constructor(deps: AuthServiceDeps) {
    this.#users = deps.users;
    this.#hasher = deps.hasher;
    this.#sessions = deps.sessions;
    this.#rateLimiter = deps.rateLimiter;
    this.#dummyPasswordHash = deps.dummyPasswordHash;
  }

  async login(email: string, password: string, ip: string): Promise<LoginResult> {
    const normalized = normalizeEmail(email);
    if (!this.#rateLimiter.consume(`${ip}:${normalized}`)) {
      throw new ProblemError({
        status: 429,
        code: 'rate_limited',
        title: 'Too many login attempts',
        detail: 'retry after the rate-limit window',
      });
    }

    const user = await this.#users.findByEmail(normalized);
    const passwordHash = user?.passwordHash ?? this.#dummyPasswordHash;
    const passwordOk = await this.#hasher.verify(passwordHash, password);
    if (user === null || !passwordOk) {
      throw new ProblemError({
        status: 401,
        code: 'unauthenticated',
        title: 'Invalid credentials',
        detail: 'email or password is incorrect',
      });
    }

    const session = await this.#sessions.create(user.id, createCsrfToken());
    return { user, session };
  }

  async logout(sessionId: string): Promise<void> {
    await this.#sessions.delete(sessionId);
  }

  async me(userId: Id): Promise<UserRecord> {
    const user = await this.#users.get(userId);
    if (user === null) {
      throw new ProblemError({
        status: 401,
        code: 'unauthenticated',
        title: 'Invalid session',
        detail: 'the session user no longer exists',
      });
    }
    return user;
  }

  async updateSettings(
    userId: Id,
    patch: UserSettingsPatch,
    expectedVersion: number,
  ): Promise<UserRecord> {
    return this.#users.updateSettings(userId, patch, expectedVersion);
  }
}
