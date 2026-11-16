/**
 * `getAvailability` / `putAvailability` (RC-20): the rules the generic suite
 * cannot know.
 *
 * `services/api/test/planning.test.ts` pins the reference's side (the tag,
 * 412 `availability_changed` for the loser of two first PUTs). Where the
 * core differs on purpose the test says so and blueprint 15 §2.2 records it.
 */
import type { Availability } from '@ohmydate/contracts';
import { API_PREFIX, expectProblem, expectSuccess, routeById } from './support/contract.js';
import { startCore, type Core, type CoreResponse } from './support/core.js';
import { newIdempotencyKey, sampleHours } from './support/routes.js';

let core: Core;

beforeEach(async () => {
  // Every test starts from hours nobody has set (version 1).
  core = await startCore();
});

afterEach(async () => {
  await core.dispose();
});

const getRoute = routeById('getAvailability');
const putRoute = routeById('putAvailability');
const PATH = `${API_PREFIX}/availability`;

function put(version: number, body: unknown, key: string = newIdempotencyKey()): Promise<CoreResponse> {
  return core.request('PUT', PATH, {
    headers: { 'if-match': `W/"availability:${version}"`, 'idempotency-key': key },
    body,
  });
}

async function read(): Promise<Availability> {
  const response = await core.request('GET', PATH);
  expectSuccess(getRoute, response, 200);
  return response.body as Availability;
}

function errorsOf(response: CoreResponse): unknown {
  return (response.body as { errors?: unknown }).errors;
}

