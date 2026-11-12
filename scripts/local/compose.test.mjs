import { spawnSync } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { repoRoot } from './common.mjs';
import { composeInvocation } from './compose.mjs';

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

  test('down never passes -v or --volumes', () => {
    const invocation = composeInvocation('down', ['-v', '--volumes']);
    expect(invocation.args).toContain('down');
    expect(invocation.args).not.toContain('-v');
    expect(invocation.args).not.toContain('--volumes');
  });

  test('logs is bounded and ps works', () => {
    const logs = composeInvocation('logs', ['-f']);
    expect(logs.args).toContain('--tail');
    expect(logs.args.slice(logs.args.indexOf('logs'))).not.toContain('-f');
    expect(composeInvocation('ps').args).toContain('ps');
    expect(() => composeInvocation('rm')).toThrow(/알 수 없는/u);
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
