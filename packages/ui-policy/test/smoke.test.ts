import { packageName } from '../src/index.js';

test('ui-policy package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/ui-policy');
});
