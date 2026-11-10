import { createConfig, defaultConfig } from '../src/config.js';

test('trustProxy is disabled by default and configurable', () => {
  expect(defaultConfig.trustProxy).toBe(false);
  expect(createConfig().trustProxy).toBe(false);
  expect(createConfig({ trustProxy: true }).trustProxy).toBe(true);
});
