import { packageName } from '../src/index.js';

test('domain package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/domain');
});
