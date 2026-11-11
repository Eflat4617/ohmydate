import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DistLock,
  type ApiDistArtifact,
  apiDistArtifact,
  assertApiDistArtifact,
  writeApiDistBuildId,
} from './support/dist-artifact.js';

vi.setConfig({ testTimeout: 15_000 });

async function makeDistArtifact(): Promise<ApiDistArtifact> {
  const root = await mkdtemp(join(tmpdir(), 'ohmydate-dist-artifact-'));
  const artifact = apiDistArtifact(root);
  await mkdir(join(artifact.distDir, 'db'), { recursive: true });
  await writeFile(artifact.mainPath, '// main\n', 'utf8');
  await writeFile(artifact.migratePath, '// migrate\n', 'utf8');
  return artifact;
}

async function makeLockDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ohmydate-dist-lock-'));
  return join(root, 'dist.lock');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(1);
  }
}

describe('api dist artifact', () => {
  test('accepts the build id stamped by this invocation', async () => {
    const artifact = await makeDistArtifact();
    try {
      const buildId = randomUUID();
      writeApiDistBuildId(artifact, buildId);
      expect(() => assertApiDistArtifact(artifact, buildId)).not.toThrow();
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });

  test('rejects a missing artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ohmydate-dist-missing-'));
    try {
      const artifact = apiDistArtifact(root);
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(
        /artifact is missing/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a corrupt or missing build id', async () => {
    const artifact = await makeDistArtifact();
    try {
      await writeFile(artifact.buildIdPath, 'not a build id\n', 'utf8');
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(/corrupt/u);

      await rm(artifact.buildIdPath, { force: true });
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(
        /build id is missing/u,
      );
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });

  test('rejects a build id from another invocation', async () => {
    const artifact = await makeDistArtifact();
    try {
      writeApiDistBuildId(artifact, randomUUID());
      expect(() => assertApiDistArtifact(artifact, randomUUID())).toThrow(/mismatch/u);
    } finally {
      await rm(artifact.apiRoot, { recursive: true, force: true });
    }
  });
});

describe('dist lock', () => {
  test('acquires and releases a lock it owns', async () => {
    const dir = await makeLockDir();
    try {
      const lock = new DistLock(dir, randomUUID());
      await lock.acquire();
      expect(lock.held).toBe(true);
      expect(existsSync(join(dir, 'owner.json'))).toBe(true);
      expect(await lock.release()).toBe(true);
      expect(existsSync(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('release with a mismatched owner token is a no-op', async () => {
    const dir = await makeLockDir();
    try {
      const lock = new DistLock(dir, randomUUID());
      await lock.acquire();
      // Simulate the lock directory being replaced or stolen.
      await writeFile(
        join(dir, 'owner.json'),
        JSON.stringify({ token: 'intruder', pid: process.pid }),
        'utf8',
      );
      expect(await lock.release()).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'))).toMatchObject({
        token: 'intruder',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two waiters reclaiming one crashed holder yield exactly one lease', async () => {
    const dir = await makeLockDir();
    const crashedPid = 424242;
    const isAlive = (pid: number): boolean => pid !== crashedPid;
    try {
      await mkdir(dir);
      await writeFile(
        join(dir, 'owner.json'),
        JSON.stringify({ token: 'crashed-holder', pid: crashedPid }),
        'utf8',
      );

      const first = new DistLock(dir, 'waiter-a', { isAlive, pollMs: 1, timeoutMs: 5_000 });
      const second = new DistLock(dir, 'waiter-b', { isAlive, pollMs: 1, timeoutMs: 5_000 });
      const acquired: string[] = [];
      const firstWait = first.acquire().then(() => {
        acquired.push('a');
      });
      const secondWait = second.acquire().then(() => {
        acquired.push('b');
      });

      await Promise.race([firstWait, secondWait]);
      await delay(100);
      expect(acquired).toHaveLength(1);
      expect([first.held, second.held].filter(Boolean)).toHaveLength(1);

      const owner = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')) as {
        token: string;
      };
      expect(owner.token).toBe(acquired[0] === 'a' ? 'waiter-a' : 'waiter-b');

      if (first.held) {
        expect(await first.release()).toBe(true);
        await secondWait;
      } else {
        expect(await second.release()).toBe(true);
        await firstWait;
      }
      expect(acquired).toHaveLength(2);

      if (first.held) await first.release();
      if (second.held) await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('paused owner publication cannot hand a second waiter a second lease', async () => {
    const dir = await makeLockDir();
    const crashedPid = 424242;
    const isAlive = (pid: number): boolean => pid !== crashedPid;
    let resumePublish: (() => void) | undefined;
    let signalPaused: (() => void) | undefined;
    const publicationPaused = new Promise<void>((resolve) => {
      signalPaused = resolve;
    });
    let pauseFirstPublication = true;
    try {
      await mkdir(dir);
      await writeFile(
        join(dir, 'owner.json'),
        JSON.stringify({ token: 'crashed-holder', pid: crashedPid }),
        'utf8',
      );

      // The reviewer's interleaving: a reclaimer replaces the crashed holder
      // and pauses after writing its complete owner directory but before the
      // atomic publish rename. With mkdir-then-write the lock path would sit
      // ownerless and a second stale reclaimer could rename it away.
      const first = new DistLock(dir, 'waiter-a', {
        isAlive,
        pollMs: 1,
        timeoutMs: 5_000,
        beforePublish: async () => {
          if (!pauseFirstPublication) return;
          pauseFirstPublication = false;
          signalPaused?.();
          await new Promise<void>((resolve) => {
            resumePublish = resolve;
          });
        },
      });
      const second = new DistLock(dir, 'waiter-b', { isAlive, pollMs: 1, timeoutMs: 5_000 });

      const firstWait = first.acquire();
      await publicationPaused;
      expect(first.held).toBe(false);

      const secondWait = second.acquire();
      await waitFor(() => second.held, 5_000, 'second waiter lease');
      expect(first.held).toBe(false);
      expect([first.held, second.held].filter(Boolean)).toHaveLength(1);

      if (resumePublish === undefined) throw new Error('publication was never paused');
      resumePublish();

      // The paused reclaimer resumes after the second waiter has published:
      // its rename must fail against the non-empty live lease and it must keep
      // waiting instead of granting itself a second lease.
      await waitFor(() => !pauseFirstPublication, 5_000, 'first publication resume');
      await delay(50);
      expect(first.held).toBe(false);
      expect([first.held, second.held].filter(Boolean)).toHaveLength(1);
      const owner = JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8')) as {
        token: string;
      };
      expect(owner.token).toBe('waiter-b');

      expect(await second.release()).toBe(true);
      await firstWait;
      expect(first.held).toBe(true);
      expect(await first.release()).toBe(true);
      await secondWait;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
