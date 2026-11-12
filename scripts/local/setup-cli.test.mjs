import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { repoRoot } from './common.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-setup-'));
  tempDirs.push(dir);
  return dir;
}

function runSetup(dir, extra = {}) {
  return spawnSync(process.execPath, [join(repoRoot, 'scripts/local/setup.mjs')], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
      OHMYDATE_LOCAL_HEALTH_TIMEOUT_MS: '300',
      OHMYDATE_LOCAL_EMAIL: 'local-test@example.invalid',
      OHMYDATE_LOCAL_PASSWORD: 'local-test-password',
      DATABASE_URL: 'postgres://ohmydate:wrong@127.0.0.1:1/planner',
      VIKUNJA_URL: 'http://127.0.0.1:1',
      ...extra,
    },
  });
}

describe('setup CLI negatives', () => {
  test('stack down gives a clear Korean error, the compose command and non-zero exit', async () => {
    const dir = await tempDir();
    const result = runSetup(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('먼저 coordinator가 deploy/local 스택을 올려야 합니다');
    expect(result.stderr).toContain(
      'docker compose --env-file deploy/local/local.env -f deploy/local/compose.yaml up -d',
    );
    // Secrets init still ran first and is safe to repeat.
    expect((await readdir(dir)).sort()).toEqual(
      ['llm-session-secret', 'push.key', 'stack.env'].sort(),
    );
  });

  test('short password is refused before the stack check', async () => {
    const dir = await tempDir();
    const result = runSetup(dir, { OHMYDATE_LOCAL_PASSWORD: 'short' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('8자 이상');
    expect(result.stderr).not.toContain('short');
  });
});
