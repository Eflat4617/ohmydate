/**
 * Appointments (RC-20) — `listCommitments`, `createCommitment`,
 * `updateCommitment`, `deleteCommitment` — and `listCalendarDayEvents`: the
 * rules the generic suite cannot know.
 *
 * `services/api/test/planning.test.ts` ("commitments CRUD expands rrules and
 * bumps availability_version") pins the reference's side; the expansion
 * itself is compared with the reference record by record in
 * `core/crates/recurrence/tests/oracle.rs`.
 *
 * Not here: an appointment imported from Google Calendar answers 409
 * `illegal_transition` to a change or a delete. No request can create one
 * before the calendar sync exists (RC-90), so that rule is tested where the
 * row can be written: `core/crates/app/src/commitments.rs` and
 * `core/crates/server/tests/http.rs`.
 */
import type { Availability, Commitment, CommitmentPage } from '@ohmydate/contracts';
import { API_PREFIX, UNKNOWN_ID, expectProblem, expectSuccess, routeById } from './support/contract.js';
import { startCore, type Core, type CoreResponse } from './support/core.js';
import { createCommitment, newIdempotencyKey, sampleCommitment, sampleWindow, weekInstant } from './support/routes.js';

let core: Core;

beforeEach(async () => {
  core = await startCore();
});

afterEach(async () => {
  await core.dispose();
});

const listRoute = routeById('listCommitments');
const createRoute = routeById('createCommitment');
const updateRoute = routeById('updateCommitment');
const deleteRoute = routeById('deleteCommitment');
const dayEventsRoute = routeById('listCalendarDayEvents');
const PATH = `${API_PREFIX}/commitments`;

function create(body: unknown, key: string = newIdempotencyKey()): Promise<CoreResponse> {
  return core.request('POST', PATH, { headers: { 'idempotency-key': key }, body });
}

function patch(id: string, version: number, body: unknown, key: string = newIdempotencyKey()): Promise<CoreResponse> {
  return core.request('PATCH', `${PATH}/${id}`, {
    headers: { 'if-match': `W/"${version}"`, 'idempotency-key': key },
    body,
  });
}

function remove(id: string, version: number): Promise<CoreResponse> {
  return core.request('DELETE', `${PATH}/${id}`, {
    headers: { 'if-match': `W/"${version}"`, 'idempotency-key': newIdempotencyKey() },
  });
}

async function list(query: string = sampleWindow()): Promise<CommitmentPage> {
  const response = await core.request('GET', `${PATH}?${query}`);
  expectSuccess(listRoute, response, 200);
  return response.body as CommitmentPage;
}

async function availabilityVersion(): Promise<number> {
  const response = await core.request('GET', `${API_PREFIX}/availability`);
  return (response.body as Availability).version;
}

function errorsOf(response: CoreResponse): { path: string; message: string }[] {
  return (response.body as { errors?: { path: string; message: string }[] }).errors ?? [];
}

/** An appointment that happens once: one hour at 05:00 UTC, `days` after this week's Monday. */
function single(title: string, days: number): Record<string, unknown> {
  return { title, startAt: weekInstant(days), endAt: weekInstant(days, 1), timeZone: 'UTC' };
}

/** `YYYY-MM-DDTHH:MM:SSZ`: how the reference prints an instant a rule gave. */
function short(instant: string): string {
  return instant.replace('.000Z', 'Z');
}

