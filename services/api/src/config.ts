export interface LoginRateLimitConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export type ProviderKind = 'memory' | 'vikunja';

/**
 * Background reconciliation is ON by default for `PROVIDER=vikunja` with a
 * `databaseUrl` (five minutes). FU-22's `expectedLocalVersion` CAS wiring and
 * the FU-28 leader-liveness hardening make a scheduled sweep safe to overlap
 * request handlers. `PROVIDER=memory` and configs without a lock database stay
 * at zero because they have no cross-process leader lock to acquire.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000;

/** Reconciliation is always off for the in-memory provider. */
export const DISABLED_RECONCILE_INTERVAL_MS = 0;

/**
 * Effective default before an explicit VIKUNJA_RECONCILE_INTERVAL_MS override:
 * 300 s only when the Vikunja provider has a database for the session advisory
 * lock; 0 otherwise.
 */
export function defaultReconcileIntervalMs(
  provider: ProviderKind,
  databaseUrl: string | null,
): number {
  return provider === 'vikunja' && databaseUrl !== null && databaseUrl.length > 0
    ? DEFAULT_RECONCILE_INTERVAL_MS
    : DISABLED_RECONCILE_INTERVAL_MS;
}

export interface AppConfig {
  /**
   * Task/project repository provider. `memory` keeps the injected in-memory
   * repositories (M1 default); `vikunja` builds the Vikunja adapter with the
   * durable PostgreSQL stores.
   */
  readonly provider: ProviderKind;
  /** Vikunja base URL, e.g. http://127.0.0.1:3456. Required when provider=vikunja. */
  readonly vikunjaUrl: string | null;
  /**
   * Default token file used by owner accounts whose token_secret_ref is
   * `default`. The file is a JSON object of ownerId -> API token; tokens are
   * never stored in PostgreSQL. Required when any owner uses the default ref.
   */
  readonly vikunjaTokenFile: string | null;
  /**
   * Background reconciliation interval. Defaults to 300000 when
   * provider=vikunja and databaseUrl is set, and 0 (timer disabled) for the
   * memory provider or a missing lock database. An explicit 0 disables it.
   */
  readonly reconcileIntervalMs: number;
  /**
   * Database URL for the reconciler's dedicated leader-lock connection. This
   * must point at the same database as the injected Kysely handle because
   * advisory locks are per database. Required when reconcileIntervalMs > 0.
   */
  readonly databaseUrl: string | null;
  /**
   * Directory that may contain token files referenced as `file:<path>`. Any
   * such file must realpath-resolve inside this directory (or be exactly
   * VIKUNJA_TOKEN_FILE); traversal and symlink escapes are rejected.
   */
  readonly vikunjaSecretsDir: string | null;
  /**
   * Dev runs over plain HTTP on the loopback interface, so the session cookie's
   * Secure attribute is configurable. Production must keep this true.
   */
  readonly cookieSecure: boolean;
  /** Session lifetime (sliding). ADR-011 assumes 14 days. */
  readonly sessionTtlMs: number;
  /** Idempotency record retention per 08 §1. */
  readonly idempotencyTtlMs: number;
  /** 5 requests per minute per IP+email for POST /auth/login. */
  readonly loginRateLimit: LoginRateLimitConfig;
  readonly logLevel: string;
  /**
   * LLM provider selection. Only `fake` is wired in M2-03 (GB-1 pending);
   * missing/other values leave the provider unconfigured, so intake steps fail
   * to manual mode instead of calling a paid API.
   */
  readonly llmProvider: string | null;
  /** Daily USD ceiling for the BudgetGuard. Zero/absent fails closed (ADR-008). */
  readonly llmDailyBudgetUsd: number;
  /** Monthly USD ceiling for the BudgetGuard. Zero/absent fails closed (ADR-008). */
  readonly llmMonthlyBudgetUsd: number;
  /**
   * ADR-020 §7: succession wait for an approval whose previous holder lost its
   * dedicated lock connection. Must be >= the Vikunja client call budget.
   */
  readonly providerMaxCallMs: number;
  /**
   * Fastify trustProxy. Default false: only enable when the API sits behind a
   * trusted reverse proxy (09 §5 tailnet proxy) and X-Forwarded-For is stripped.
   * A boolean, proxy address (string), list of addresses, or hop count.
   */
  readonly trustProxy: boolean | string | string[] | number;
  /** Path to the 32-byte Web Push encryption key (base64 or hex). */
  readonly pushKeyFile: string | null;
  /** Inline Web Push encryption key (base64 or hex) as an env-ref fallback. */
  readonly pushKey: string | null;
}

