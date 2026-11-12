import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createContext,
  databaseUrl,
  parseEnvText,
  parseFlags,
  readEnvFile,
  STACK_DOWN_MESSAGE,
} from './common.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-args-'));
  tempDirs.push(dir);
  return dir;
}

describe('env and argv parsing', () => {
  test('parses KEY=VALUE with comments, whitespace and quotes', () => {
    const parsed = parseEnvText(
      ['# comment', 'A=1', ' B = two ', 'C="three"', "D='four'", 'EMPTY=', 'noequals'].join(
        '\n',
      ),
    );
    expect(parsed).toEqual({ A: '1', B: 'two', C: 'three', D: 'four', EMPTY: '' });
  });

  test('missing env file is an empty object', () => {
    expect(readEnvFile('/definitely/not/here.local.env')).toEqual({});
  });

  test('parses flags with values and boolean flags', () => {
    const { flags, values, positionals } = parseFlags([
      '--rotate-token',
      '--email',
      'a@example.com',
      'extra',
      '--rebuild',
    ]);
    expect(flags.has('rotate-token')).toBe(true);
    expect(flags.has('rebuild')).toBe(true);
    expect(values.get('email')).toBe('a@example.com');
    expect(positionals).toEqual(['extra']);
  });

  test('default ports come from deploy/local/local.env and env overrides win', async () => {
    const defaults = createContext({});
    expect(defaults.ports).toEqual({ postgres: 55442, vikunja: 3466, api: 3100, web: 5180 });
    expect(defaults.vikunjaUrl).toBe('http://127.0.0.1:3466');

    const dir = await tempDir();
    const overridden = createContext({
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
      OHMYDATE_LOCAL_POSTGRES_PORT: '15542',
      OHMYDATE_LOCAL_VIKUNJA_PORT: '13466',
      OHMYDATE_LOCAL_API_PORT: '13100',
      OHMYDATE_LOCAL_WEB_PORT: '15180',
      VIKUNJA_URL: 'http://127.0.0.1:9999',
    });
    expect(overridden.ports).toEqual({
      postgres: 15542,
      vikunja: 13466,
      api: 13100,
      web: 15180,
    });
    expect(overridden.apiUrl).toBe('http://127.0.0.1:13100');
    expect(overridden.vikunjaUrl).toBe('http://127.0.0.1:9999');
  });

  test('databaseUrl prefers DATABASE_URL, otherwise builds from stack.env', async () => {
    const dir = await tempDir();
    const context = createContext({ OHMYDATE_LOCAL_SECRETS_DIR: dir });
    expect(databaseUrl(context, { DATABASE_URL: 'postgres://override/db' })).toBe(
      'postgres://override/db',
    );

    await writeFile(
      join(dir, 'stack.env'),
      'POSTGRES_PASSWORD=p%40ss word\n',
      { mode: 0o600 },
    );
    const built = databaseUrl(context, {});
    expect(built).toContain('ohmydate:');
    expect(built).toContain('@127.0.0.1:55442/planner');
    expect(built).toContain('p%40ss%20word');
  });

  test('stack-down message names the exact compose command', () => {
    expect(STACK_DOWN_MESSAGE).toContain('먼저 coordinator가 deploy/local 스택을 올려야 합니다');
    expect(STACK_DOWN_MESSAGE).toContain(
      'docker compose --env-file deploy/local/local.env -f deploy/local/compose.yaml up -d',
    );
  });
});