describe('createCommitment', () => {
  test('answers the appointment as written, as version 1 from `manual`', async () => {
    const response = await create(sampleCommitment());
    expectSuccess(createRoute, response, 201);
    const created = response.body as Commitment;
    expect(response.headers.get('etag')).toBe('W/"1"');
    expect(created).toEqual({
      ...sampleCommitment(),
      id: created.id,
      ownerId: created.ownerId,
      source: 'manual',
      version: 1,
      createdAt: created.createdAt,
      updatedAt: created.createdAt,
    });
    // `occurrences` belongs to the list.
    expect(created).not.toHaveProperty('occurrences');
    const me = await core.request('GET', `${API_PREFIX}/me`);
    expect(created.ownerId).toBe((me.body as { id: string }).id);
  });

  test('instants are normalised to UTC milliseconds; a writable source is kept', async () => {
    const response = await create({
      title: 'Offset',
      startAt: '2030-03-10T09:00:00+09:00',
      endAt: '2030-03-10T10:30:00.5+09:00',
      timeZone: 'Asia/Seoul',
      source: 'caldav',
    });
    expectSuccess(createRoute, response, 201);
    expect(response.body).toMatchObject({
      startAt: '2030-03-10T00:00:00.000Z',
      endAt: '2030-03-10T01:30:00.500Z',
      source: 'caldav',
    });
  });

  test.each([
    ['a rule outside the subset', { rrule: 'FREQ=HOURLY' }, '/rrule', 'Unsupported RRULE FREQ'],
    ['a part outside the subset', { rrule: 'FREQ=DAILY;BYSETPOS=1' }, '/rrule', 'Unsupported RRULE part'],
    ['BYDAY without WEEKLY', { rrule: 'FREQ=DAILY;BYDAY=MO' }, '/rrule', 'RRULE BYDAY is only supported with FREQ=WEEKLY'],
    ['COUNT and UNTIL together', { rrule: 'FREQ=DAILY;COUNT=2;UNTIL=20301231' }, '/rrule', 'RRULE COUNT and UNTIL are mutually exclusive'],
    ['a COUNT above 1000', { rrule: 'FREQ=DAILY;COUNT=1001' }, '/rrule', 'RRULE COUNT must be at most 1000'],
    ['an end at the start', { endAt: weekInstant(8) }, '/endAt', 'commitment endAt must be after startAt'],
    ['an end before the start', { endAt: weekInstant(7) }, '/endAt', 'commitment endAt must be after startAt'],
    ['a start more than ten years back', { startAt: '2001-01-01T00:00:00Z' }, '/startAt', 'commitment starts more than ten years before now'],
    ['a leap second the schema lets through', { startAt: '2030-06-30T23:59:60Z', endAt: '2030-07-01T01:00:00Z' }, '/startAt', 'invalid instant'],
  ] as const)('422: %s', async (_name, change, path, message) => {
    const response = await create({ ...sampleCommitment(), ...change });
    expectProblem(createRoute, response, 422, 'validation_failed');
    expect(errorsOf(response)).toEqual([{ path, message }]);
    expect((await list()).items).toEqual([]);
    expect(await availabilityVersion()).toBe(1);
  });

  test('a COUNT of 1000 is the most a request may write', async () => {
    expectSuccess(createRoute, await create({ ...sampleCommitment(), rrule: 'FREQ=DAILY;COUNT=1000' }), 201);
  });

  test.each([
    ['a rule that does not start with FREQ=', { rrule: 'COUNT=3;FREQ=DAILY' }],
    ['a rule in lower case', { rrule: 'freq=daily' }],
    ['the source `google`', { source: 'google' }],
    ['an empty title', { title: '' }],
    ['a title of 201 characters', { title: 'x'.repeat(201) }],
    ['a zone outside the tz database', { timeZone: 'Mars/Olympus_Mons' }],
    ['an instant without a zone', { startAt: '2030-03-10T09:00:00' }],
  ] as const)('400 from the contract: %s', async (_name, change) => {
    expectProblem(createRoute, await create({ ...sampleCommitment(), ...change }), 400, 'validation_failed');
  });

  test('a refused rule is named by its fault and never repeated', async () => {
    const response = await create({ ...sampleCommitment(), rrule: 'FREQ=DAILY;PASSPHRASE=hunter2' });
    expectProblem(createRoute, response, 422, 'validation_failed');
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('PASSPHRASE');
  });

  test('a 422 is stored for its key and replayed', async () => {
    const key = newIdempotencyKey();
    const body = { ...sampleCommitment(), rrule: 'FREQ=HOURLY' };
    const first = await create(body, key);
    const replay = await create(body, key);
    expect([first.status, replay.status]).toEqual([422, 422]);
    expect(replay.body).toEqual(first.body);
    expectProblem(createRoute, await create(sampleCommitment(), key), 422, 'idempotency_mismatch');
  });
});

