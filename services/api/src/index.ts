export const packageName = '@ohmydate/api' as const;

export { buildApp, defaultLoggerOptions, type BuildAppOptions } from './app.js';
export {
  configFromEnv,
  createConfig,
  defaultConfig,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_RECONCILE_INTERVAL_MS,
  DEFAULT_SESSION_TTL_MS,
  type AppConfig,
  type LoginRateLimitConfig,
  type ProviderKind,
} from './config.js';
export {
  createVikunjaRepositories,
  type VikunjaCompositionOptions,
  type VikunjaRepositories,
} from './adapters/vikunja/composition.js';
export {
  createPgAdvisoryLeaderLock,
  VIKUNJA_RECONCILE_ADVISORY_LOCK_KEY,
  VikunjaReconciler,
  type LeaderLock,
  type VikunjaReconcilerOptions,
} from './adapters/vikunja/reconciler.js';
export { PgChangeJournalStore } from './adapters/vikunja/pg-change-journal-store.js';
export { PgMappingStore } from './adapters/vikunja/pg-mapping-store.js';
export { PgPlannerFieldStore } from './adapters/vikunja/pg-planner-field-store.js';
export type {
  AppRepositories,
  IdempotencyStore,
  OutboxEventInput,
  PasswordHasher,
  SessionStore,
  UserRecord,
  UserRepository,
} from './application/ports.js';
