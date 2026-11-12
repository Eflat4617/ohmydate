import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { expect, test } from 'vitest';
import { repoRoot, requirePg } from './common.mjs';
import { databaseCounts } from './stack.mjs';

const enabled =
  process.env.OHMYDATE_LOCAL_SMOKE === '1' &&
  (process.env.DATABASE_URL ?? '').length > 0 &&
  (process.env.VIKUNJA_URL ?? '').length > 0;

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function runScript(script, env, args = []) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts/local', script), ...args], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

function quoteIdentifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) throw new Error(`invalid schema: ${value}`);
  return `"${value}"`;
}

function scopedUrl(base, schema) {
  const url = new URL(base);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  return url.toString();
}

test.skipIf(!enabled)(
  'setup -> start -> login via web proxy -> status -> stop -> idempotent setup',
  async () => {
    const baseDatabaseUrl = process.env.DATABASE_URL;
    const vikunjaUrl = process.env.VIKUNJA_URL;
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
    const schema = `local_smoke_${suffix.replace(/-/gu, '_')}`;
    const email = `local-smoke-${suffix}@example.invalid`;
    const password = `smoke-password-${suffix}`;
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-local-smoke-'));
    const secretsDir = join(root, 'secrets');
    const runDir = join(root, 'run');
    const logDir = join(root, 'logs');
    const keyFile = join(root, 'deepseek_api_key.txt');
    const apiPort = await freePort();
    const webPort = await freePort();
    const databaseUrl = scopedUrl(baseDatabaseUrl, schema);

    const { Client } = requirePg();
    const admin = new Client({ connectionString: baseDatabaseUrl });
    await admin.connect();
    let serversStarted = false;

    const env = {
      ...process.env,
      OHMYDATE_LOCAL_DATABASE_URL: databaseUrl,
      OHMYDATE_LOCAL_VIKUNJA_URL: vikunjaUrl,
      OHMYDATE_LOCAL_SECRETS_DIR: secretsDir,
      OHMYDATE_LOCAL_RUN_DIR: runDir,
      OHMYDATE_LOCAL_LOG_DIR: logDir,
      OHMYDATE_LOCAL_API_PORT: String(apiPort),
      OHMYDATE_LOCAL_WEB_PORT: String(webPort),
      OHMYDATE_LOCAL_EMAIL: email,
      OHMYDATE_LOCAL_PASSWORD: password,
      OHMYDATE_LOCAL_HEALTH_TIMEOUT_MS: '60000',
      LLM_API_KEY_FILE: keyFile,
    };

    try {
      await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      await writeFile(keyFile, `${'0f'.repeat(32)}\n`, { mode: 0o600 });

      const setup = await runScript('setup.mjs', env);
      expect(setup.code, setup.stderr).toBe(0);
      expect(setup.stdout).toContain('대상: PostgreSQL');
      expect(setup.stdout).not.toContain('test-password');

      const start = await runScript('start.mjs', env, ['--fake-llm']);
      expect(start.code, start.stderr).toBe(0);
      serversStarted = true;

      const login = await globalThis.fetch(
        `http://127.0.0.1:${String(webPort)}/api/v1/auth/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password }),
        },
      );
      expect(login.status).toBe(204);

      const status = await runScript('status.mjs', env);
      expect(status.code, status.stderr).toBe(0);
      expect(status.stdout).toContain('로컬 상태 요약');
      expect(status.stdout).toContain('대상: PostgreSQL');
      expect(status.stdout).toContain('모든 항목이 정상입니다.');

      const tokenBefore = await readFile(join(secretsDir, 'vikunja-tokens.json'), 'utf8');

      const stop = await runScript('stop.mjs', env);
      expect(stop.code, stop.stderr).toBe(0);
      serversStarted = false;
      const runFiles = await readdir(runDir).catch(() => []);
      expect(runFiles.filter((name) => name.endsWith('.pid'))).toEqual([]);

      const secondSetup = await runScript('setup.mjs', env);
      expect(secondSetup.code, secondSetup.stderr).toBe(0);
      const tokenAfter = await readFile(join(secretsDir, 'vikunja-tokens.json'), 'utf8');
      expect(tokenAfter).toBe(tokenBefore);

      const rotate = await runScript('setup.mjs', env, ['--rotate-token']);
      expect(rotate.code, rotate.stderr).toBe(0);
      expect(rotate.stdout).toContain('local:stop 후 local:start 로 재시작하세요');
      const tokenRotated = await readFile(join(secretsDir, 'vikunja-tokens.json'), 'utf8');
      expect(tokenRotated).not.toBe(tokenBefore);

      const oldToken = Object.values(JSON.parse(tokenBefore))[0];
      const newToken = Object.values(JSON.parse(tokenRotated))[0];
      expect(typeof oldToken).toBe('string');
      expect(typeof newToken).toBe('string');
      expect(newToken).not.toBe(oldToken);
      const oldStatus = await globalThis.fetch(
        `${vikunjaUrl.replace(/\/+$/u, '')}/api/v2/user`,
        { headers: { authorization: `Bearer ${oldToken}` } },
      );
      const newStatus = await globalThis.fetch(
        `${vikunjaUrl.replace(/\/+$/u, '')}/api/v2/user`,
        { headers: { authorization: `Bearer ${newToken}` } },
      );
      expect(oldStatus.status).toBe(401);
      expect(newStatus.status).toBe(200);

      const counts = await databaseCounts(databaseUrl, email);
      expect(counts).toEqual({ users: 1, owners: 1 });
    } finally {
      if (serversStarted) await runScript('stop.mjs', env).catch(() => undefined);
      await admin.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`).catch(
        () => undefined,
      );
      await admin.end().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  900_000,
);

// Keep the file discoverable even when the dev infra env is absent.
test.skipIf(enabled)('local smoke is skipped without DATABASE_URL/VIKUNJA_URL', () => {
  expect(fileURLToPath(import.meta.url)).toContain('smoke.test.mjs');
});
