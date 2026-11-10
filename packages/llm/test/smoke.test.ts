import { packageName } from '../src/index.js';

test('llm package exposes its workspace name', () => {
  expect(packageName).toBe('@ohmydate/llm');
});