describe('the availability version', () => {
  test('every create, change and delete of an appointment is one version (as in the TypeScript API)', async () => {
    expect(await availabilityVersion()).toBe(1);
    const created = await createCommitment(core);
    expect(await availabilityVersion()).toBe(2);
    expectSuccess(updateRoute, await patch(created.id, 1, { title: 'Renamed seminar' }), 200);
    expect(await availabilityVersion()).toBe(3);
    // A patch that names nothing is still a change of the appointment.
    expectSuccess(updateRoute, await patch(created.id, 2, {}), 200);
    expect(await availabilityVersion()).toBe(4);
    expectSuccess(deleteRoute, await remove(created.id, 3), 204);
    expect(await availabilityVersion()).toBe(5);
    const read = await core.request('GET', `${API_PREFIX}/availability`);
    expect(read.headers.get('etag')).toBe('W/"availability:5"');
  });

  test('a refused or replayed request is not a change', async () => {
    const created = await createCommitment(core);
    expectProblem(updateRoute, await patch(created.id, 9, { title: 'x' }), 412, 'version_conflict');
    expectProblem(updateRoute, await patch(created.id, 1, { rrule: 'FREQ=HOURLY' }), 422, 'validation_failed');
    expectProblem(deleteRoute, await remove(UNKNOWN_ID, 1), 404, 'not_found');
    const key = newIdempotencyKey();
    expectSuccess(updateRoute, await patch(created.id, 1, { title: 'Once' }, key), 200);
    expectSuccess(updateRoute, await patch(created.id, 1, { title: 'Once' }, key), 200);
    expect(await availabilityVersion()).toBe(3);
  });

  test('hours set before an appointment must name the version the appointment made', async () => {
    const hours = {
      timeZone: 'Asia/Seoul',
      rules: [],
      exceptions: [],
      prefs: { maxDailyFocusMin: 240, breakAfterMin: 60, breakMin: 15, dayStartLocal: '08:00', dayEndLocal: '18:00', riskLevel: 'p50' },
    };
    const put = (version: number): Promise<CoreResponse> =>
      core.request('PUT', `${API_PREFIX}/availability`, {
        headers: { 'if-match': `W/"availability:${version}"`, 'idempotency-key': newIdempotencyKey() },
        body: hours,
      });
    await createCommitment(core);
    expectProblem(routeById('putAvailability'), await put(1), 412, 'availability_changed');
    expectSuccess(routeById('putAvailability'), await put(2), 200);
    expect(await availabilityVersion()).toBe(3);
  });
});