/** `sampleHours()` with one value replaced, by a path of keys and indexes. */
function hoursWith(path: readonly (string | number)[], value: unknown): Record<string, unknown> {
  const hours = sampleHours();
  let cursor: Record<string | number, unknown> = hours;
  for (const step of path.slice(0, -1)) {
    cursor = cursor[step] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cursor[last] = value;
  return hours;
}

describe('getAvailability', () => {
  test('before anything is set: version 1, the owner\'s zone, no windows, the default limits', async () => {
    const response = await core.request('GET', PATH);
    expectSuccess(getRoute, response, 200);
    expect(response.headers.get('etag')).toBe('W/"availability:1"');
    expect(response.body).toEqual({
      version: 1,
      // The harness starts the core with `--time-zone Asia/Seoul`.
      timeZone: 'Asia/Seoul',
      rules: [],
      exceptions: [],
      prefs: {
        maxDailyFocusMin: 240,
        breakAfterMin: 60,
        breakMin: 15,
        dayStartLocal: '08:00',
        dayEndLocal: '18:00',
        riskLevel: 'p50',
      },
    });
  });

  test('until something is stored the zone follows the owner\'s setting', async () => {
    const settings = await core.request('PATCH', `${API_PREFIX}/me/settings`, {
      headers: { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() },
      body: { timeZone: 'America/New_York' },
    });
    expect(settings.status).toBe(200);
    expect((await read()).timeZone).toBe('America/New_York');
    // Changing the owner's zone is not a change of the hours.
    expect((await read()).version).toBe(1);
  });

  test('windows are ordered by weekday and start, exceptions by date; ties keep their listed order', async () => {
    const hours = {
      ...sampleHours(),
      rules: [
        { weekday: 5, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
        { weekday: 1, startLocal: '13:00', endLocal: '14:00', kind: 'work' },
        { weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'focus' },
        { weekday: 1, startLocal: '09:00', endLocal: '10:00', kind: 'work' },
      ],
      exceptions: [
        { date: '2027-01-01', kind: 'off' },
        { date: '2026-12-25', kind: 'off', startLocal: '09:00', endLocal: '12:00' },
        { date: '2026-12-25', kind: 'extra', startLocal: '20:00', endLocal: '24:00' },
      ],
    };
    expectSuccess(putRoute, await put(1, hours), 200);
    const stored = await read();
    expect(stored.rules).toEqual([hours.rules[2], hours.rules[3], hours.rules[1], hours.rules[0]]);
    expect(stored.exceptions).toEqual([hours.exceptions[1], hours.exceptions[2], hours.exceptions[0]]);
  });
});

describe('putAvailability: the availability version', () => {
  test('a PUT answers what it was given, in its order, as the next version', async () => {
    const response = await put(1, sampleHours());
    expectSuccess(putRoute, response, 200);
    expect(response.body).toEqual({ version: 2, ...sampleHours() });
    expect(response.headers.get('etag')).toBe('W/"availability:2"');

    const stored = await core.request('GET', PATH);
    expect(stored.headers.get('etag')).toBe('W/"availability:2"');
    expect((stored.body as Availability).version).toBe(2);
    // The tag a client held before is no longer current …
    const stale = await core.request('GET', PATH, { headers: { 'if-none-match': 'W/"availability:1"' } });
    expect(stale.status).toBe(200);
    // … and the new one is.
    const fresh = await core.request('GET', PATH, { headers: { 'if-none-match': 'W/"availability:2"' } });
    expect(fresh.status).toBe(304);
  });

  test('every accepted PUT is one version, also one that changes nothing', async () => {
    expect(((await put(1, sampleHours())).body as Availability).version).toBe(2);
    expect(((await put(2, sampleHours())).body as Availability).version).toBe(3);
    expect(((await put(3, sampleHours())).body as Availability).version).toBe(4);
    expect((await read()).version).toBe(4);
  });

  test('a PUT replaces everything: nothing of the hours before is left', async () => {
    expectSuccess(putRoute, await put(1, sampleHours()), 200);
    const bare = { ...sampleHours(), timeZone: 'UTC', rules: [], exceptions: [] };
    expectSuccess(putRoute, await put(2, bare), 200);
    expect(await read()).toEqual({ version: 3, ...bare });
  });

  test('the first PUT names version 1; any other tag is 412 availability_changed', async () => {
    const early = await put(2, sampleHours());
    expectProblem(putRoute, early, 412, 'availability_changed');
    expect((early.body as { detail?: string }).detail).toBe('availability changed: expected 2, found 1');
    expect((await read()).version).toBe(1);

    expectSuccess(putRoute, await put(1, sampleHours()), 200);
    for (const stale of [1, 3, 99]) {
      expectProblem(putRoute, await put(stale, sampleHours()), 412, 'availability_changed');
    }
    expect((await read()).version).toBe(2);
  });

  test('of two PUTs made from the same version one wins (as in the TypeScript API)', async () => {
    const [first, second] = await Promise.all([put(1, sampleHours()), put(1, { ...sampleHours(), rules: [] })]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 412]);
    const loser = first.status === 412 ? first : second;
    expectProblem(putRoute, loser, 412, 'availability_changed');
    expect((await read()).version).toBe(2);
  });

  test('a 412 is not stored for its key: the same key succeeds once the tag is right', async () => {
    const key = newIdempotencyKey();
    expectProblem(putRoute, await put(5, sampleHours(), key), 412, 'availability_changed');
    expectSuccess(putRoute, await put(1, sampleHours(), key), 200);
    // And then the key replays that success, whatever tag comes with it.
    const replay = await put(5, sampleHours(), key);
    expectSuccess(putRoute, replay, 200);
    expect((replay.body as Availability).version).toBe(2);
    expect((await read()).version).toBe(2);
  });
});

describe('putAvailability: what the contract refuses (400)', () => {
  test.each([
    ['weekday 0', ['rules', 0, 'weekday'], 0],
    ['weekday 8', ['rules', 0, 'weekday'], 8],
    ['a start at 24:00', ['rules', 0, 'startLocal'], '24:00'],
    ['an end after 24:00', ['rules', 0, 'endLocal'], '24:01'],
    ['a time without a leading zero', ['rules', 0, 'startLocal'], '9:00'],
    ['the kind `rest`', ['rules', 0, 'kind'], 'rest'],
    ['a date the calendar does not have', ['exceptions', 0, 'date'], '2026-02-30'],
    ['an unknown exception kind', ['exceptions', 0, 'kind'], 'holiday'],
    ['a negative limit', ['prefs', 'breakMin'], -1],
    ['a limit above 100000', ['prefs', 'maxDailyFocusMin'], 100_001],
    ['a day that starts at 24:00', ['prefs', 'dayStartLocal'], '24:00'],
    ['an unknown risk level', ['prefs', 'riskLevel'], 'p95'],
    ['a zone outside the tz database', ['timeZone'], 'Mars/Olympus_Mons'],
  ] as const)('%s', async (_name, path, value) => {
    const response = await put(1, hoursWith(path, value));
    expectProblem(putRoute, response, 400, 'validation_failed');
    expect((await read()).version).toBe(1);
  });

  test('50 windows and 400 exceptions are accepted, one more of either is not', async () => {
    const window = { weekday: 2, startLocal: '09:00', endLocal: '10:00', kind: 'work' };
    const dayOff = { date: '2026-12-25', kind: 'off' };
    const many = (rules: number, exceptions: number): Record<string, unknown> => ({
      ...sampleHours(),
      rules: Array.from({ length: rules }, () => window),
      exceptions: Array.from({ length: exceptions }, () => dayOff),
    });
    expectProblem(putRoute, await put(1, many(51, 0)), 400, 'validation_failed');
    expectProblem(putRoute, await put(1, many(0, 401)), 400, 'validation_failed');
    const full = await put(1, many(50, 400));
    expectSuccess(putRoute, full, 200);
    const stored = await read();
    expect([stored.rules.length, stored.exceptions.length]).toEqual([50, 400]);
  });
});

describe('putAvailability: the rules between values (422)', () => {
  // The contract checks each value; it cannot say that a window ends after
  // it starts. The reference leaves that to CHECK constraints of its
  // database and answers their failure as 500. The core answers 422.
  test.each([
    ['a window that ends when it starts', ['rules', 1, 'endLocal'], '09:00', '/rules/1/endLocal'],
    ['a window that ends before it starts', ['rules', 0, 'endLocal'], '08:00', '/rules/0/endLocal'],
    ['an exception window that ends before it starts', ['exceptions', 1, 'endLocal'], '09:59', '/exceptions/1/endLocal'],
  ] as const)('%s', async (_name, path, value, pointer) => {
    const response = await put(1, hoursWith(path, value));
    expectProblem(putRoute, response, 422, 'validation_failed');
    expect(errorsOf(response)).toEqual([{ path: pointer, message: 'endLocal must be after startLocal' }]);
    expect(await read()).toMatchObject({ version: 1, rules: [], exceptions: [] });
  });

  test('an extra day needs its window; a day off does not, and may name one side', async () => {
    const extraWithout = hoursWith(['exceptions', 1], { date: '2026-11-21', kind: 'extra' });
    const refused = await put(1, extraWithout);
    expectProblem(putRoute, refused, 422, 'validation_failed');
    expect(errorsOf(refused)).toEqual([
      { path: '/exceptions/1/startLocal', message: 'an extra day needs startLocal and endLocal' },
    ]);
    const halfExtra = hoursWith(['exceptions', 1], { date: '2026-11-21', kind: 'extra', startLocal: '10:00' });
    expect(errorsOf(await put(1, halfExtra))).toEqual([
      { path: '/exceptions/1/endLocal', message: 'an extra day needs startLocal and endLocal' },
    ]);

    const halfOff = hoursWith(['exceptions', 0], { date: '2026-12-25', kind: 'off', startLocal: '09:00' });
    expectSuccess(putRoute, await put(1, halfOff), 200);
    expect((await read()).exceptions).toContainEqual({ date: '2026-12-25', kind: 'off', startLocal: '09:00' });
  });

  test('every broken rule is reported, and the valid windows next to it are not kept', async () => {
    const hours = {
      ...sampleHours(),
      rules: [
        { weekday: 1, startLocal: '09:00', endLocal: '12:00', kind: 'work' },
        { weekday: 2, startLocal: '18:00', endLocal: '09:00', kind: 'work' },
        { weekday: 3, startLocal: '10:00', endLocal: '10:00', kind: 'focus' },
      ],
    };
    const response = await put(1, hours);
    expectProblem(putRoute, response, 422, 'validation_failed');
    expect((errorsOf(response) as { path: string }[]).map((issue) => issue.path)).toEqual([
      '/rules/1/endLocal',
      '/rules/2/endLocal',
    ]);
    expect((await read()).rules).toEqual([]);
  });

  test('a 422 is stored for its key and replayed; a stale tag is told before the rules', async () => {
    const inverted = hoursWith(['rules', 0, 'endLocal'], '08:00');
    const key = newIdempotencyKey();
    const first = await put(1, inverted, key);
    expectProblem(putRoute, first, 422, 'validation_failed');
    // The stored answer comes back whole, with the trace id of the request
    // that produced it.
    const replay = await put(1, inverted, key);
    expect(replay.status).toBe(422);
    expect(replay.body).toEqual(first.body);
    // The same key with other hours is a different request.
    expectProblem(putRoute, await put(1, sampleHours(), key), 422, 'idempotency_mismatch');
    // With an old tag the answer is 412: the client's picture is old.
    expectProblem(putRoute, await put(7, inverted), 412, 'availability_changed');
  });

  test('messages name the rule and never repeat a value', async () => {
    const response = await put(1, hoursWith(['rules', 0, 'endLocal'], '03:17'));
    expect(JSON.stringify(response.body)).not.toContain('03:17');
  });
});
