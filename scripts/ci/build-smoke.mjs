#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const apiDir = join(repoRoot, 'services', 'api');
const HEALTH_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 15_000;

function runPnpm(args, cwd) {
  const execPath = process.env['npm_execpath'];
  let command = 'pnpm';
  let commandArgs = args;
  if (execPath !== undefined && execPath.length > 0) {
    if (/\.(c|m)?js$/.test(execPath)) {
      command = process.execPath;
      commandArgs = [execPath, ...args];
    } else {
      command = execPath;
    }
  }
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm ${args.join(' ')} exited ${String(result.status)}`);
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not reserve a TCP port'));
        return;
      }
      const { port } = address;
      server.close(() => resolvePort(port));
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const timer = globalThis.setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process did not exit within ${String(timeoutMs)}ms`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      globalThis.clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function waitForHealth(url, child, stderr) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `API exited before /healthz with code ${String(child.exitCode)}\n${stderr()}`,
      );
    }
    try {
      const response = await globalThis.fetch(url);
      if (response.status === 200) return await response.json();
    } catch {
      // Server not listening yet.
    }
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 100));
  }
  throw new Error(`timed out waiting for ${url}\n${stderr()}`);
}

async function main() {
  const required =
    process.argv.includes('--required') ||
    process.env['CI'] === '1' ||
    process.env['CI'] === 'true';
  const databaseUrl = process.env['DATABASE_URL'];

  // The build half is mandatory even without a database: a no-DB run must
  // still prove dist compiles (FU-37R LOW).
  console.log('[build-smoke] rm -rf services/api/dist');
  await rm(join(apiDir, 'dist'), { recursive: true, force: true });
  console.log('[build-smoke] build');
  runPnpm(['run', 'build'], apiDir);

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    const reason =
      '[build-smoke] DATABASE_URL is not set. The start smoke boots ' +
      'PROVIDER=vikunja, which needs PostgreSQL but no docker.';
    if (required) {
      throw new Error(`${reason} This step is required from pnpm run ci.`);
    }
    console.log(`${reason} SKIPPED (optional developer command).`);
    return;
  }

  const schema = `ci_smoke_${String(process.pid)}_${String(Date.now())}`;
  const require = createRequire(join(apiDir, 'package.json'));
  const { Client } = require('pg');
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();

  const pushKeyDir = await mkdtemp(join(os.tmpdir(), 'ohmydate-smoke-push-'));
  const pushKeyFile = join(pushKeyDir, 'push.key');
  await writeFile(
    pushKeyFile,
    '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0\n',
    { mode: 0o600 },
  );

  let child;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const { migrate } = await import(
      pathToFileURL(join(apiDir, 'dist', 'db', 'migrate.js')).href
    );
    await migrate({ databaseUrl, schema });

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    let stderr = '';
    child = spawn(process.execPath, [join(apiDir, 'dist', 'main.js')], {
      cwd: apiDir,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PGOPTIONS: `-c search_path=${schema}`,
        PROVIDER: 'vikunja',
        VIKUNJA_URL: 'http://127.0.0.1:9',
        VIKUNJA_RECONCILE_INTERVAL_MS: '0',
        PUSH_KEY_FILE: pushKeyFile,
        HOST: '127.0.0.1',
        PORT: String(port),
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => undefined);
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const body = await waitForHealth(`${baseUrl}/healthz`, child, () => stderr);
    if (body.status !== 'ok') {
      throw new Error(`unexpected /healthz body: ${JSON.stringify(body)}`);
    }
    console.log('[build-smoke] /healthz 200 {status:ok}');

    child.kill('SIGTERM');
    const { code, signal } = await waitForExit(child, SHUTDOWN_TIMEOUT_MS);
    if (code !== 0 || signal !== null) {
      throw new Error(
        `expected a clean SIGTERM exit 0, got code=${String(code)} signal=${String(signal)}\n` +
          stderr,
      );
    }
    console.log('[build-smoke] SIGTERM exit 0');
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL');
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await admin.end();
    await rm(pushKeyDir, { recursive: true, force: true });
  }
}

await main().catch((error) => {
  console.error(`[build-smoke] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
