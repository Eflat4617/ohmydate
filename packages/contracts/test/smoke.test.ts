import { packageName } from '../src/index.js';

test('contracts package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/contracts');
});
