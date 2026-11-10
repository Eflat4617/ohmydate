import { packageName } from '../src/index.js';

test('testkit package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/testkit');
});