export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROVIDER_MAX_CALL_MS = 40_000;

export const defaultConfig: AppConfig = {
  provider: 'memory',
  vikunjaUrl: null,
  vikunjaTokenFile: null,
  reconcileIntervalMs: DISABLED_RECONCILE_INTERVAL_MS,
  databaseUrl: null,
  vikunjaSecretsDir: null,
  cookieSecure: true,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  idempotencyTtlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
  loginRateLimit: { limit: 5, windowMs: 60_000 },
  logLevel: 'info',
  llmProvider: null,
  llmDailyBudgetUsd: 0,
  llmMonthlyBudgetUsd: 0,
  providerMaxCallMs: DEFAULT_PROVIDER_MAX_CALL_MS,
  trustProxy: false,
  pushKeyFile: null,
  pushKey: null,
};

/**
 * Deterministic key used only by `createConfig` callers that do not supply one
 * (unit/integration tests). The production env path (`configFromEnv`) leaves
 * both key fields null, so boot fails closed whenever PROVIDER != memory.
 */
export const DEV_SYNTHETIC_PUSH_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

/**
 * Reads the documented provider wiring from the environment. `PROVIDER`
 * defaults to `memory`; the Vikunja URL/token file and reconcile interval are
 * only required for `provider=vikunja`.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const provider = env['PROVIDER'];
  if (provider !== undefined && provider !== 'memory' && provider !== 'vikunja') {
    throw new Error(`PROVIDER must be "memory" or "vikunja", got "${provider}"`);
  }
  const interval = env['VIKUNJA_RECONCILE_INTERVAL_MS'];
  const providerKind = provider ?? 'memory';
  const databaseUrl = env['DATABASE_URL'] ?? null;
  const reconcileIntervalMs =
    interval === undefined
      ? defaultReconcileIntervalMs(providerKind, databaseUrl)
      : Number.parseInt(interval, 10);
  if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < 0) {
    throw new Error('VIKUNJA_RECONCILE_INTERVAL_MS must be a non-negative integer');
  }
  return createConfig({
    provider: providerKind,
    vikunjaUrl: env['VIKUNJA_URL'] ?? null,
    vikunjaTokenFile: env['VIKUNJA_TOKEN_FILE'] ?? null,
    reconcileIntervalMs,
    databaseUrl,
    vikunjaSecretsDir: env['VIKUNJA_SECRETS_DIR'] ?? null,
    llmProvider: env['LLM_PROVIDER'] ?? null,
    llmDailyBudgetUsd: parseBudget('LLM_DAILY_BUDGET_USD', env['LLM_DAILY_BUDGET_USD']),
    llmMonthlyBudgetUsd: parseBudget('LLM_MONTHLY_BUDGET_USD', env['LLM_MONTHLY_BUDGET_USD']),
    providerMaxCallMs: parsePositiveInt(
      'PROVIDER_MAX_CALL_MS',
      env['PROVIDER_MAX_CALL_MS'],
      DEFAULT_PROVIDER_MAX_CALL_MS,
    ),
    pushKeyFile: env['PUSH_KEY_FILE'] ?? null,
    pushKey: env['PUSH_KEY'] ?? null,
  });
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseBudget(name: string, raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 0;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

export function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const merged: AppConfig = {
    ...defaultConfig,
    ...overrides,
    loginRateLimit: {
      ...defaultConfig.loginRateLimit,
      ...overrides.loginRateLimit,
    },
  };
  const resolved =
    overrides.reconcileIntervalMs !== undefined
      ? merged
      : {
          ...merged,
          reconcileIntervalMs: defaultReconcileIntervalMs(merged.provider, merged.databaseUrl),
        };
  if (
    overrides.pushKey === undefined &&
    overrides.pushKeyFile === undefined &&
    resolved.pushKey === null &&
    resolved.pushKeyFile === null &&
    resolved.provider !== 'memory'
  ) {
    return { ...resolved, pushKey: DEV_SYNTHETIC_PUSH_KEY };
  }
  return resolved;
}
