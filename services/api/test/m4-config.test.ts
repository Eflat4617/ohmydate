import { configFromEnv } from '../src/config.js';
import { resolvePushKey } from '../src/application/push-crypto.js';

test('PROVIDER != memory fails closed without a push key, regardless of NODE_ENV', () => {
  for (const env of [
    { PROVIDER: 'vikunja' },
    { PROVIDER: 'vikunja', NODE_ENV: 'development' },
    { PROVIDER: 'vikunja', NODE_ENV: 'production' },
  ]) {
    const config = configFromEnv(env);
    expect(() => resolvePushKey(config)).toThrow(/PUSH_KEY_FILE or PUSH_KEY/);
  }
});

test('an explicit PUSH_KEY satisfies the fail-closed boot policy', () => {
  const config = configFromEnv({
    PROVIDER: 'vikunja',
    PUSH_KEY: '00'.repeat(32),
  });
  expect(resolvePushKey(config).key.length).toBe(32);
});
