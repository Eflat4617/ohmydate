import { readFileSync, statSync } from 'node:fs';

export interface LoginRateLimitConfig {
  readonly limit: number;
  readonly windowMs: number;
}

export type ProviderKind = 'memory' | 'vikunja';

/** ADR-022: `fake` is the CI/test provider; `deepseek` is opt-in. */
export type LlmProviderKind = 'fake' | 'deepseek';

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
   * LLM provider selection (ADR-022). Defaults to `fake` so production never
   * falls through to a paid provider; `deepseek` must be explicit.
   */
  readonly llmProvider: LlmProviderKind;
  /** ADR-022 OpenCode Go gateway (OpenAI-compatible). */
  readonly llmBaseUrl: string;
  readonly llmModel: string;
  readonly llmReasoningEffort: string;
  /**
   * OpenCode Go requires an `x-opencode-session` header. `auto` sends a
   * non-identifying HMAC id only for opencode.ai hosts; `off` disables it.
   */
  readonly llmSessionHeader: 'auto' | 'off';
  /**
   * Absolute path to the product API key file. Read exactly once at boot;
   * never logged, stored in config snapshots, or sent in a request body.
   */
  readonly llmApiKeyFile: string | null;
  /** Token unit prices per 1M tokens (ADR-022 metadata defaults). */
  readonly llmPriceInputPerM: number;
  readonly llmPriceOutputPerM: number;
  readonly llmPriceCachedPerM: number;
  /**
   * Conservative per-owner default ceilings; `user.settings.llm.budget`
   * overrides them (ADR-022 says the user may change these).
   */
  readonly llmDailyBudgetUsd: number;
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
}

export const DEFAULT_SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_PROVIDER_MAX_CALL_MS = 40_000;
export const DEFAULT_LLM_BASE_URL = 'https://opencode.ai/inference/go/openai/v1';
export const DEFAULT_LLM_MODEL = 'deepseek-v4.1-flash';
export const DEFAULT_LLM_REASONING_EFFORT = 'medium';
export const DEFAULT_LLM_PRICE_INPUT_PER_M = 0.15;
export const DEFAULT_LLM_PRICE_OUTPUT_PER_M = 0.6;
export const DEFAULT_LLM_PRICE_CACHED_PER_M = 0.003;
/** Conservative ADR-022 defaults; users can raise them in settings. */
export const DEFAULT_LLM_DAILY_BUDGET_USD = 0.2;
export const DEFAULT_LLM_MONTHLY_BUDGET_USD = 5;

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
  llmProvider: 'fake',
  llmBaseUrl: DEFAULT_LLM_BASE_URL,
  llmModel: DEFAULT_LLM_MODEL,
  llmReasoningEffort: DEFAULT_LLM_REASONING_EFFORT,
  llmSessionHeader: 'auto',
  llmApiKeyFile: null,
  llmPriceInputPerM: DEFAULT_LLM_PRICE_INPUT_PER_M,
  llmPriceOutputPerM: DEFAULT_LLM_PRICE_OUTPUT_PER_M,
  llmPriceCachedPerM: DEFAULT_LLM_PRICE_CACHED_PER_M,
  llmDailyBudgetUsd: DEFAULT_LLM_DAILY_BUDGET_USD,
  llmMonthlyBudgetUsd: DEFAULT_LLM_MONTHLY_BUDGET_USD,
  providerMaxCallMs: DEFAULT_PROVIDER_MAX_CALL_MS,
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
  const providerKind = provider ?? 'memory';
  const databaseUrl = env['DATABASE_URL'] ?? null;
  const reconcileIntervalMs =
    interval === undefined
      ? defaultReconcileIntervalMs(providerKind, databaseUrl)
      : Number.parseInt(interval, 10);
  if (!Number.isInteger(reconcileIntervalMs) || reconcileIntervalMs < 0) {
    throw new Error('VIKUNJA_RECONCILE_INTERVAL_MS must be a non-negative integer');
  }
  const llmProvider = parseLlmProvider(env['LLM_PROVIDER']);
  const llmApiKeyFile = parseApiKeyFile(llmProvider, env['LLM_API_KEY_FILE']);
  return createConfig({
    provider: providerKind,
    vikunjaUrl: env['VIKUNJA_URL'] ?? null,
    vikunjaTokenFile: env['VIKUNJA_TOKEN_FILE'] ?? null,
    reconcileIntervalMs,
    databaseUrl,
    vikunjaSecretsDir: env['VIKUNJA_SECRETS_DIR'] ?? null,
    llmProvider,
    llmBaseUrl: env['LLM_BASE_URL'] ?? DEFAULT_LLM_BASE_URL,
    llmModel: env['LLM_MODEL'] ?? DEFAULT_LLM_MODEL,
    llmReasoningEffort: env['LLM_REASONING_EFFORT'] ?? DEFAULT_LLM_REASONING_EFFORT,
    llmSessionHeader: parseSessionHeader(env['LLM_SESSION_HEADER']),
    llmApiKeyFile,
    llmPriceInputPerM: parseMoney(
      'LLM_PRICE_INPUT_PER_M',
      env['LLM_PRICE_INPUT_PER_M'],
      DEFAULT_LLM_PRICE_INPUT_PER_M,
    ),
    llmPriceOutputPerM: parseMoney(
      'LLM_PRICE_OUTPUT_PER_M',
      env['LLM_PRICE_OUTPUT_PER_M'],
      DEFAULT_LLM_PRICE_OUTPUT_PER_M,
    ),
    llmPriceCachedPerM: parseMoney(
      'LLM_PRICE_CACHED_PER_M',
      env['LLM_PRICE_CACHED_PER_M'],
      DEFAULT_LLM_PRICE_CACHED_PER_M,
    ),
    llmDailyBudgetUsd: parseMoney(
      'LLM_DAILY_BUDGET_USD',
      env['LLM_DAILY_BUDGET_USD'],
      DEFAULT_LLM_DAILY_BUDGET_USD,
    ),
    llmMonthlyBudgetUsd: parseMoney(
      'LLM_MONTHLY_BUDGET_USD',
      env['LLM_MONTHLY_BUDGET_USD'],
      DEFAULT_LLM_MONTHLY_BUDGET_USD,
    ),
    providerMaxCallMs: parsePositiveInt(
      'PROVIDER_MAX_CALL_MS',
      env['PROVIDER_MAX_CALL_MS'],
      DEFAULT_PROVIDER_MAX_CALL_MS,
    ),
  });
}

