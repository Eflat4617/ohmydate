export const packageName = '@ohmydate/api' as const;

export { buildApp, defaultLoggerOptions, type BuildAppOptions } from './app.js';
export {
  createConfig,
  defaultConfig,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_SESSION_TTL_MS,
  type AppConfig,
  type LoginRateLimitConfig,
} from './config.js';
export type {
  AppRepositories,
  IdempotencyStore,
  OutboxEventInput,
  PasswordHasher,
  SessionStore,
  UserRecord,
  UserRepository,
} from './application/ports.js';
