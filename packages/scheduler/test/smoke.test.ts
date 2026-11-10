import { packageName } from '../src/index.js';

test('scheduler package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/scheduler');
});
