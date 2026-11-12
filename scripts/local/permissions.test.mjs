import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoRoot } from './common.mjs';
import { VIKUNJA_TOKEN_PERMISSIONS } from './vikunja-token.mjs';

function e2ePermissions() {
  const source = readFileSync(join(repoRoot, 'e2e/global-setup.ts'), 'utf8');
  const match = /const VIKUNJA_TOKEN_PERMISSIONS = (\{[\s\S]*?\n\});/u.exec(source);
  if (match === null || match[1] === undefined) {
    throw new Error('e2e/global-setup.ts VIKUNJA_TOKEN_PERMISSIONS not found');
  }
  return new Function(`return (${match[1]})`)();
}

describe('Vikunja token permission parity', () => {
  test('local permissions exactly match e2e/global-setup.ts', () => {
    expect(VIKUNJA_TOKEN_PERMISSIONS).toEqual(e2ePermissions());
  });
});
