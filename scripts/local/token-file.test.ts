import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadVikunjaClients } from '../../services/api/src/adapters/vikunja/owner-accounts.ts';
import { writeTokenFile } from './vikunja-token.mjs';

const OWNER_ID = '018f1f7e-0000-7000-8000-000000000001';
const TOKEN = 'tk_local_test_token_value';
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-token-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

function fakeDb(rows: readonly { owner_id: string; vikunja_user_id: number; token_secret_ref: string }[]) {
  return {
    selectFrom: () => ({
      select: () => ({
        orderBy: () => ({
          execute: async () => rows,
        }),
      }),
    }),
  };
}

describe('local token file', () => {
  test('round-trips through the API token-file parser', async () => {
    const dir = await tempDir();
    const tokenPath = join(dir, 'vikunja-tokens.json');
    await writeTokenFile(tokenPath, { [OWNER_ID]: TOKEN });

    const clients = await loadVikunjaClients({
      db: fakeDb([
        { owner_id: OWNER_ID, vikunja_user_id: 7, token_secret_ref: 'default' },
      ]) as never,
      config: {
        vikunjaUrl: 'http://127.0.0.1:3466',
        vikunjaTokenFile: tokenPath,
        vikunjaSecretsDir: dir,
      } as never,
    });

    expect(clients.size).toBe(1);
    expect(clients.get(OWNER_ID as never)).toBeDefined();
  });

  test('writes mode 0600', async () => {
    const dir = await tempDir();
    const tokenPath = join(dir, 'vikunja-tokens.json');
    await writeTokenFile(tokenPath, { [OWNER_ID]: TOKEN });
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  test('rejects a file without the owner entry (API parser negative)', async () => {
    const dir = await tempDir();
    const tokenPath = join(dir, 'vikunja-tokens.json');
    await writeTokenFile(tokenPath, { 'someone-else': TOKEN });

    await expect(
      loadVikunjaClients({
        db: fakeDb([
          { owner_id: OWNER_ID, vikunja_user_id: 7, token_secret_ref: 'default' },
        ]) as never,
        config: {
          vikunjaUrl: 'http://127.0.0.1:3466',
          vikunjaTokenFile: tokenPath,
          vikunjaSecretsDir: dir,
        } as never,
      }),
    ).rejects.toThrow(/has no token for owner/u);
  });
});
