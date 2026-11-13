import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext, repoRoot } from './common.mjs';
import { googleTunables, inspectGoogleSetup } from './google.mjs';
import { googleEnvironment, runPreflight } from './start.mjs';

const SECRET = 'GOCSPX-never-print-me';
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function secretsDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-google-'));
  tempDirs.push(dir);
  return dir;
}

async function write(path, content, mode = 0o600) {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

function clientJson() {
  return JSON.stringify({
    web: { client_id: '1-abc.apps.googleusercontent.com', client_secret: SECRET, redirect_uris: [] },
  });
}

function contextFor(dir, extra = {}) {
  return createContext({
    ...process.env,
    OHMYDATE_LOCAL_SECRETS_DIR: dir,
    OHMYDATE_LOCAL_WEB_PORT: '5180',
    OHMYDATE_LOCAL_DATABASE_URL: 'postgres://test/test',
    GOOGLE_OAUTH_CLIENT_FILE: undefined,
    ...extra,
  });
}

describe('Google setup inspection (CAL-03)', () => {
  test('no client file at the default place is a normal not-configured state', async () => {
    const dir = await secretsDir();
    const result = inspectGoogleSetup(contextFor(dir));
    expect(result.state).toBe('not_configured');
    expect(result.line).toContain('설정 안 됨');
    expect(result.line).toContain(join(dir, 'google-oauth-client.json'));
    expect(result.env).toBeUndefined();
  });

  test('a group/world-readable client file is refused with the exact chmod command, never its contents', async () => {
    const dir = await secretsDir();
    await write(join(dir, 'google-oauth-client.json'), clientJson(), 0o644);
    await write(join(dir, 'google-token.key'), 'a'.repeat(64));
    const result = inspectGoogleSetup(contextFor(dir));
    expect(result.state).toBe('invalid');
    expect(result.line).toContain(`chmod 600 ${join(dir, 'google-oauth-client.json')}`);
    expect(result.line).not.toContain(SECRET);
  });

  test('a malformed client file or a missing / open token key is refused with the fix', async () => {
    const dir = await secretsDir();
    const client = join(dir, 'google-oauth-client.json');
    await write(client, `{"web":{"client_secret":"${SECRET}"`);
    const malformed = inspectGoogleSetup(contextFor(dir));
    expect(malformed.state).toBe('invalid');
    expect(malformed.line).toContain('형식이 올바르지 않습니다');
    expect(malformed.line).not.toContain(SECRET);

    await write(client, clientJson());
    const noKey = inspectGoogleSetup(contextFor(dir));
    expect(noKey.state).toBe('invalid');
    expect(noKey.line).toContain('corepack pnpm local:secrets');

    await write(join(dir, 'google-token.key'), 'a'.repeat(64), 0o640);
    const openKey = inspectGoogleSetup(contextFor(dir));
    expect(openKey.state).toBe('invalid');
    expect(openKey.line).toContain(`chmod 600 ${join(dir, 'google-token.key')}`);
  });

  test('a valid setup yields the API env: file paths and the web-origin redirect URI only', async () => {
    const dir = await secretsDir();
    await write(join(dir, 'google-oauth-client.json'), clientJson());
    await write(join(dir, 'google-token.key'), 'b'.repeat(64));
    const context = contextFor(dir);
    const result = inspectGoogleSetup(context);
    expect(result.state).toBe('configured');
    expect(result.env).toEqual({
      GOOGLE_OAUTH_CLIENT_FILE: join(dir, 'google-oauth-client.json'),
      GOOGLE_TOKEN_KEY_FILE: join(dir, 'google-token.key'),
      GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:5180/api/v1/integrations/google/callback',
      GOOGLE_WEB_ORIGIN: 'http://127.0.0.1:5180',
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(googleEnvironment(context, { google: result }, { GOOGLE_SYNC_INTERVAL_MS: '0' })).toMatchObject({
      GOOGLE_OAUTH_REDIRECT_URI: 'http://127.0.0.1:5180/api/v1/integrations/google/callback',
      GOOGLE_SYNC_INTERVAL_MS: '0',
    });
    expect(googleEnvironment(context, { google: { state: 'not_configured' } })).toEqual({});
  });

  test('GOOGLE_OAUTH_CLIENT_FILE overrides the default place', async () => {
    const dir = await secretsDir();
    const elsewhere = join(dir, 'elsewhere.json');
    await write(elsewhere, clientJson());
    await write(join(dir, 'google-token.key'), 'c'.repeat(64));
    const result = inspectGoogleSetup(contextFor(dir, { GOOGLE_OAUTH_CLIENT_FILE: elsewhere }));
    expect(result.state).toBe('configured');
    expect(result.env.GOOGLE_OAUTH_CLIENT_FILE).toBe(elsewhere);
    expect(googleTunables({}, { GOOGLE_EXPORT_DAYS: '30', GOOGLE_IMPORT_DAYS: ' ' })).toEqual({
      GOOGLE_EXPORT_DAYS: '30',
    });
  });

  test('start preflight refuses an unusable Google setup before probing the stack', async () => {
    const dir = await secretsDir();
    for (const name of ['postgres.env', 'vikunja.env', 'push.key', 'llm-session-secret', 'vikunja-tokens.json']) {
      await write(join(dir, name), 'test-only\n');
    }
    await write(join(dir, 'google-oauth-client.json'), clientJson(), 0o644);
    let probed = false;
    const result = await runPreflight({
      context: contextFor(dir),
      env: {},
      fakeLlm: true,
      deps: {
        checkStack: async () => {
          probed = true;
          return { ok: true, database: true, vikunja: true };
        },
        checkMigrationsCurrent: async () => ({ current: true }),
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('chmod 600');
    expect(result.message).not.toContain(SECRET);
    expect(probed).toBe(false);
  });

  test('local:status prints one Google line and never the client secret', async () => {
    const dir = await secretsDir();
    await write(join(dir, 'google-oauth-client.json'), clientJson());
    await write(join(dir, 'google-token.key'), 'd'.repeat(64));
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts/local/status.mjs')], {
      env: {
        ...process.env,
        OHMYDATE_LOCAL_SECRETS_DIR: dir,
        OHMYDATE_LOCAL_DATABASE_URL: 'postgres://nobody:pw@127.0.0.1:1/never',
        OHMYDATE_LOCAL_VIKUNJA_URL: 'http://127.0.0.1:1',
        OHMYDATE_LOCAL_API_PORT: '1',
        OHMYDATE_LOCAL_WEB_PORT: '2',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const output = `${result.stdout}${result.stderr}`;
    const lines = output.split('\n').filter((line) => line.includes('Google 캘린더 동기화'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('설정됨');
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('d'.repeat(64));
  }, 90_000);
});
