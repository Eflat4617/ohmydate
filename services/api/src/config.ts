export interface LoginRateLimitConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export interface AppConfig {
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
  cookieSecure: true,
  sessionTtlMs: DEFAULT_SESSION_TTL_MS,
  idempotencyTtlMs: DEFAULT_IDEMPOTENCY_TTL_MS,
  loginRateLimit: { limit: 5, windowMs: 60_000 },
  logLevel: 'info',
  trustProxy: false,
};

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
