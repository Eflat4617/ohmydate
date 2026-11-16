/**
 * Process-level behaviour of the core binary (blueprint 15 §1): one instance
 * per data directory, a fresh launch token per start, data that survives a
 * restart — including stored idempotent responses — and the movable clock
 * of the test build (`--clock-offset-ms`, 15 §7.3).
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Stamped {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

/** The millisecond a UUIDv7 was made in: its first 48 bits. */
function idTime(id: string): number {
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/** Starts a core on a clock moved by `offsetMs` and checks what it stamps. */
async function expectStampsShiftedBy(offsetMs: number, args: readonly string[]): Promise<void> {
  const before = Date.now();
  core = await startCore({ args });
  const created = await core.request('POST', `${API_PREFIX}/tasks`, {
    headers: { 'idempotency-key': newIdempotencyKey() },
    body: { title: 'stamped by the core clock' },
  });
  expect(created.status).toBe(201);
  const task = created.body as Stamped;
  const renamed = await core.request('PATCH', `${API_PREFIX}/tasks/${task.id}`, {
    headers: { 'idempotency-key': newIdempotencyKey(), 'if-match': `W/"${task.version}"` },
    body: { title: 'stamped again' },
  });
  expect(renamed.status).toBe(200);
  const owner = (await core.request('GET', `${API_PREFIX}/me`)).body as Stamped;
  const after = Date.now();

  // Every time the core writes is the wall clock plus the offset: the row
  // it created at start (the owner), a new row, an update — and the time
  // inside the id, so ids and rows sort the same way.
  for (const [name, time] of [
    ['owner.createdAt', Date.parse(owner.createdAt)],
    ['task.createdAt', Date.parse(task.createdAt)],
    ['task.updatedAt', Date.parse((renamed.body as Stamped).updatedAt)],
    ['task.id', idTime(task.id)],
    ['owner.id', idTime(owner.id)],
  ] as const) {
    expect(time, name).toBeGreaterThanOrEqual(before + offsetMs);
    expect(time, name).toBeLessThanOrEqual(after + offsetMs);
  }
}

test('without the option the core stamps real time', async () => {
  await expectStampsShiftedBy(0, []);
});

test('a test build moved forward stamps rows and ids with the shifted time', async () => {
  await expectStampsShiftedBy(400 * DAY_MS, ['--clock-offset-ms', String(400 * DAY_MS)]);
});

test('a test build moved back does the same', async () => {
  await expectStampsShiftedBy(-400 * DAY_MS, ['--clock-offset-ms', String(-400 * DAY_MS)]);
});

test('time that passes on the shifted clock expires an idempotency key after a day, not before', async () => {
  const first = await startCore();
  core = first;
  const headers = { 'idempotency-key': newIdempotencyKey() };
  const body = { title: 'once per day' };
  const created = await first.request('POST', `${API_PREFIX}/tasks`, { headers, body });
  expect(created.status).toBe(201);
  await first.stop();

  // 23 hours later the stored answer is still replayed …
  const sameDay = await startCore({ dataDir: first.dataDir, args: ['--clock-offset-ms', String(23 * HOUR_MS)] });
  core = sameDay;
  const replay = await sameDay.request('POST', `${API_PREFIX}/tasks`, { headers, body });
  expect([replay.status, replay.body]).toEqual([201, created.body]);
  await sameDay.stop();

  // … 25 hours later the key is free, and the request runs again.
  const nextDay = await startCore({ dataDir: first.dataDir, args: ['--clock-offset-ms', String(25 * HOUR_MS)] });
  core = nextDay;
  const again = await nextDay.request('POST', `${API_PREFIX}/tasks`, { headers, body });
  expect(again.status).toBe(201);
  expect((again.body as Stamped).id).not.toBe((created.body as Stamped).id);
  const list = await nextDay.request('GET', `${API_PREFIX}/tasks`);
  expect((list.body as { items: unknown[] }).items).toHaveLength(2);
});

test('a clock offset that is not a whole number of milliseconds exits with code 2', async () => {
  for (const value of ['soon', '1.5', '', '1e3', '99999999999999999999']) {
    expect(await runCoreToExit(['--clock-offset-ms', value]), value).toBe(2);
  }
  expect(await runCoreToExit(['--clock-offset-ms'])).toBe(2);
});
