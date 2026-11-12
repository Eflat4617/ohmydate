import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createContext } from './common.mjs';
import { checkLlmKeyFile, runPreflight } from './start.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

async function contextWithSecrets() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-preflight-'));
  tempDirs.push(dir);
  for (const name of [
    'postgres.env',
    'vikunja.env',
    'push.key',
    'llm-session-secret',
    'vikunja-tokens.json',
  ]) {
    await writeFile(join(dir, name), 'test-only\n', { mode: 0o600 });
  }
  return createContext({
    ...process.env,
    OHMYDATE_LOCAL_SECRETS_DIR: dir,
    OHMYDATE_LOCAL_DATABASE_URL: 'postgres://test/test',
  });
}

describe('start preflight', () => {
  test('checks the LLM key file with access/stat only, never reads it', () => {
    const calls = [];
    const result = checkLlmKeyFile('/key/does/not/matter', {
      access: (path) => calls.push(['access', path]),
      stat: (path) => {
        calls.push(['stat', path]);
        return { mode: 0o100600 };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeNull();
    expect(calls).toEqual([
      ['access', '/key/does/not/matter'],
      ['stat', '/key/does/not/matter'],
    ]);
  });

  test('refuses a group/world-readable key file with the exact chmod command', () => {
    const result = checkLlmKeyFile('/key', {
      access: () => undefined,
      stat: () => ({ mode: 0o100644 }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('chmod 600 /key');
    expect(result.message).toContain('LLM API 키 파일 권한이 644');
  });

  test('missing key file is a Korean refusal', () => {
    const result = checkLlmKeyFile('/missing/key', {
      access: () => {
        throw new Error('ENOENT');
      },
      stat: () => ({ mode: 0o100600 }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('LLM API 키 파일이 없습니다');
  });

  test('refuses when the stack is down with the coordinator message', async () => {
    const context = await contextWithSecrets();
    const result = await runPreflight({
      context,
      env: {},
      deps: {
        checkStack: async () => ({ database: false, vikunja: false, ok: false }),
        checkMigrationsCurrent: async () => ({ current: true }),
        checkLlmKeyFile: () => ({ ok: true, warning: null }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('먼저 coordinator가 deploy/local 스택을 올려야 합니다');
    expect(result.message).toContain('local:stack up');
  });

  test('refuses stale migrations, and refuses a missing key unless --fake-llm', async () => {
    const context = await contextWithSecrets();
    const deps = {
      checkStack: async () => ({ database: true, vikunja: true, ok: true }),
      checkMigrationsCurrent: async () => ({ current: false, detail: 'pending=0015' }),
      checkLlmKeyFile: () => ({ ok: true, warning: null }),
    };
    const env = {};

    const stale = await runPreflight({ context, env, deps });
    expect(stale.ok).toBe(false);
    expect(stale.message).toContain('마이그레이션이 최신이 아닙니다');

    const currentDeps = {
      ...deps,
      checkMigrationsCurrent: async () => ({ current: true }),
      checkLlmKeyFile: () => ({
        ok: false,
        message: 'LLM API 키 파일이 없습니다: /repo/deepseek_api_key.txt',
      }),
    };
    const missingKey = await runPreflight({ context, env, deps: currentDeps });
    expect(missingKey.ok).toBe(false);
    expect(missingKey.message).toContain('LLM API 키 파일이 없습니다');

    const fake = await runPreflight({ context, env, deps: currentDeps, fakeLlm: true });
    expect(fake.ok).toBe(true);
  });

  test('reports missing secret files before touching the stack', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-preflight-empty-'));
    tempDirs.push(dir);
    const context = createContext({
      ...process.env,
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
      OHMYDATE_LOCAL_DATABASE_URL: 'postgres://test/test',
    });
    const result = await runPreflight({ context, env: {} });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('로컬 비밀 파일이 없습니다');
    expect(result.message).toContain('corepack pnpm local:setup');
  });
});
