import { packageName } from '../src/index.js';

test('web package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/web');
});
