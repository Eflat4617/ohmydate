/**
 * Process-level behaviour of the core binary (blueprint 15 §1): one instance
 * per data directory, a fresh launch token per start, and data that survives
 * a restart — including stored idempotent responses.
 */
import { stat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { API_PREFIX } from './support/contract.js';
import { runCoreToExit, startCore, type Core } from './support/core.js';
import { newIdempotencyKey } from './support/routes.js';

let core: Core | undefined;

afterEach(async () => {
  await core?.dispose();
  core = undefined;
});

async function readyFiles(dataDir: string): Promise<string[]> {
  return (await readdir(dataDir)).filter((name) => name.startsWith('ready-'));
}

test('the ready file holds the token, is owner-only and disappears on shutdown', async () => {
  core = await startCore();
  const [name] = await readyFiles(core.dataDir);
  expect(name).toBeDefined();
  const path = join(core.dataDir, name ?? '');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  const ready = JSON.parse(await readFile(path, 'utf8')) as { port: number; token: string; pid: number };
  expect(ready.token).toMatch(/^[0-9a-f]{64}$/);
  expect(core.baseUrl).toBe(`http://127.0.0.1:${ready.port}`);

  expect(await core.stop()).toBe(0);
  expect(await readyFiles(core.dataDir)).toEqual([]);
});

test('a second instance on the same data directory exits with code 3', async () => {
  core = await startCore();
  expect(await runCoreToExit(['--data-dir', core.dataDir])).toBe(3);
  // The first instance is unaffected.
  expect((await core.request('GET', `${API_PREFIX}/me`)).status).toBe(200);
});

test('bad arguments exit with code 2', async () => {
  expect(await runCoreToExit(['--no-such-flag'])).toBe(2);
  expect(await runCoreToExit(['--time-zone', 'Mars/Olympus_Mons'])).toBe(2);
});

test('data, the owner and stored idempotent responses survive a restart', async () => {
  const first = await startCore();
  core = first;
  const headers = { 'idempotency-key': newIdempotencyKey() };
  const body = { title: 'survives a restart' };
  const created = await first.request('POST', `${API_PREFIX}/tasks`, { headers, body });
  expect(created.status).toBe(201);
  const owner = await first.request('GET', `${API_PREFIX}/me`);
  const firstToken = (await readyFiles(first.dataDir))[0];
  expect(await first.stop()).toBe(0);

  const second = await startCore({ dataDir: first.dataDir });
  core = second;
  expect((await readyFiles(second.dataDir))[0]).not.toBe(firstToken);
  expect((await second.request('GET', `${API_PREFIX}/me`)).body).toEqual(owner.body);
  const taskId = (created.body as { id: string }).id;
  expect((await second.request('GET', `${API_PREFIX}/tasks/${taskId}`)).body).toEqual(created.body);
  // The same key still replays instead of creating a second task.
  const replay = await second.request('POST', `${API_PREFIX}/tasks`, { headers, body });
  expect([replay.status, replay.body]).toEqual([201, created.body]);
  const list = await second.request('GET', `${API_PREFIX}/tasks`);
  expect((list.body as { items: unknown[] }).items).toHaveLength(1);
  const projects = await second.request('GET', `${API_PREFIX}/projects`);
  expect((projects.body as { items: unknown[] }).items).toHaveLength(1);
});

test('a token from a previous launch is not accepted', async () => {
  const first = await startCore();
  core = first;
  const name = (await readyFiles(first.dataDir))[0] ?? '';
  const old = JSON.parse(await readFile(join(first.dataDir, name), 'utf8')) as { token: string };
  await first.stop();
  const second = await startCore({ dataDir: first.dataDir });
  core = second;
  const response = await second.request('GET', `${API_PREFIX}/me`, {
    authenticated: false,
    headers: { authorization: `Bearer ${old.token}` },
  });
  expect(response.status).toBe(401);
});
