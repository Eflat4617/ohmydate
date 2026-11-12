import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { repoRoot } from './common.mjs';
import { composeInvocation, parseComposeArgv } from './compose.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-compose-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * A PATH that contains only a `sudo` shim. If compose.mjs tries to run docker
 * the shim records it; dry-run/rejected calls must leave the log absent.
 */
async function sudoShim() {
  const dir = await tempDir();
  const logFile = join(dir, 'sudo.log');
  const shim = join(dir, 'sudo');
  await writeFile(shim, '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$SUDO_LOG"\n', {
    mode: 0o755,
  });
  await chmod(shim, 0o755);
  return { dir, logFile };
}

function runCompose(args, shim) {
  return spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts/local/compose.mjs'), ...args],
    {
      cwd: '/',
      encoding: 'utf8',
      env: { PATH: shim.dir, SUDO_LOG: shim.logFile },
    },
  );
}

async function sudoLog(shim) {
  return readFile(shim.logFile, 'utf8').catch(() => '');
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

describe('local:stack wrapper', () => {
  test('up uses sudo, project, absolute env/compose paths and -d', () => {
    const invocation = composeInvocation('up');
    expect(invocation.command).toBe('sudo');
    expect(invocation.args.slice(0, 6)).toEqual([
      'docker',
      'compose',
      '-p',
      'ohmydate-local',
      '--env-file',
      valueAfter(invocation.args, '--env-file'),
    ]);
    const envFile = valueAfter(invocation.args, '--env-file');
    const composeFile = valueAfter(invocation.args, '-f');
    expect(envFile).toBe(join(repoRoot, 'deploy/local/local.env'));
    expect(composeFile).toBe(join(repoRoot, 'deploy/local/compose.yaml'));
    expect(isAbsolute(envFile)).toBe(true);
    expect(isAbsolute(composeFile)).toBe(true);
    expect(invocation.args).toContain('up');
    expect(invocation.args).toContain('-d');
  });

  test('down refuses every -v/--volumes spelling and unknown arguments', () => {
    for (const spelling of ['-v', '--volumes', '-v=true', '--volumes=true', '-vt']) {
      expect(() => composeInvocation('down', [spelling])).toThrow(/허용하지 않습니다|지원하지 않는/u);
    }
  });

  test('down allow-lists --remove-orphans and -t/--timeout', () => {
    const invocation = composeInvocation('down', [
      '--remove-orphans',
      '-t',
      '5',
      '--timeout=7',
    ]);
    expect(invocation.args).toContain('down');
    expect(invocation.args).toContain('--remove-orphans');
    expect(invocation.args).toContain('5');
    expect(invocation.args).toContain('--timeout=7');
  });

  test('logs is bounded and ps works', () => {
    const logs = composeInvocation('logs', ['-f']);
    expect(logs.args).toContain('--tail');
    expect(logs.args.slice(logs.args.indexOf('logs'))).not.toContain('-f');
    expect(composeInvocation('ps').args).toContain('ps');
    expect(() => composeInvocation('rm')).toThrow(/알 수 없는/u);
  });

  test('--dry-run/--help never consume the next token', () => {
    expect(parseComposeArgv(['up', '--dry-run', '-d'])).toEqual({
      flags: new Set(['dry-run']),
      positionals: ['up', '-d'],
      passthrough: [],
    });
    expect(parseComposeArgv(['up', '-d', '--dry-run']).flags.has('dry-run')).toBe(true);
    expect(parseComposeArgv(['--help', 'up']).flags.has('help')).toBe(true);
    expect(parseComposeArgv(['logs', '--', '--dry-run']).passthrough).toEqual(['--dry-run']);
  });

  test('args before and after --dry-run never run sudo/docker', async () => {
    const shim = await sudoShim();
    const variants = [
      ['up', '--dry-run', '-d'],
      ['up', '-d', '--dry-run'],
      ['down', '--dry-run'],
      ['down', '--remove-orphans', '--dry-run'],
      ['logs', '--dry-run', 'vikunja'],
      ['logs', 'vikunja', '--dry-run'],
      ['ps', '--dry-run'],
      ['ps', '--format', 'json', '--dry-run'],
    ];
    for (const args of variants) {
      const result = runCompose(args, shim);
      expect(result.status, `${args.join(' ')}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain('--dry-run: docker를 실행하지 않았습니다');
    }
    expect(await sudoLog(shim)).toBe('');
  });

  test('-- pass-through forwards arguments verbatim', async () => {
    const shim = await sudoShim();
    const logs = runCompose(['logs', '--dry-run', '--', 'vikunja'], shim);
    expect(logs.status).toBe(0);
    expect(logs.stdout).toContain('logs --tail 200 vikunja');

    const up = runCompose(['up', '--dry-run', '--', '--build'], shim);
    expect(up.status).toBe(0);
    expect(up.stdout).toContain('up -d --build');

    expect(await sudoLog(shim)).toBe('');
  });

  test('--help is safe and does not need docker', async () => {
    const shim = await sudoShim();
    const result = runCompose(['--help'], shim);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: node scripts/local/compose.mjs');
    expect(await sudoLog(shim)).toBe('');
  });

  test('rejected down arguments exit non-zero with a Korean message', async () => {
    const shim = await sudoShim();
    for (const args of [
      ['down', '-v', '--dry-run'],
      ['down', '-vt', '5', '--dry-run'],
      ['down', '-v=true', '--dry-run'],
      ['down', '--volumes', '--dry-run'],
      ['down', '--volumes=true', '--dry-run'],
    ]) {
      const result = runCompose(args, shim);
      expect(result.status, args.join(' ')).not.toBe(0);
      expect(result.stderr).toContain('허용하지 않습니다');
    }
    expect(await sudoLog(shim)).toBe('');
  });

  test('--dry-run prints the command without running docker', () => {
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, 'scripts/local/compose.mjs'), 'up', '--dry-run'],
      { cwd: '/', encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('sudo docker compose -p ohmydate-local');
    expect(result.stdout).toContain('--dry-run: docker를 실행하지 않았습니다');
    expect(result.stdout).toContain(join(repoRoot, 'deploy/local/local.env'));
    expect(result.stderr).toBe('');
  });
});
