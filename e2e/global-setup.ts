import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
/** FU-76: scripted fake AI latency for the AI-wait owner (E2E-AI). */
const AI_WAIT_LATENCY_MS = 5_000;

const VIKUNJA_TOKEN_PERMISSIONS = {
  projects: ['create', 'read_all', 'read_one', 'update', 'delete', 'permanent'],
  tasks: ['create', 'read_all', 'read_one', 'update', 'delete', 'deleted', 'permanent'],
  tasks_relations: ['create', 'delete'],
  other: ['user'],
};

/**
 * Optional simulated start time for the planner API (and for specs that opt
 * in via helpers/clock.ts). Unset by default: the suite runs on real time.
 */
function clockOffsetFromEnv(): number {
  const raw = process.env['E2E_FAKE_NOW'];
  if (raw === undefined || raw.trim().length === 0) return 0;
  const target = Date.parse(raw);
  if (!Number.isFinite(target) || !/(Z|[+-]\d{2}:\d{2})$/.test(raw.trim())) {
    throw new Error(`E2E_FAKE_NOW must be an ISO-8601 instant with a zone, got: ${raw}`);
  }
  return target - Date.now();
}

function shiftedClockEnv(offsetMs: number): NodeJS.ProcessEnv {
  if (offsetMs === 0) return {};
  const preload = pathToFileURL(path.join(repoRoot, 'e2e/helpers/shifted-clock.mjs')).href;
  const inherited = process.env['NODE_OPTIONS'] ?? '';
  return {
    E2E_CLOCK_OFFSET_MS: String(offsetMs),
    NODE_OPTIONS: `${inherited} --import=${preload}`.trim(),
  };
}

function uniqueSuffix(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
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

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`invalid schema: ${value}`);
  return `"${value}"`;
}

async function createSchema(baseDatabaseUrl: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseDatabaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  } finally {
    await client.end();
  }
}