describe('listCommitments', () => {
  test('a rule gives the occurrences inside the window, printed as the reference prints them', async () => {
    const weekly = await createCommitment(core);
    const once = await createCommitment(core, single('Dentist', 3));
    const page = await list();
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual([weekly.id, once.id]);
    // Tuesdays of next week and the week after, inside three weeks from Monday.
    expect(page.items[0]?.occurrences).toEqual([
      { commitmentId: weekly.id, startAt: short(weekInstant(8)), endAt: short(weekInstant(8, 2)) },
      { commitmentId: weekly.id, startAt: short(weekInstant(15)), endAt: short(weekInstant(15, 2)) },
    ]);
    // An appointment that happens once is its own stored instants.
    expect(page.items[1]?.occurrences).toEqual([
      { commitmentId: once.id, startAt: weekInstant(3), endAt: weekInstant(3, 1) },
    ]);
  });

  test('a recurring appointment is listed with no occurrence where it has none; a single one is not', async () => {
    const weekly = await createCommitment(core);
    await createCommitment(core, single('Dentist', 3));
    // The Wednesday and Thursday after the first Tuesday.
    const between = await list(`from=${weekInstant(9, -5)}&to=${weekInstant(11, -5)}`);
    expect(between.items.map((item) => [item.id, item.occurrences])).toEqual([[weekly.id, []]]);
  });

  test('the window is half-open at both ends', async () => {
    const once = await createCommitment(core, single('Dentist', 3));
    const ids = async (from: string, to: string): Promise<string[]> =>
      (await list(`from=${from}&to=${to}`)).items.map((item) => item.id);
    // 05:00–06:00. Ending where the window starts, starting where it ends: outside.
    expect(await ids(weekInstant(3, 1), weekInstant(3, 2))).toEqual([]);
    expect(await ids(weekInstant(3, -1), weekInstant(3))).toEqual([]);
    expect(await ids(weekInstant(3, -1), weekInstant(3, 2))).toEqual([once.id]);
  });

  test('occurrences keep their wall-clock time across a clock change', async () => {
    // Sundays 09:00 in New York; the clocks go back on 4 November 2029.
    await createCommitment(core, {
      title: 'Brunch',
      startAt: '2029-10-28T13:00:00Z',
      endAt: '2029-10-28T14:00:00Z',
      timeZone: 'America/New_York',
      rrule: 'FREQ=WEEKLY',
    });
    const page = await list('from=2029-10-28T00:00:00Z&to=2029-11-12T00:00:00Z');
    expect(page.items[0]?.occurrences?.map((occurrence) => occurrence.startAt)).toEqual([
      '2029-10-28T13:00:00Z',
      '2029-11-04T14:00:00Z',
      '2029-11-11T14:00:00Z',
    ]);
  });

  test('pages are in id order; a full page names its last id as the cursor', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push((await createCommitment(core, single(`appointment ${index}`, 3))).id);
    }
    const first = await list(`${sampleWindow()}&limit=2`);
    expect(first.items.map((item) => item.id)).toEqual(ids.slice(0, 2));
    expect(first.nextCursor).toBe(ids[1]);
    const second = await list(`${sampleWindow()}&limit=2&cursor=${first.nextCursor}`);
    expect(second.items.map((item) => item.id)).toEqual(ids.slice(2, 4));
    const third = await list(`${sampleWindow()}&limit=2&cursor=${second.nextCursor}`);
    expect(third.items.map((item) => item.id)).toEqual(ids.slice(4));
    expect(third.nextCursor).toBeNull();
    // Without `limit` a page holds 20.
    expect((await list()).items).toHaveLength(5);
  });

  test.each([
    ['`from` off the minute', `from=${weekInstant(0).replace(':00.000Z', ':30Z')}&to=${weekInstant(7)}`, '/from', 'instant must have minute precision'],
    ['`to` off the minute', `from=${weekInstant(0)}&to=${weekInstant(7).replace('.000Z', '.001Z')}`, '/to', 'instant must have minute precision'],
    ['a window of 366 days and a minute', 'from=2030-01-01T00:00:00Z&to=2031-01-02T00:01:00Z', '/to', 'commitment range exceeds 366 days'],
    ['a cursor that is not an id', `${sampleWindow()}&cursor=nonsense`, 'cursor', 'invalid list cursor'],
  ] as const)('422: %s', async (_name, query, path, message) => {
    const response = await core.request('GET', `${PATH}?${query}`);
    expectProblem(listRoute, response, 422, 'validation_failed');
    expect(errorsOf(response)).toEqual([{ path, message }]);
  });

  test('a window of exactly 366 days is accepted', async () => {
    await createCommitment(core, { ...sampleCommitment(), startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z', rrule: 'FREQ=DAILY' });
    const page = await list('from=2030-01-01T00:00:00Z&to=2031-01-02T00:00:00Z');
    expect(page.items[0]?.occurrences).toHaveLength(366);
  });

  test('a page holds at most 2000 occurrences in all', async () => {
    const daily = { ...sampleCommitment(), startAt: '2030-01-01T09:00:00Z', endAt: '2030-01-01T10:00:00Z', rrule: 'FREQ=DAILY' };
    for (let index = 0; index < 6; index += 1) await createCommitment(core, { ...daily, title: `daily ${index}` });
    const year = 'from=2030-01-01T00:00:00Z&to=2031-01-02T00:00:00Z';
    const whole = await core.request('GET', `${PATH}?${year}`);
    expectProblem(listRoute, whole, 422, 'validation_failed');
    expect(errorsOf(whole)).toEqual([{ path: '/to', message: 'commitments expand to more than 2000 occurrences' }]);
    // Five of them are 1,830 occurrences: a smaller page of the same window passes.
    expect((await list(`${year}&limit=5`)).items).toHaveLength(5);
  });

  test('a window that does not run forward is noticed only when an appointment is expanded (as in the reference)', async () => {
    const backwards = `from=${weekInstant(7)}&to=${weekInstant(0)}`;
    expect((await list(backwards)).items).toEqual([]);
    await createCommitment(core);
    const response = await core.request('GET', `${PATH}?${backwards}`);
    expectProblem(listRoute, response, 422, 'validation_failed');
    expect(errorsOf(response)).toEqual([{ path: '/rrule', message: 'occurrence range is not a valid interval' }]);
  });
});

