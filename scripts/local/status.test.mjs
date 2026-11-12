import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext } from './common.mjs';
import { describeKeyFile, shouldWarnSecretsLost } from './status.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-status-'));
  tempDirs.push(dir);
  return dir;
}

async function writeSecret(dir, name) {
  await writeFile(join(dir, name), 'test-only\n', { mode: 0o600 });
}

function contextFor(dir) {
  return createContext({
    ...process.env,
    OHMYDATE_LOCAL_SECRETS_DIR: dir,
    OHMYDATE_LOCAL_STACK_STATE_FILE: join(dir, 'stack.state.json'),
    OHMYDATE_LOCAL_DATABASE_URL: 'postgres://test/test',
  });
}

describe('status warnings', () => {
  test('a missing token file in the normal first-run order does not warn', async () => {
    const dir = await tempDir();
    for (const name of [
      'postgres.env',
      'vikunja.env',
      'push.key',
      'llm-session-secret',
      'stack.state.json',
    ]) {
      await writeSecret(dir, name);
    }
    expect(shouldWarnSecretsLost(contextFor(dir))).toBe(false);
  });

  test('a missing postgres.env with an existing stack warns (DB locked out)', async () => {
    const dir = await tempDir();
    for (const name of ['vikunja.env', 'push.key', 'llm-session-secret', 'stack.state.json']) {
      await writeSecret(dir, name);
    }
    expect(shouldWarnSecretsLost(contextFor(dir))).toBe(true);
  });

  test('a legacy stack.env keeps the database reachable without a warning', async () => {
    const dir = await tempDir();
    for (const name of ['stack.env', 'vikunja.env', 'push.key', 'stack.state.json']) {
      await writeSecret(dir, name);
    }
    expect(shouldWarnSecretsLost(contextFor(dir))).toBe(false);
  });

  test('a stack state file without any secrets files counts as DB locked out', async () => {
    const dir = await tempDir();
    await writeSecret(dir, 'stack.state.json');
    expect(shouldWarnSecretsLost(contextFor(dir))).toBe(true);
  });
});

describe('status LLM key mode', () => {
  test('a wide-mode key is a failure and names the exact chmod command', () => {
    const wide = describeKeyFile('/keys/deepseek_api_key.txt', 0o644);
    expect(wide.failure).toBe(true);
    expect(wide.text).toContain('start가 거부합니다');
    expect(wide.text).toContain('chmod 600 /keys/deepseek_api_key.txt');
  });

  test('0600 is healthy and an unknown mode is not a failure', () => {
    expect(describeKeyFile('/keys/k', 0o600)).toEqual({
      failure: false,
      text: '있음 (mode 600)',
    });
    expect(describeKeyFile('/keys/k', null)).toEqual({
      failure: false,
      text: '있음 (권한 확인 불가)',
    });
  });
});
