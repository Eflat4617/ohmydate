import type { Id, Instant } from '@ohmydate/domain';
import { AuthService } from '../src/application/auth-service.js';
import type {
  LoginRateLimiter,
  PasswordHasher,
  SessionStore,
  UserRecord,
  UserRepository,
} from '../src/application/ports.js';

const USER: UserRecord = {
  id: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55' as Id,
  email: 'known@example.com',
  passwordHash: 'real-argon2id-hash',
  timeZone: 'UTC',
  locale: 'en',
  version: 1,
  createdAt: '2026-01-01T00:00:00.000Z' as Instant,
  updatedAt: '2026-01-01T00:00:00.000Z' as Instant,
};

function makeService(overrides: {
  user: UserRecord | null;
  passwordOk: boolean;
}) {
  const verify = vi.fn(async () => overrides.passwordOk);
  const hash = vi.fn(async () => 'dummy-hash');
  const users = {
    findByEmail: vi.fn(async () => overrides.user),
    get: vi.fn(async () => overrides.user),
    insert: vi.fn(),
    updateSettings: vi.fn(),
  } as unknown as UserRepository;
  const hasher: PasswordHasher = { hash, verify };
  const sessions = {
    create: vi.fn(async () => ({
      id: 'session-1',
      userId: USER.id,
      csrfToken: 'csrf',
      createdAt: USER.createdAt,
      expiresAt: Date.now() + 1000,
    })),
    get: vi.fn(),
    touch: vi.fn(),
    delete: vi.fn(),
  } as unknown as SessionStore;
  const rateLimiter: LoginRateLimiter = { consume: () => true };
  const service = new AuthService({
    users,
    hasher,
    sessions,
    rateLimiter,
    dummyPasswordHash: 'dummy-hash',
  });
  return { service, verify };
}

test('unknown email still runs argon2 verify against the dummy hash', async () => {
  const { service, verify } = makeService({ user: null, passwordOk: false });
  await expect(
    service.login('unknown@example.com', 'attempt', '127.0.0.1'),
  ).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith('dummy-hash', 'attempt');
});

test('known email verifies against the stored hash', async () => {
  const { service, verify } = makeService({ user: USER, passwordOk: true });
  const result = await service.login('known@example.com', 'attempt', '127.0.0.1');
  expect(result.user.email).toBe(USER.email);
  expect(verify).toHaveBeenCalledTimes(1);
  expect(verify).toHaveBeenCalledWith('real-argon2id-hash', 'attempt');
});