describe('updateCommitment', () => {
  test('a patch changes what it names; `rrule: null` removes the rule', async () => {
    const created = (await create(sampleCommitment())).body as Commitment;
    const renamed = await patch(created.id, 1, { title: 'Renamed seminar' });
    expectSuccess(updateRoute, renamed, 200);
    expect(renamed.headers.get('etag')).toBe('W/"2"');
    expect(renamed.body).toEqual({
      ...created,
      title: 'Renamed seminar',
      version: 2,
      updatedAt: (renamed.body as Commitment).updatedAt,
    });

    const moved = await patch(created.id, 2, {
      startAt: weekInstant(9),
      endAt: weekInstant(9, 1),
      timeZone: 'Europe/Berlin',
      rrule: null,
      source: 'vikunja',
    });
    expectSuccess(updateRoute, moved, 200);
    const body = moved.body as Commitment;
    expect(body).not.toHaveProperty('rrule');
    expect(body).toMatchObject({
      title: 'Renamed seminar',
      startAt: weekInstant(9),
      endAt: weekInstant(9, 1),
      timeZone: 'Europe/Berlin',
      source: 'vikunja',
      version: 3,
      createdAt: created.createdAt,
    });
    // The list shows the appointment as it is now: once, on its new day.
    const page = await list();
    expect(page.items[0]?.occurrences).toEqual([
      { commitmentId: created.id, startAt: weekInstant(9), endAt: weekInstant(9, 1) },
    ]);
  });

  test('one end of the interval alone is judged against the stored other', async () => {
    const created = await createCommitment(core);
    for (const body of [{ endAt: weekInstant(8) }, { endAt: weekInstant(7) }, { startAt: weekInstant(8, 2) }]) {
      const response = await patch(created.id, 1, body);
      expectProblem(updateRoute, response, 422, 'validation_failed');
      expect(errorsOf(response)).toEqual([{ path: '/endAt', message: 'commitment endAt must be after startAt' }]);
    }
    expectSuccess(updateRoute, await patch(created.id, 1, { endAt: weekInstant(8, 1) }), 200);
  });

  test('the answers come in the order of the reference: the patch, then 404, then 412', async () => {
    const created = await createCommitment(core);
    const badRule = { rrule: 'FREQ=HOURLY' };
    // A patch that is refused on its own is 422 whatever it is aimed at.
    expectProblem(updateRoute, await patch(UNKNOWN_ID, 1, badRule), 422, 'validation_failed');
    expectProblem(updateRoute, await patch(created.id, 9, badRule), 422, 'validation_failed');
    expectProblem(updateRoute, await patch(created.id, 9, { startAt: '2001-01-01T00:00:00Z' }), 422, 'validation_failed');
    // A patch that could be applied: missing, then stale.
    expectProblem(updateRoute, await patch(UNKNOWN_ID, 1, { title: 'x' }), 404, 'not_found');
    const stale = await patch(created.id, 9, { title: 'x' });
    expectProblem(updateRoute, stale, 412, 'version_conflict');
    expect((stale.body as { detail?: string }).detail).toBe('expected version 9 but found 1');
    // The merged interval is judged last: with a stale tag the answer is 412.
    expectProblem(updateRoute, await patch(created.id, 9, { endAt: weekInstant(7) }), 412, 'version_conflict');
  });

  test('a source no request may name, and a start that is too old, are refused', async () => {
    const created = await createCommitment(core);
    expectProblem(updateRoute, await patch(created.id, 1, { source: 'google' }), 400, 'validation_failed');
    const old = await patch(created.id, 1, { startAt: '2001-01-01T00:00:00Z', endAt: '2001-01-01T01:00:00Z' });
    expectProblem(updateRoute, old, 422, 'validation_failed');
    expect(errorsOf(old)[0]?.path).toBe('/startAt');
  });
});

