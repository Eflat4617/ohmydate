import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { migrate } from '../../services/api/src/db/migrate.ts';
import { createContext, repoRoot, requirePg } from './common.mjs';
import { ensureMigrations, migrationsDir } from './stack.mjs';
import { runPreflight } from './start.mjs';

const baseUrl = process.env.DATABASE_URL ?? '';
const enabled = baseUrl.length > 0;
const tempDirs: string[] = [];
const schemas: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ohmydate-local-migrate-'));
  tempDirs.push(dir);
  return dir;
}

function schemaUrl(name: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-c search_path=${name}`);
  return url.toString();
}

async function createSchema(prefix: string): Promise<{ name: string; url: string }> {
  const name = `t_${prefix}_${randomBytes(5).toString('hex')}`;
  const { Client } = requirePg();
  const client = new Client({ connectionString: baseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${name}"`);
  } finally {
    await client.end();
  }
  schemas.push(name);
  return { name, url: schemaUrl(name) };
}

async function writeSecrets(dir: string): Promise<void> {
  for (const name of [
    'postgres.env',
    'vikunja.env',
    'push.key',
    'llm-session-secret',
    'vikunja-tokens.json',
  ]) {
    await writeFile(join(dir, name), 'test-only\n', { mode: 0o600 });
  }
}

function runMigrateCli(env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(repoRoot, 'scripts/local/migrate.mjs')], {
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
    child.on('close', (status) => resolveRun({ status, stdout, stderr }));
  });
}

afterAll(async () => {
  if (enabled) {
    const { Client } = requirePg();
    const client = new Client({ connectionString: baseUrl });
    await client.connect();
    try {
      for (const name of schemas.splice(0)) {
        await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe('local migrations', () => {
  test.skipIf(!enabled)(
    'start applies a pending migration and continues',
    async () => {
      const migrations = (await readdir(migrationsDir()))
        .filter((name) => /^\d{4}_[A-Za-z0-9_]+\.sql$/u.test(name) && !name.endsWith('.down.sql'))
        .sort();
      const last = migrations[migrations.length - 1];
      expect(last).toBeDefined();
      if (last === undefined) return;

      // Seed a temp schema with every migration except the newest.
      const seedDir = await tempDir();
      const seeded = migrations.slice(0, -1);
      for (const name of seeded) {
        await writeFile(join(seedDir, name), await readFile(join(migrationsDir(), name)));
        const down = name.replace(/\.sql$/u, '.down.sql');
        await writeFile(join(seedDir, down), await readFile(join(migrationsDir(), down)));
      }
      const schema = await createSchema('start');
      await migrate({ databaseUrl: baseUrl, migrationsDir: seedDir, schema: schema.name });

      const secrets = await tempDir();
      await writeSecrets(secrets);
      const context = createContext({
        ...process.env,
        OHMYDATE_LOCAL_SECRETS_DIR: secrets,
        OHMYDATE_LOCAL_DATABASE_URL: schema.url,
      });
      const deps = {
        checkStack: async () => ({ database: true, vikunja: true, ok: true }),
        ensureMigrations,
      };

      const result = await runPreflight({ context, env: {}, fakeLlm: true, deps });
      expect(result.ok).toBe(true);
      expect(result.notices).toEqual([`플래너 마이그레이션 적용: ${last}`]);
      expect(JSON.stringify(result.notices)).not.toContain('postgres://');

      const again = await runPreflight({ context, env: {}, fakeLlm: true, deps });
      expect(again.ok).toBe(true);
      expect(again.notices).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!enabled)(
    'local:migrate is idempotent and never prints the database URL',
    async () => {
      const schema = await createSchema('cli');
      const secrets = await tempDir();
      const env = {
        ...process.env,
        OHMYDATE_LOCAL_SECRETS_DIR: secrets,
        OHMYDATE_LOCAL_DATABASE_URL: schema.url,
      };

      const first = await runMigrateCli(env);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('플래너 마이그레이션 적용:');

      const second = await runMigrateCli(env);
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('적용할 플래너 마이그레이션이 없습니다.');

      for (const output of [first, second]) {
        expect(output.stdout).not.toContain('postgres://');
        expect(output.stderr).not.toContain('postgres://');
      }
    },
    60_000,
  );
});
