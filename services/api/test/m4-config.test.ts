import { configFromEnv } from '../src/config.js';
import { resolvePushKey } from '../src/application/push-crypto.js';

test('production PROVIDER=vikunja fails closed without a push key', () => {
  const config = configFromEnv({ PROVIDER: 'vikunja', NODE_ENV: 'production' });
  expect(config.pushKeyRequired).toBe(true);
  expect(() => resolvePushKey(config)).toThrow(/PUSH_KEY_FILE or PUSH_KEY/);
});

test('PUSH_KEY_REQUIRED opts a non-production boot into fail-closed behaviour', () => {
  const config = configFromEnv({ PROVIDER: 'vikunja', PUSH_KEY_REQUIRED: 'true' });
  expect(() => resolvePushKey(config)).toThrow(/PUSH_KEY_FILE or PUSH_KEY/);
  const supplied = configFromEnv({
    PROVIDER: 'vikunja',
    PUSH_KEY_REQUIRED: 'true',
    PUSH_KEY: '00'.repeat(32),
  });
  expect(resolvePushKey(supplied).key.length).toBe(32);
});
