import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildMark,
  effectiveLlm,
  needsBuild,
  readBuildStamp,
  waitForHttpOrExit,
  webBuildEnv,
  webSources,
  writeBuildStamp,
} from './start.mjs';
import { inspectProcess } from './pid.mjs';
import { repoRoot } from './common.mjs';

const tempDirs = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-start-'));
  tempDirs.push(dir);
  return dir;
}

describe('needsBuild', () => {
  test('a missing or interrupted build is stale (no stamp despite an output)', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.ts');
    const output = join(dir, 'dist', 'main.js');
    const stamp = join(dir, '.local', 'build.stamp.json');
    await writeFile(source, 'export {};\n');
    await mkdir(join(dir, 'dist'));
    await writeFile(output, 'built\n');

    expect(needsBuild('api', { output, sources: [source], stampPath: stamp })).toBe(true);

    const now = Date.now();
    await writeBuildStamp('api', stamp, now);
    expect(needsBuild('api', { output, sources: [source], stampPath: stamp })).toBe(false);
  });

  test('a source newer than the successful-build stamp is stale', async () => {
    const dir = await tempDir();
    const source = join(dir, 'source.ts');
    const output = join(dir, 'main.js');
    const stamp = join(dir, 'build.stamp.json');
    await writeFile(source, 'export {};\n');
    await writeFile(output, 'built\n');

    await writeBuildStamp('web', stamp, Date.now());
    expect(needsBuild('web', { output, sources: [source], stampPath: stamp })).toBe(false);

    const future = new Date(Date.now() + 5_000);
    await utimes(source, future, future);
    expect(needsBuild('web', { output, sources: [source], stampPath: stamp })).toBe(true);
  });

  test('per-kind stamps do not make the other output fresh', async () => {
    const dir = await tempDir();
    const stamp = join(dir, 'build.stamp.json');
    await writeBuildStamp('api', stamp, 1_000);
    const parsed = readBuildStamp(stamp);
    expect(parsed?.api).toBe(1_000);
    expect(parsed?.web).toBeUndefined();
    expect(buildMark(parsed)).toBe('1000:0');
  });

  test('web sources include the workspace package and public assets', () => {
    const sources = webSources();
    expect(sources.some((path) => path.endsWith('packages/ui-policy/src'))).toBe(true);
    expect(sources.some((path) => path.endsWith('apps/web/public'))).toBe(true);
  });
});

describe('start process identity', () => {
  test('a foreign live PID is not reported as a running local process', async () => {
    const dir = await tempDir();
    const foreign = process.pid;
    await writeFile(
      join(dir, 'api.pid'),
      `${JSON.stringify({ pid: foreign, marker: 'not-this-process', startTime: '0' })}\n`,
      { mode: 0o600 },
    );
    const inspection = await inspectProcess(dir, 'api');
    expect(inspection.status).toBe('mismatch');
    expect(await stat(join(dir, 'api.pid')).then((info) => info.isFile())).toBe(true);
  });
});

describe('start environment reporting', () => {
  test('the web build always pins VITE_MOCK=0 even with an ambient 1', () => {
    expect(webBuildEnv({ PATH: '/bin', VITE_MOCK: '1' }).VITE_MOCK).toBe('0');
  });

  test('reports the effective LLM base-URL host and model without a path or key', () => {
    const llm = effectiveLlm(
      {
        LLM_BASE_URL: 'https://ambient.example.com/v1/secret?token=abc',
        LLM_MODEL: 'ambient-model',
        LLM_PROVIDER: 'ambient-provider',
      },
      {
        LLM_BASE_URL: 'https://settings.example.com/v1',
        LLM_MODEL: 'settings-model',
        LLM_PROVIDER: 'settings-provider',
      },
      false,
    );
    expect(llm).toEqual({
      provider: 'ambient-provider',
      baseHost: 'ambient.example.com',
      model: 'ambient-model',
    });
    expect(JSON.stringify(llm)).not.toContain('secret');
    expect(JSON.stringify(llm)).not.toContain('/v1');
    expect(effectiveLlm({}, { LLM_MODEL: 'm' }, true)).toEqual({
      provider: 'fake',
      baseHost: '(fake-llm)',
      model: '(fake-llm)',
    });
    expect(effectiveLlm({ LLM_BASE_URL: 'not a url' }, { LLM_MODEL: 'm' }).baseHost).toBe(
      '(잘못된 URL)',
    );
  });
});

describe('settle after healthz 200', () => {
  test('a child that exits after the first 200 is not reported ready', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 150)'], {
        stdio: 'ignore',
      });
      children.push(child);
      await expect(
        waitForHttpOrExit(`http://127.0.0.1:${String(port)}/`, child.pid, '/no/log', 5_000, 400),
      ).rejects.toThrow(/응답 직후 종료/u);
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  test('a live child stays ready', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('ok');
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      await expect(
        waitForHttpOrExit(`http://127.0.0.1:${String(port)}/`, process.pid, '/no/log', 5_000, 50),
      ).resolves.toBeDefined();
    } finally {
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });
});

describe('start CLI', () => {
  test('prints the target before a stack-down preflight failure', async () => {
    const dir = await tempDir();
    for (const name of [
      'postgres.env',
      'vikunja.env',
      'push.key',
      'llm-session-secret',
      'vikunja-tokens.json',
    ]) {
      await writeFile(join(dir, name), 'test-only\n', { mode: 0o600 });
    }
    const child = spawn(process.execPath, [join(repoRoot, 'scripts/local/start.mjs'), '--fake-llm'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        OHMYDATE_LOCAL_SECRETS_DIR: dir,
        OHMYDATE_LOCAL_RUN_DIR: join(dir, 'run'),
        OHMYDATE_LOCAL_LOG_DIR: join(dir, 'logs'),
        OHMYDATE_LOCAL_DATABASE_URL: 'postgres://ohmydate:secret@127.0.0.1:1/planner',
        OHMYDATE_LOCAL_VIKUNJA_URL: 'http://127.0.0.1:1',
        OHMYDATE_LOCAL_HEALTH_TIMEOUT_MS: '300',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const code = await new Promise((resolveExit) => child.on('close', resolveExit));
    expect(code).not.toBe(0);
    expect(stdout).toContain('대상: PostgreSQL 127.0.0.1:1/planner');
    expect(stderr).toContain('먼저 coordinator가 deploy/local 스택을 올려야 합니다');
    expect(stdout).not.toContain('secret');
  }, 20_000);
});
