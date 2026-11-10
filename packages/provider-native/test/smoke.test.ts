import { packageName } from '../src/index.js';

test('provider-native package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/provider-native');
});
