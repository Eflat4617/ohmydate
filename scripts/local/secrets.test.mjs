import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createContext, parseEnvText, repoRoot } from './common.mjs';
import { initSecrets } from './secrets.mjs';

const tempDirs = [];

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-secrets-'));
  tempDirs.push(dir);
  return dir;
}

function contextFor(dir) {
  return createContext({ ...process.env, OHMYDATE_LOCAL_SECRETS_DIR: dir });
}

function modeOf(path) {
  return stat(path).then((info) => info.mode & 0o777);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('secrets init', () => {
  test('creates a 0700 dir and 0600 secret files with independent random values', async () => {
    const dir = await tempDir();
    const result = await initSecrets({ context: contextFor(dir) });

    expect((await modeOf(dir))).toBe(0o700);
    expect(result.created.sort()).toEqual([
      'llm-session-secret',
      'postgres.env',
      'push.key',
      'vikunja.env',
    ]);

    for (const name of ['postgres.env', 'vikunja.env', 'push.key', 'llm-session-secret']) {
      expect(await modeOf(join(dir, name))).toBe(0o600);
    }

    const postgres = parseEnvText(await readFile(join(dir, 'postgres.env'), 'utf8'));
    const vikunja = parseEnvText(await readFile(join(dir, 'vikunja.env'), 'utf8'));
    expect(postgres.POSTGRES_PASSWORD.length).toBeGreaterThanOrEqual(32);
    expect(postgres.POSTGRES_PASSWORD).toBe(vikunja.VIKUNJA_DATABASE_PASSWORD);
    expect(vikunja.VIKUNJA_SERVICE_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(vikunja.VIKUNJA_SERVICE_SECRET).not.toBe(postgres.POSTGRES_PASSWORD);

    const pushKey = (await readFile(join(dir, 'push.key'), 'utf8')).trim();
    const sessionSecret = (await readFile(join(dir, 'llm-session-secret'), 'utf8')).trim();
    expect(pushKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(sessionSecret).toMatch(/^[0-9a-f]{64}$/u);
    expect(pushKey).not.toBe(sessionSecret);
  });

  test('never overwrites an existing file and is idempotent', async () => {
    const dir = await tempDir();
    const stackPath = join(dir, 'postgres.env');
    await writeFile(stackPath, 'MARKER=keep\n', { mode: 0o600 });

    const first = await initSecrets({ context: contextFor(dir) });
    expect(first.existing).toContain('postgres.env');
    expect(await readFile(stackPath, 'utf8')).toBe('MARKER=keep\n');

    const before = {
      stack: await readFile(stackPath, 'utf8'),
      push: await readFile(join(dir, 'push.key'), 'utf8'),
      session: await readFile(join(dir, 'llm-session-secret'), 'utf8'),
    };
    const second = await initSecrets({ context: contextFor(dir) });
    expect(second.created).toEqual([]);
    expect(await readFile(join(dir, 'push.key'), 'utf8')).toBe(before.push);
    expect(await readFile(join(dir, 'llm-session-secret'), 'utf8')).toBe(before.session);
  });

  test('CLI output never contains a generated secret value', async () => {
    const dir = await tempDir();
    const env = {
      ...process.env,
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
    };
    const script = join(repoRoot, 'scripts/local/secrets.mjs');
    const first = spawnSync(process.execPath, [script, 'init'], { env, encoding: 'utf8' });
    expect(first.status).toBe(0);

    const values = [
      parseEnvText(await readFile(join(dir, 'postgres.env'), 'utf8')).POSTGRES_PASSWORD,
      parseEnvText(await readFile(join(dir, 'vikunja.env'), 'utf8')).VIKUNJA_SERVICE_SECRET,
      (await readFile(join(dir, 'push.key'), 'utf8')).trim(),
      (await readFile(join(dir, 'llm-session-secret'), 'utf8')).trim(),
    ];
    const output = `${first.stdout}${first.stderr}`;
    for (const value of values) {
      expect(value.length).toBeGreaterThan(0);
      expect(output).not.toContain(value);
    }

    const stackBefore = await readFile(join(dir, 'postgres.env'), 'utf8');
    const second = spawnSync(process.execPath, [script, 'init'], { env, encoding: 'utf8' });
    expect(second.status).toBe(0);
    expect(await readFile(join(dir, 'postgres.env'), 'utf8')).toBe(stackBefore);
    for (const value of values) {
      expect(`${second.stdout}${second.stderr}`).not.toContain(value);
    }
  });
});
