import {
  DEFAULT_PROVIDER_MAX_CALL_MS,
  configFromEnv,
  createConfig,
  defaultConfig,
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
