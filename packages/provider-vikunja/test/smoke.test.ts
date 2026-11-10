import { packageName } from '../src/index.js';

test('provider-vikunja package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/provider-vikunja');
});
