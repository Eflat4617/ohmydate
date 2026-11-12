import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  childProcessEnv,
  createContext,
  databaseUrl,
  describeDatabaseUrl,
  parseEnvText,
  parseFlags,
  readEnvFile,
  repoRoot,
  STACK_DOWN_MESSAGE,
} from './common.mjs';
import { isValidTimeZone } from './prompt.mjs';

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
      OHMYDATE_LOCAL_VIKUNJA_URL: 'http://127.0.0.1:9999',
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

  test('ambient DATABASE_URL / VIKUNJA_URL never redirect the local target', async () => {
    const dir = await tempDir();
    const context = createContext({
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
      DATABASE_URL: 'postgres://ohmydate:secret@127.0.0.1:55432/planner_test',
      VIKUNJA_URL: 'http://127.0.0.1:3456',
    });
    expect(context.vikunjaUrl).toBe('http://127.0.0.1:3466');
    expect(context.databaseUrlOverride).toBeNull();

    await writeFile(join(dir, 'postgres.env'), 'POSTGRES_PASSWORD=p%40ss word\n', {
      mode: 0o600,
    });
    const built = databaseUrl(context, {
      DATABASE_URL: 'postgres://ohmydate:secret@127.0.0.1:55432/planner_test',
    });
    expect(built).toContain('ohmydate:');
    expect(built).toContain('@127.0.0.1:55442/planner');
    expect(built).toContain('p%40ss%20word');
    expect(built).not.toContain('planner_test');

    const dedicated = createContext({
      OHMYDATE_LOCAL_SECRETS_DIR: dir,
      OHMYDATE_LOCAL_DATABASE_URL: 'postgres://override/db',
      OHMYDATE_LOCAL_VIKUNJA_URL: 'http://127.0.0.1:9999',
    });
    expect(databaseUrl(dedicated, {})).toBe('postgres://override/db');
    expect(dedicated.vikunjaUrl).toBe('http://127.0.0.1:9999');
  });

  test('describeDatabaseUrl prints host:port/db without the password', () => {
    expect(
      describeDatabaseUrl('postgres://ohmydate:hunter2@127.0.0.1:55442/planner?x=1'),
    ).toBe('127.0.0.1:55442/planner');
    expect(describeDatabaseUrl('not a url')).toBe('알 수 없는 대상');
  });

  test('childProcessEnv allows only the documented allowlist', () => {
    const env = childProcessEnv({
      PATH: '/bin',
      HOME: '/home/user',
      DATABASE_URL: 'postgres://secret',
      UNRELATED_TOKEN: 'secret',
      npm_execpath: '/pnpm.js',
    });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/user', npm_execpath: '/pnpm.js' });
  });

  test('stack-down message names the exact local:stack command', () => {
    expect(STACK_DOWN_MESSAGE).toContain('먼저 coordinator가 deploy/local 스택을 올려야 합니다');
    expect(STACK_DOWN_MESSAGE).toContain('corepack pnpm local:stack up');
  });

  test('zone validation uses the domain IANA set, not Intl leniency', () => {
    for (const zone of ['Asia/Seoul', 'America/New_York', 'UTC', 'Etc/UTC']) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
    for (const zone of ['asia/seoul', '+09:00', 'EST', '', 'Mars/Olympus']) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });

  test('local.env documents the split postgres.env / vikunja.env secret files', async () => {
    const text = await readFile(join(repoRoot, 'deploy/local/local.env'), 'utf8');
    expect(text).toContain('postgres.env');
    expect(text).toContain('vikunja.env');
    expect(text).not.toContain('stack.env');
  });
});