function parseLlmProvider(raw: string | undefined): LlmProviderKind {
  if (raw === undefined || raw.trim() === '') return 'fake';
  const value = raw.trim();
  if (value !== 'fake' && value !== 'deepseek') {
    throw new Error(`LLM_PROVIDER must be "fake" or "deepseek", got "${value}"`);
  }
  return value;
}

function parseSessionHeader(raw: string | undefined): 'auto' | 'off' {
  if (raw === undefined || raw.trim() === '') return 'auto';
  const value = raw.trim();
  if (value !== 'auto' && value !== 'off') {
    throw new Error(`LLM_SESSION_HEADER must be "auto" or "off", got "${value}"`);
  }
  return value;
}

function parseApiKeyFile(
  provider: LlmProviderKind,
  raw: string | undefined,
): string | null {
  if (provider !== 'deepseek') return raw === undefined || raw.trim() === '' ? null : raw;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('LLM_API_KEY_FILE is required when LLM_PROVIDER=deepseek');
  }
  if (!isAbsolute(raw)) {
    throw new Error('LLM_API_KEY_FILE must be an absolute path');
  }
  return raw;
}

/**
 * Boot-time key read. Fail closed on a missing/empty/world-readable file.
 * Returns only the trimmed key; the caller must never log it or echo it.
 */
export function loadLlmApiKey(
  config: Pick<AppConfig, 'llmProvider' | 'llmApiKeyFile'>,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
  stat: (path: string) => { readonly mode: number } = (path) => statSync(path),
): string {
  if (config.llmProvider !== 'deepseek') return '';
  const file = config.llmApiKeyFile;
  if (file === null) {
    throw new Error('LLM_API_KEY_FILE is required when LLM_PROVIDER=deepseek');
  }
  let mode: number;
  try {
    mode = stat(file).mode;
  } catch {
    throw new Error('LLM_API_KEY_FILE does not exist or is not readable');
  }
  if ((mode & 0o077) !== 0) {
    throw new Error('LLM_API_KEY_FILE must not be group- or world-accessible (chmod 600)');
  }
  let raw: string;
  try {
    raw = read(file);
  } catch {
    throw new Error('LLM_API_KEY_FILE could not be read');
  }
  const key = raw.trim();
  if (key.length === 0) throw new Error('LLM_API_KEY_FILE is empty');
  return key;
}

function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path);
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function parseMoney(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
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
  if (overrides.reconcileIntervalMs !== undefined) return merged;
  return {
    ...merged,
    reconcileIntervalMs: defaultReconcileIntervalMs(merged.provider, merged.databaseUrl),
  };
}