describe('deleteCommitment', () => {
  test('a deleted appointment is gone from the list and cannot be reached again', async () => {
    const created = await createCommitment(core);
    expectProblem(deleteRoute, await remove(created.id, 4), 412, 'version_conflict');
    const deleted = await remove(created.id, 1);
    expectSuccess(deleteRoute, deleted, 204);
    expect(deleted.body).toBeUndefined();
    expect((await list()).items).toEqual([]);
    expectProblem(deleteRoute, await remove(created.id, 2), 404, 'not_found');
    expectProblem(updateRoute, await patch(created.id, 2, { title: 'x' }), 404, 'not_found');
  });

  test('deleting one appointment leaves the others', async () => {
    const first = await createCommitment(core, single('first', 3));
    const second = await createCommitment(core, single('second', 3));
    expectSuccess(deleteRoute, await remove(first.id, 1), 204);
    expect((await list()).items.map((item) => item.id)).toEqual([second.id]);
  });
});

describe('appointments survive a restart', () => {
  test('the list, the versions and the availability version are the same after the process starts again', async () => {
    const created = await createCommitment(core);
    const before = await list();
    await core.stop();
    const restarted = await startCore({ dataDir: core.dataDir });
    try {
      const response = await restarted.request('GET', `${PATH}?${sampleWindow()}`);
      expect(response.body).toEqual(before);
      const hours = await restarted.request('GET', `${API_PREFIX}/availability`);
      expect((hours.body as Availability).version).toBe(2);
      const renamed = await restarted.request('PATCH', `${PATH}/${created.id}`, {
        headers: { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() },
        body: { title: 'After the restart' },
      });
      expect(renamed.status).toBe(200);
    } finally {
      await restarted.stop();
    }
  });
});

describe('listCalendarDayEvents', () => {
  const days = (query: string): Promise<CoreResponse> =>
    core.request('GET', `${API_PREFIX}/calendar-day-events?${query}`);

  test('without a connected calendar every range is an empty list', async () => {
    for (const query of ['from=2026-11-01&to=2026-11-30', 'from=2026-11-16&to=2026-11-16', 'from=2026-01-01&to=2026-04-03']) {
      const response = await days(query);
      expectSuccess(dayEventsRoute, response, 200);
      expect(response.body).toEqual({ items: [] });
    }
  });

  test('an appointment is not a day event', async () => {
    await createCommitment(core, { title: 'All day', startAt: '2030-03-10T00:00:00Z', endAt: '2030-03-11T00:00:00Z', timeZone: 'UTC' });
    expect((await days('from=2030-03-01&to=2030-03-31')).body).toEqual({ items: [] });
  });

  test.each([
    ['`to` before `from`', 'from=2026-11-02&to=2026-11-01', 'to must not be before from'],
    ['93 days between the ends', 'from=2026-01-01&to=2026-04-04', 'range exceeds 92 days'],
  ] as const)('422: %s', async (_name, query, message) => {
    const response = await days(query);
    expectProblem(dayEventsRoute, response, 422, 'validation_failed');
    expect(errorsOf(response)).toEqual([{ path: '/to', message }]);
  });

  test.each([
    ['a date the calendar does not have', 'from=2026-02-30&to=2026-03-01'],
    ['an instant where a date belongs', 'from=2026-11-01T00:00:00Z&to=2026-11-30'],
    ['a parameter the contract does not have', 'from=2026-11-01&to=2026-11-30&calendar=all'],
  ] as const)('400 from the contract: %s', async (_name, query) => {
    expectProblem(dayEventsRoute, await days(query), 400, 'validation_failed');
  });
});
