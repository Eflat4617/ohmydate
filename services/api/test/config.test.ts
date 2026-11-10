import { createConfig, defaultConfig } from '../src/config.js';

test('trustProxy is disabled by default and configurable', () => {
  expect(defaultConfig.trustProxy).toBe(false);
  expect(createConfig().trustProxy).toBe(false);
  expect(createConfig({ trustProxy: true }).trustProxy).toBe(true);
  expect(createConfig({ trustProxy: '127.0.0.1' }).trustProxy).toBe('127.0.0.1');
  expect(createConfig({ trustProxy: ['127.0.0.1'] }).trustProxy).toEqual(['127.0.0.1']);
  expect(createConfig({ trustProxy: 1 }).trustProxy).toBe(1);
});
