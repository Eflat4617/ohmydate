import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { STATE_PATH } from './helpers/state';

interface StateFile {
  readonly databaseSchema: string;
  readonly baseDatabaseUrl: string;
  readonly apiPid: number;
  readonly webPid: number;
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(repoRoot, 'services/api/package.json'));
const pg = require('pg') as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>;
    query(text: string): Promise<unknown>;
    end(): Promise<void>;
  };
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function signal(pid: number, name: NodeJS.Signals): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(-pid, name);
    return true;
  } catch {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      return false;
    }
  }
}

async function stopProcess(pid: number): Promise<void> {
  if (pid <= 0) return;
  signal(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      process.kill(-pid, 0);
    } catch {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
    }
    await delay(200);
  }
  signal(pid, 'SIGKILL');
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid schema identifier: ${value}`);
  }
  return `"${value}"`;
}

export default async function globalTeardown(): Promise<void> {
  let state: StateFile;
  try {
    state = JSON.parse(await fs.readFile(STATE_PATH, 'utf8')) as StateFile;
  } catch {
    return;
  }

  await Promise.all([stopProcess(state.webPid), stopProcess(state.apiPid)]);

  const baseDatabaseUrl =
    state.baseDatabaseUrl ?? 'postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test';
  try {
    const client = new pg.Client({ connectionString: baseDatabaseUrl });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(state.databaseSchema)} CASCADE`);
    } finally {
      await client.end();
    }
  } finally {
    await fs.rm(STATE_PATH, { force: true });
  }
}
