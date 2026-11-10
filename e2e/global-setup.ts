import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { STATE_PATH, type E2EState } from './helpers/state';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const logsDir = path.join(repoRoot, 'test-results', 'e2e', 'logs');
const stateDir = path.dirname(STATE_PATH);
const require = createRequire(path.join(repoRoot, 'services/api/package.json'));
const pg = require('pg') as {
  Client: new (options: { connectionString: string }) => {
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
};

const DEFAULT_DATABASE_URL =
  'postgres://ohmydate:ohmydate-dev-only@127.0.0.1:55432/planner_test';
const DEFAULT_VIKUNJA_URL = 'http://127.0.0.1:3456';

const VIKUNJA_TOKEN_PERMISSIONS = {
  projects: ['create', 'read_all', 'read_one', 'update', 'delete', 'permanent'],
  tasks: ['create', 'read_all', 'read_one', 'update', 'delete', 'deleted', 'permanent'],
  tasks_relations: ['create', 'delete'],
  other: ['user'],
};

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function uuidv7(): string {
  const now = BigInt(Date.now());
  const bytes = randomBytes(16);
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function scopedDatabaseUrl(baseUrl: string, schema: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('options', `-csearch_path=${schema}`);
  return url.toString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(
  url: string,
  accept: (response: Response) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (accept(response)) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`timed out waiting for ${url}: ${lastError}`);
}

function spawnLogged(
  name: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const logPath = path.join(logsDir, `${name}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(command, [...args], {
    cwd: repoRoot,
    detached: true,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  closeSync(fd);
  if (child.pid === undefined) throw new Error(`failed to start ${name}`);
  return child;
}

async function run(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      [...args],
      { cwd: repoRoot, env: { ...process.env, ...env }, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${command} ${args.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (stdin !== undefined && child.stdin !== null) {
      child.stdin.end(stdin);
    }
  });
}

function parsePlannerUserId(stdout: string): string {
  const match = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/.exec(stdout);
  if (match === null || match[1] === undefined) {
    throw new Error(`create-user did not report a user id: ${stdout}`);
  }
  return match[1];
}

async function vikunja(
  baseUrl: string,
  pathname: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<unknown> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}/api/v2${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vikunja ${pathname} -> ${response.status}: ${text}`);
  }
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

async function createSchema(baseDatabaseUrl: string, schema: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema: ${schema}`);
  const client = new pg.Client({ connectionString: baseDatabaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${`"${schema}"`}`);
  } finally {
    await client.end();
  }
}

async function insertOwnerAccount(options: {
  databaseUrl: string;
  ownerId: string;
  vikunjaUserId: number;
  inboxExternalId: string;
}): Promise<void> {
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO vikunja_owner_account (owner_id, vikunja_user_id, token_secret_ref)
       VALUES ($1, $2, $3)`,
      [options.ownerId, options.vikunjaUserId, 'env:VIKUNJA_TOKEN_OWNER_E2E'],
    );
    await client.query(
      `INSERT INTO vikunja_mapping (entity_type, entity_id, owner_id, external_id, local_version)
       VALUES ('project', $1, $2, $3, 1)`,
      [uuidv7(), options.ownerId, options.inboxExternalId],
    );
  } finally {
    await client.end();
  }
}

export default async function globalSetup(): Promise<void> {
  const baseDatabaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const vikunjaUrl = process.env['VIKUNJA_URL'] ?? DEFAULT_VIKUNJA_URL;
  const schema = `e2e_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const databaseUrl = scopedDatabaseUrl(baseDatabaseUrl, schema);

  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(logsDir, { recursive: true });

  await createSchema(baseDatabaseUrl, schema);
  await run(
    process.execPath,
    ['--experimental-strip-types', path.join(repoRoot, 'services/api/src/db/migrate.ts'), 'up'],
    { DATABASE_URL: databaseUrl },
  );

  const suffix = uniqueSuffix();
  const username = `e2e-${suffix}`;
  const password = `pw-${suffix}-${suffix}`;
  const email = `${username}@example.invalid`;

  const registered = (await vikunja(vikunjaUrl, '/register', {
    method: 'POST',
    body: { username, email, password },
  })) as { id?: number };
  if (registered.id === undefined) throw new Error('Vikunja register returned no user id');
  const vikunjaUserId = registered.id;

  const login = (await vikunja(vikunjaUrl, '/login', {
    method: 'POST',
    body: { username, password },
  })) as { token?: string };
  if (login.token === undefined) throw new Error('Vikunja login returned no JWT');

  const projects = (await vikunja(vikunjaUrl, '/projects?per_page=50', {
    token: login.token,
  })) as { items?: { id: number; title: string }[] };
  let inbox = (projects.items ?? []).find(
    (project) => project.id > 0 && project.title.toLowerCase() === 'inbox',
  );
  if (inbox === undefined) {
    inbox = (await vikunja(vikunjaUrl, '/projects', {
      method: 'POST',
      token: login.token,
      body: { title: 'Inbox' },
    })) as { id: number; title: string };
  }

  const createdToken = (await vikunja(vikunjaUrl, '/tokens', {
    method: 'POST',
    token: login.token,
    body: {
      title: `e2e ${username}`,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      permissions: VIKUNJA_TOKEN_PERMISSIONS,
    },
  })) as { token?: string };
  if (createdToken.token === undefined) throw new Error('Vikunja token creation returned no token');

  const createUser = await run(
    path.join(repoRoot, 'services/api/node_modules/.bin/tsx'),
    [path.join(repoRoot, 'services/api/src/cli/create-user.ts'), email],
    { DATABASE_URL: databaseUrl },
    password,
  );
  const ownerId = parsePlannerUserId(createUser.stdout);

  await insertOwnerAccount({
    databaseUrl,
    ownerId,
    vikunjaUserId,
    inboxExternalId: String(inbox.id),
  });

  const apiPort = await freePort();
  const apiUrl = `http://127.0.0.1:${apiPort}`;
  const api = spawnLogged(
    'api',
    path.join(repoRoot, 'services/api/node_modules/.bin/tsx'),
    [path.join(repoRoot, 'e2e/helpers/api-server.ts')],
    {
      PROVIDER: 'vikunja',
      DATABASE_URL: databaseUrl,
      VIKUNJA_URL: vikunjaUrl,
      VIKUNJA_TOKEN_OWNER_E2E: createdToken.token,
      PORT: String(apiPort),
      LOG_LEVEL: 'warn',
    },
  );
  await waitForHttp(`${apiUrl}/me`, (response) => response.status === 401);

  const webPort = await freePort();
  const webUrl = `http://127.0.0.1:${webPort}`;
  const web = spawnLogged(
    'web',
    'corepack',
    [
      'pnpm',
      '--filter',
      '@ohmydate/web',
      'exec',
      'vite',
      '--port',
      String(webPort),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    { OHMYDATE_API_PROXY_TARGET: apiUrl },
  );
  await waitForHttp(`${webUrl}/`, (response) => response.status === 200, 60_000);

  const state: E2EState & { baseDatabaseUrl: string } = {
    webUrl,
    apiUrl,
    vikunjaUrl,
    databaseSchema: schema,
    baseDatabaseUrl,
    email,
    password,
    vikunjaToken: createdToken.token,
    vikunjaUserId,
    inboxExternalId: String(inbox.id),
    apiPid: api.pid ?? 0,
    webPid: web.pid ?? 0,
  };
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}
