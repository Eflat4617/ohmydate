import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_DAILY_BUDGET_USD,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_MONTHLY_BUDGET_USD,
  DEFAULT_LLM_PRICE_CACHED_PER_M,
  DEFAULT_LLM_PRICE_INPUT_PER_M,
  DEFAULT_LLM_PRICE_OUTPUT_PER_M,
  DEFAULT_LLM_REASONING_EFFORT,
  DEFAULT_PROVIDER_MAX_CALL_MS,
  configFromEnv,
  createConfig,
  defaultConfig,
  loadLlmApiKey,
} from '../src/config.js';

test('trustProxy is disabled by default and configurable', () => {
  expect(defaultConfig.trustProxy).toBe(false);
  expect(createConfig().trustProxy).toBe(false);
  expect(createConfig({ trustProxy: true }).trustProxy).toBe(true);
  expect(createConfig({ trustProxy: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
  expect(createConfig({ trustProxy: ['127.0.0.1'] }).trustProxy).toEqual(['127.0.0.1']);
  expect(createConfig({ trustProxy: 1 }).trustProxy).toBe(1);
});

test('PROVIDER_MAX_CALL_MS defaults to a full Vikunja call budget and parses env', () => {
  expect(DEFAULT_PROVIDER_MAX_CALL_MS).toBe(40_000);
  expect(createConfig().providerMaxCallMs).toBe(DEFAULT_PROVIDER_MAX_CALL_MS);
  expect(configFromEnv({}).providerMaxCallMs).toBe(DEFAULT_PROVIDER_MAX_CALL_MS);
  expect(configFromEnv({ PROVIDER_MAX_CALL_MS: '60000' }).providerMaxCallMs).toBe(60_000);
  expect(() => configFromEnv({ PROVIDER_MAX_CALL_MS: '0' })).toThrow(
    'PROVIDER_MAX_CALL_MS must be a positive integer',
  );
});

test('LLM provider defaults to fake and deepseek opts in with ADR-022 defaults', () => {
  expect(defaultConfig.llmProvider).toBe('fake');
  const fake = configFromEnv({});
  expect(fake.llmProvider).toBe('fake');
  expect(fake.llmBaseUrl).toBe(DEFAULT_LLM_BASE_URL);
  expect(fake.llmModel).toBe(DEFAULT_LLM_MODEL);
  expect(fake.llmReasoningEffort).toBe(DEFAULT_LLM_REASONING_EFFORT);
  expect(fake.llmSessionHeader).toBe('auto');
  expect(fake.llmPriceInputPerM).toBe(DEFAULT_LLM_PRICE_INPUT_PER_M);
  expect(fake.llmPriceOutputPerM).toBe(DEFAULT_LLM_PRICE_OUTPUT_PER_M);
  expect(fake.llmPriceCachedPerM).toBe(DEFAULT_LLM_PRICE_CACHED_PER_M);
  expect(fake.llmDailyBudgetUsd).toBe(DEFAULT_LLM_DAILY_BUDGET_USD);
  expect(fake.llmMonthlyBudgetUsd).toBe(DEFAULT_LLM_MONTHLY_BUDGET_USD);

  expect(() => configFromEnv({ LLM_PROVIDER: 'openai' })).toThrow(/LLM_PROVIDER/);
  expect(configFromEnv({ LLM_SESSION_HEADER: 'off' }).llmSessionHeader).toBe('off');
  expect(configFromEnv({ LLM_SESSION_HEADER: 'auto' }).llmSessionHeader).toBe('auto');
  expect(() => configFromEnv({ LLM_SESSION_HEADER: 'always' })).toThrow(
    /LLM_SESSION_HEADER/,
  );
  expect(() => configFromEnv({ LLM_PROVIDER: 'deepseek' })).toThrow(/LLM_API_KEY_FILE/);
  expect(() =>
    configFromEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY_FILE: 'relative/key.txt' }),
  ).toThrow(/absolute/);
  const deepseek = configFromEnv({
    LLM_PROVIDER: 'deepseek',
    LLM_API_KEY_FILE: '/run/secrets/llm.key',
  });
  expect(deepseek.llmProvider).toBe('deepseek');
  expect(deepseek.llmApiKeyFile).toBe('/run/secrets/llm.key');
});

describe('loadLlmApiKey fails closed', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ohmydate-llm-key-'));
    file = join(dir, 'deepseek_api_key.txt');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads a trimmed 0600 key once and keeps it out of config', () => {
    writeFileSync(file, '  sk-synthetic-test-marker  \n', { mode: 0o600 });
    chmodSync(file, 0o600);
    const config = configFromEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY_FILE: file });
    const key = loadLlmApiKey(config);
    expect(key).toBe('sk-synthetic-test-marker');
    expect(JSON.stringify(config)).not.toContain('sk-synthetic-test-marker');
  });

  test('rejects a world/group-readable key file', () => {
    writeFileSync(file, 'sk-synthetic-test-marker\n', { mode: 0o644 });
    chmodSync(file, 0o644);
    const config = configFromEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY_FILE: file });
    expect(() => loadLlmApiKey(config)).toThrow(/chmod 600/);
  });

  test('rejects a missing, empty or unreadable key file', () => {
    const missing = configFromEnv({
      LLM_PROVIDER: 'deepseek',
      LLM_API_KEY_FILE: join(dir, 'missing.txt'),
    });
    expect(() => loadLlmApiKey(missing)).toThrow(/does not exist/);

    writeFileSync(file, '   \n', { mode: 0o600 });
    chmodSync(file, 0o600);
    const empty = configFromEnv({ LLM_PROVIDER: 'deepseek', LLM_API_KEY_FILE: file });
    expect(() => loadLlmApiKey(empty)).toThrow(/empty/);
  });

  test('fake provider needs no key', () => {
    expect(loadLlmApiKey(configFromEnv({}))).toBe('');
  });
});