async function dropSchema(baseDatabaseUrl: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: baseDatabaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

async function insertOwnerAccount(options: {
  databaseUrl: string;
  ownerId: string;
  vikunjaUserId: number;
  tokenSecretRef: string;
}): Promise<void> {
  const client = new pg.Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO vikunja_owner_account (owner_id, vikunja_user_id, token_secret_ref)
       VALUES ($1, $2, $3)`,
      [options.ownerId, options.vikunjaUserId, options.tokenSecretRef],
    );
  } finally {
    await client.end();
  }
}

interface VikunjaFixture {
  readonly username: string;
  readonly password: string;
  readonly email: string;
  readonly token: string;
  readonly vikunjaUserId: number;
  readonly inboxExternalId: string;
}

async function createVikunjaFixture(
  vikunjaUrl: string,
  label: string,
): Promise<VikunjaFixture> {
  const suffix = uniqueSuffix();
  const username = `e2e-${label}-${suffix}`;
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

  return {
    username,
    password,
    email,
    token: createdToken.token,
    vikunjaUserId,
    inboxExternalId: String(inbox.id),
  };
}

async function createPlannerOwner(
  databaseUrl: string,
  fixture: VikunjaFixture,
  tokenEnvName: string,
): Promise<string> {
  const createUser = await run(
    path.join(repoRoot, 'services/api/node_modules/.bin/tsx'),
    [path.join(repoRoot, 'services/api/src/cli/create-user.ts'), fixture.email],
    { DATABASE_URL: databaseUrl },
    fixture.password,
  );
  const ownerId = parsePlannerUserId(createUser.stdout);
  await insertOwnerAccount({
    databaseUrl,
    ownerId,
    vikunjaUserId: fixture.vikunjaUserId,
    tokenSecretRef: `env:${tokenEnvName}`,
  });
  return ownerId;
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

export default async function globalSetup(): Promise<void> {
  const baseDatabaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL;
  const vikunjaUrl = process.env['VIKUNJA_URL'] ?? DEFAULT_VIKUNJA_URL;
  const schema = `e2e_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const databaseUrl = scopedDatabaseUrl(baseDatabaseUrl, schema);
  const clockOffsetMs = clockOffsetFromEnv();

  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.mkdir(logsDir, { recursive: true });
  const pushKeyFile = path.join(logsDir, 'push.key');
  await fs.writeFile(
    pushKeyFile,
    '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0\n',
    { mode: 0o600 },
  );

  let schemaCreated = false;
  let apiPid = 0;
  let webPid = 0;

  try {
    await createSchema(baseDatabaseUrl, schema);
    schemaCreated = true;
    await run(
      process.execPath,
      ['--experimental-strip-types', path.join(repoRoot, 'services/api/src/db/migrate.ts'), 'up'],
      { DATABASE_URL: databaseUrl },
    );

    const fixture = await createVikunjaFixture(vikunjaUrl, 'main');
    const todayFixture = await createVikunjaFixture(vikunjaUrl, 'today');
    const plansFixture = await createVikunjaFixture(vikunjaUrl, 'plans');
    const replanFixture = await createVikunjaFixture(vikunjaUrl, 'replan');
    const layoutFixture = await createVikunjaFixture(vikunjaUrl, 'layout');
    const notesFixture = await createVikunjaFixture(vikunjaUrl, 'notes');
    // FU-76 E2E-AI: own owner whose (fake) AI answers slowly, so the wizard's
    // wait state, cancel and reload-resume run against the real API.
    const aiWaitFixture = await createVikunjaFixture(vikunjaUrl, 'aiwait');

    await createPlannerOwner(databaseUrl, fixture, 'VIKUNJA_TOKEN_OWNER_E2E');
    await createPlannerOwner(databaseUrl, todayFixture, 'VIKUNJA_TOKEN_OWNER_E2E_TODAY');
    await createPlannerOwner(databaseUrl, plansFixture, 'VIKUNJA_TOKEN_OWNER_E2E_PLANS');
    await createPlannerOwner(databaseUrl, replanFixture, 'VIKUNJA_TOKEN_OWNER_E2E_REPLAN');
    await createPlannerOwner(databaseUrl, layoutFixture, 'VIKUNJA_TOKEN_OWNER_E2E_LAYOUT');
    const notesOwnerId = await createPlannerOwner(databaseUrl, notesFixture, 'VIKUNJA_TOKEN_OWNER_E2E_NOTES');
    const aiWaitOwnerId = await createPlannerOwner(
      databaseUrl,
      aiWaitFixture,
      'VIKUNJA_TOKEN_OWNER_E2E_AIWAIT',
    );

    const apiPort = await freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    const api = spawnLogged(
      'api',
      path.join(repoRoot, 'services/api/node_modules/.bin/tsx'),
      [path.join(repoRoot, 'services/api/src/main.ts')],
      {
        PROVIDER: 'vikunja',
        DATABASE_URL: databaseUrl,
        VIKUNJA_URL: vikunjaUrl,
        VIKUNJA_TOKEN_OWNER_E2E: fixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_TODAY: todayFixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_PLANS: plansFixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_REPLAN: replanFixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_LAYOUT: layoutFixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_NOTES: notesFixture.token,
        VIKUNJA_TOKEN_OWNER_E2E_AIWAIT: aiWaitFixture.token,
        PORT: String(apiPort),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        PUSH_KEY_FILE: pushKeyFile,
        LLM_PROVIDER: 'fake',
        // M6-03 E2E-6: deterministic note-grounded decomposition through the real
        // pipeline (type detection answered; grounded v2 cites the sent note block,
        // plus a forged ref and a planted link the sanitiser strips). E2E only, and
        // only for the notes owner: every other suite keeps the plain fake.
        LLM_FAKE_SCENARIO: 'e2e-grounded',
        LLM_FAKE_SCENARIO_OWNERS: notesOwnerId,
        // Fake-only knob: just the AI-wait owner gets 5 s scripted answers;
        // every other owner keeps the immediate manual-mode fallback.
        LLM_FAKE_SCRIPTED_OWNERS: aiWaitOwnerId,
        LLM_FAKE_LATENCY_MS: String(AI_WAIT_LATENCY_MS),
        LLM_DAILY_BUDGET_USD: '10',
        LLM_MONTHLY_BUDGET_USD: '100',
        // FU-79: fake-only reset route so every Playwright test starts with a
        // clean fixed login window (helpers/test.ts calls it in an auto
        // fixture). Rejected by production boot.
        E2E_RESET_LOGIN_RATE_LIMIT: '1',
        ...shiftedClockEnv(clockOffsetMs),
      },
    );
    apiPid = api.pid ?? 0;
    await waitForHttp(`${apiUrl}/healthz`, (response) => response.status === 200);

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
      { OHMYDATE_API_PROXY_TARGET: apiUrl, VITE_MOCK: '0' },
    );
    webPid = web.pid ?? 0;
    await waitForHttp(`${webUrl}/`, (response) => response.status === 200, 60_000);

    const state: E2EState = {
      webUrl,
      apiUrl,
      vikunjaUrl,
      databaseSchema: schema,
      baseDatabaseUrl,
      email: fixture.email,
      password: fixture.password,
      vikunjaToken: fixture.token,
      vikunjaUserId: fixture.vikunjaUserId,
      inboxExternalId: fixture.inboxExternalId,
      todayEmail: todayFixture.email,
      todayPassword: todayFixture.password,
      todayVikunjaToken: todayFixture.token,
      todayVikunjaUserId: todayFixture.vikunjaUserId,
      todayInboxExternalId: todayFixture.inboxExternalId,
      plansEmail: plansFixture.email,
      plansPassword: plansFixture.password,
      plansVikunjaToken: plansFixture.token,
      plansVikunjaUserId: plansFixture.vikunjaUserId,
      plansInboxExternalId: plansFixture.inboxExternalId,
      replanEmail: replanFixture.email,
      replanPassword: replanFixture.password,
      layoutEmail: layoutFixture.email,
      layoutPassword: layoutFixture.password,
      notesEmail: notesFixture.email,
      notesPassword: notesFixture.password,
      aiWaitEmail: aiWaitFixture.email,
      aiWaitPassword: aiWaitFixture.password,
      aiWaitOwnerId,
      aiWaitLatencyMs: AI_WAIT_LATENCY_MS,
      apiPid,
      webPid,
      ...(clockOffsetMs === 0 ? {} : { clockOffsetMs }),
    };
    await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await Promise.all([stopProcess(webPid), stopProcess(apiPid)]);
    if (schemaCreated) {
      await dropSchema(baseDatabaseUrl, schema).catch(() => undefined);
    }
    throw error;
  }
}
