import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { repoRoot } from './common.mjs';
import { readOptionalJson } from './setup.mjs';

const MARKER = 'tk_MARKER_SHOULD_NEVER_PRINT_000001';
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-safety-'));
  tempDirs.push(dir);
  return dir;
}

async function secretsDir() {
  const dir = await tempDir();
  await writeFile(join(dir, 'postgres.env'), 'POSTGRES_PASSWORD=test-password\n', {
    mode: 0o600,
  });
  await writeFile(
    join(dir, 'vikunja.env'),
    'VIKUNJA_DATABASE_PASSWORD=test-password\nVIKUNJA_SERVICE_SECRET=test-secret\n',
    { mode: 0o600 },
  );
  await writeFile(join(dir, 'push.key'), 'test-push\n', { mode: 0o600 });
  await writeFile(join(dir, 'llm-session-secret'), 'test-session\n', { mode: 0o600 });
  return dir;
}

function baseEnv(dir, extra = {}) {
  return {
    ...process.env,
    OHMYDATE_LOCAL_SECRETS_DIR: dir,
    OHMYDATE_LOCAL_RUN_DIR: join(dir, 'run'),
    OHMYDATE_LOCAL_LOG_DIR: join(dir, 'logs'),
    OHMYDATE_LOCAL_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/planner',
    OHMYDATE_LOCAL_VIKUNJA_URL: 'http://127.0.0.1:1',
    ...extra,
  };
}

describe('status never echoes file content', () => {
  test('a malformed token file reports a fixed message without the marker', async () => {
    const dir = await secretsDir();
    await writeFile(join(dir, 'vikunja-tokens.json'), `{"owner": ${MARKER}` , { mode: 0o600 });

    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/local/status.mjs')], {
      cwd: repoRoot,
      env: baseEnv(dir),
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    expect(`${result.stdout}${result.stderr}`).toContain('형식 오류');
  });

  test('setup token/meta reader throws a fixed message without the marker', async () => {
    const dir = await tempDir();
    const tokenFile = join(dir, 'vikunja-tokens.json');
    await writeFile(tokenFile, `{"owner": ${MARKER}`, { mode: 0o600 });
    const error = await readOptionalJson(tokenFile).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(MARKER);
    expect(error.message).toContain('형식이 올바르지 않습니다');
  });
});

describe('status warns when secrets are gone but the stack volumes exist', () => {
  test('missing secrets plus a stack-state marker prints the backup warning', async () => {
    const dir = await tempDir();
    const stateFile = join(dir, 'stack.state.json');
    await writeFile(stateFile, '{}\n', { mode: 0o600 });

    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/local/status.mjs')], {
      cwd: repoRoot,
      env: baseEnv(dir, { OHMYDATE_LOCAL_STACK_STATE_FILE: stateFile }),
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.stderr).toContain('비밀 디렉터리가 없지만 ohmydate-local 스택/볼륨이 존재합니다');
    expect(result.stderr).toContain('함께 백업');
    expect(result.stdout).toContain('비밀 파일: 누락');
  });
});

describe('start refuses a wide-mode key before the health wait', () => {
  test('production mode with a 0644 fake key exits fast with chmod 600 <path>', async () => {
    const dir = await secretsDir();
    await writeFile(join(dir, 'vikunja-tokens.json'), '{}\n', { mode: 0o600 });
    const keyFile = join(dir, 'deepseek_api_key.txt');
    await writeFile(keyFile, 'fake-key-material\n', { mode: 0o644 });

    const started = Date.now();
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/local/start.mjs')], {
      cwd: repoRoot,
      env: baseEnv(dir, { LLM_API_KEY_FILE: keyFile }),
      encoding: 'utf8',
      timeout: 30_000,
    });
    const elapsed = Date.now() - started;

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`chmod 600 ${keyFile}`);
    expect(result.stderr).not.toContain('시간 초과');
    expect(elapsed).toBeLessThan(10_000);
    expect(await readdir(join(dir, 'run')).catch(() => [])).toEqual([]);
  });
});
