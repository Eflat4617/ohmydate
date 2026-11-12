import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildMark,
  needsBuild,
  readBuildStamp,
  webSources,
  writeBuildStamp,
} from './start.mjs';
import { inspectProcess } from './pid.mjs';

const tempDirs = [];

afterEach(async () => {
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
