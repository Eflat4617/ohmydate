import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import {
  createSchema,
  databaseUrl,
  dropSchema,
  hasDatabase,
  makeSchemaName,
} from './support/test-context.js';

const { Client } = pg;

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const tsxBin = join(apiRoot, 'node_modules', '.bin', 'tsx');

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCreateUser(email: string, password: string, schema: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      tsxBin,
      ['src/cli/create-user.ts', email],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl ?? '',
          PGOPTIONS: `-c search_path=${schema}`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(password);
  });
}

describe.skipIf(!hasDatabase)('create-user CLI', () => {
  let schema: string;

  beforeAll(async () => {
    schema = makeSchemaName();
    await createSchema(schema);
    await migrate({ databaseUrl: databaseUrl as string, schema });
  });

  afterAll(async () => {
    await dropSchema(schema);
  });

  test('reads the password from stdin and inserts an argon2id user', async () => {
    const result = await runCreateUser('Seed.User@Example.com', 'seed-password', schema);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('created user seed.user@example.com');
    expect(result.stdout).not.toContain('seed-password');
    expect(result.stderr).not.toContain('seed-password');

    const client = new Client({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    await client.connect();
    try {
      const row = await client.query<{ id: string; email: string; password_hash: string }>(
        'SELECT id, email, password_hash FROM "user" WHERE email = $1',
        ['seed.user@example.com'],
      );
      expect(row.rowCount).toBe(1);
      expect(row.rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);

      const inbox = await client.query<{ kind: string; title: string }>(
        'SELECT kind, title FROM project WHERE owner_id = $1',
        [row.rows[0]?.id],
      );
      expect(inbox.rowCount).toBe(1);
      expect(inbox.rows[0]).toEqual({ kind: 'inbox', title: 'Inbox' });
    } finally {
      await client.end();
    }
  });

  test('rejects a duplicate email with a non-zero exit code', async () => {
    const duplicate = await runCreateUser('seed.user@example.com', 'another-password', schema);
    expect(duplicate.code).not.toBe(0);
  });
});
