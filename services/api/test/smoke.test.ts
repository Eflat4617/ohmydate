import { packageName } from '../src/index.js';

test('api service exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/api');
});
