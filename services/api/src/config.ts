export interface LoginRateLimitConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export type ProviderKind = 'memory' | 'vikunja';

/**
 * Background reconciliation is OFF by default: enabling it before FU-22 wires
 * `expectedLocalVersion` into the adapter's non-create mapping puts lets a
 * scheduled sweep race request handlers and reuse planner versions. Set
 * VIKUNJA_RECONCILE_INTERVAL_MS (e.g. 300000) only after that wiring lands.
 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 0;

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
  /** Background reconciliation interval; 0 (default) disables the timer. */
  readonly reconcileIntervalMs: number;
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
   * Fastify trustProxy. Default false: only enable when the API sits behind a
   * trusted reverse proxy (09 §5 tailnet proxy) and X-Forwarded-For is stripped.
   * A boolean, proxy address (string), list of addresses, or hop count.
   */
  readonly trustProxy: boolean | string | string[] | number;
}

export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export const defaultConfig: AppConfig = {
  provider: 'memory',
  vikunjaUrl: null,
  vikunjaTokenFile: null,
  reconcileIntervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
  vikunjaSecretsDir: null,
  cookieSecure: true,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  idempotencyTtlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
  loginRateLimit: { limit: 5, windowMs: 60_000 },
  logLevel: 'info',
  trustProxy: false,
};

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
  const reconcileIntervalMs =
    interval === undefined ? DEFAULT_RECONCILE_INTERVAL_MS : Number.parseInt(interval, 10);
  if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < 0) {
    throw new Error('VIKUNJA_RECONCILE_INTERVAL_MS must be a non-negative integer');
  }
  return createConfig({
    provider: provider ?? 'memory',
    vikunjaUrl: env['VIKUNJA_URL'] ?? null,
    vikunjaTokenFile: env['VIKUNJA_TOKEN_FILE'] ?? null,
    reconcileIntervalMs,
    vikunjaSecretsDir: env['VIKUNJA_SECRETS_DIR'] ?? null,
  });
}

export function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...defaultConfig,
    ...overrides,
    loginRateLimit: {
      ...defaultConfig.loginRateLimit,
      ...overrides.loginRateLimit,
    },
  };
}
