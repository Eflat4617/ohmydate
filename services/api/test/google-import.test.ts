import { randomUUID } from 'node:crypto';
import { CalendarDayEventPageSchema, type Plan } from '@ohmydate/contracts';
import type { Id, Instant } from '@ohmydate/domain';
import {
  classifyEvent,
  cutTitle,
  defaultSelected,
  diffCommitments,
  importWindow,
  removalWindow,
} from '../src/application/google-import.js';
import type { ImportedCommitmentRow } from '../src/application/google-calendar-ports.js';
import {
  FakeGoogle,
  ManualScheduler,
  TEST_WEB_ORIGIN,
  allDayEvent,
  testGoogleSecrets,
  timedEvent,
} from './support/google-fakes.js';
import { compile } from './support/schemas.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const CONTEXT = { calendarTimeZone: 'Asia/Seoul', ownerTimeZone: 'UTC', locale: 'ko-KR' };

describe('import classification (pure)', () => {
  test('a timed event becomes a 약속 rounded outward to whole minutes in its own zone', () => {
    const result = classifyEvent(
      timedEvent('e1', '2026-01-02T10:00:30+09:00', '2026-01-02T11:00:10+09:00', {
        start: { dateTime: '2026-01-02T10:00:30+09:00', timeZone: 'Europe/Berlin' },
      }),
      CONTEXT,
    );
    expect(result).toEqual({
      kind: 'timed',
      values: {
        externalEventId: 'e1',
        etag: '"e1-1"',
        title: 'event e1',
        startAt: '2026-01-02T01:00:00.000Z',
        endAt: '2026-01-02T02:01:00.000Z',
        timeZone: 'Europe/Berlin',
      },
    });
  });

  test('the zone falls back from the event to the calendar to the owner', () => {
    const noZone = timedEvent('e2', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', {
      start: { dateTime: '2026-01-02T10:00:00Z' },
    });
    expect(classifyEvent(noZone, CONTEXT)).toMatchObject({ values: { timeZone: 'Asia/Seoul' } });
    expect(classifyEvent(noZone, { ...CONTEXT, calendarTimeZone: 'Not/AZone' })).toMatchObject({
      values: { timeZone: 'UTC' },
    });
  });

  test('an all-day event becomes a day event with an exclusive end date', () => {
    expect(classifyEvent(allDayEvent('d1', '2026-03-01', '2026-03-03'), CONTEXT)).toEqual({
      kind: 'day',
      values: { externalEventId: 'd1', etag: '"d1-1"', title: 'day d1', startDate: '2026-03-01', endDate: '2026-03-03' },
    });
  });

  test('cancelled, declined, transparent, working-location, zero-length and malformed events are skipped', () => {
    const base = timedEvent('x', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z');
    expect(classifyEvent({ ...base, status: 'cancelled' }, CONTEXT)).toEqual({ kind: 'skip', reason: 'cancelled' });
    expect(
      classifyEvent(
        { ...base, attendees: [{ self: false, responseStatus: 'accepted' }, { self: true, responseStatus: 'declined' }] },
        CONTEXT,
      ),
    ).toEqual({ kind: 'skip', reason: 'declined' });
    expect(classifyEvent({ ...base, attendees: [{ self: true, responseStatus: 'tentative' }] }, CONTEXT).kind).toBe('timed');
    expect(classifyEvent({ ...base, transparency: 'transparent' }, CONTEXT)).toEqual({ kind: 'skip', reason: 'transparent' });
    expect(classifyEvent({ ...base, eventType: 'workingLocation' }, CONTEXT)).toEqual({
      kind: 'skip',
      reason: 'working_location',
    });
    expect(
      classifyEvent(timedEvent('z', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'), CONTEXT),
    ).toEqual({ kind: 'skip', reason: 'zero_length' });
    expect(classifyEvent({ ...base, start: { dateTime: 'soon' } }, CONTEXT)).toEqual({ kind: 'skip', reason: 'malformed' });
    expect(classifyEvent({ ...base, start: { date: '2026-02-30' } }, CONTEXT)).toEqual({ kind: 'skip', reason: 'malformed' });
  });

  test('titles are cut to 200 code points; an empty title is neutral in the owner language', () => {
    const long = '가'.repeat(150) + '😀'.repeat(100);
    const cut = cutTitle(long, 'x');
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith('😀')).toBe(true);
    const empty = timedEvent('e', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', { summary: '   ' });
    expect(classifyEvent(empty, CONTEXT)).toMatchObject({ values: { title: '(제목 없음)' } });
    expect(classifyEvent({ ...empty, summary: undefined }, { ...CONTEXT, locale: 'en-US' })).toMatchObject({
      values: { title: '(No title)' },
    });
  });

  test('default selection: owned and public holiday calendars, never an "OhMyDate" calendar', () => {
    expect(defaultSelected({ googleCalendarId: 'me@example.test', accessRole: 'owner', name: 'me' })).toBe(true);
    expect(
      defaultSelected({
        googleCalendarId: 'ko.south_korea#holiday@group.v.calendar.google.com',
        accessRole: 'reader',
        name: '대한민국의 휴일',
      }),
    ).toBe(true);
    expect(defaultSelected({ googleCalendarId: 'team@group.calendar.google.com', accessRole: 'reader', name: '팀' })).toBe(false);
    expect(defaultSelected({ googleCalendarId: 'old@group.calendar.google.com', accessRole: 'owner', name: 'OhMyDate' })).toBe(
      false,
    );
  });

  test('diff: unchanged rows untouched, changed rows updated, removals only inside the window and only when complete', () => {
    const window = removalWindow(importWindow('2026-01-01T00:00:00.000Z' as Instant, 180), 'UTC');
    const row = (id: string, start: string, end: string, title = `event ${id}`): ImportedCommitmentRow => ({
      id: randomUUID() as Id,
      externalCalendarId: 'cal',
      externalEventId: id,
      title,
      startAt: start as Instant,
      endAt: end as Instant,
      timeZone: 'UTC',
      version: 1,
    });
    const existing = [
      row('same', '2026-01-05T10:00:00.000Z', '2026-01-05T11:00:00.000Z'),
      row('moved', '2026-01-06T10:00:00.000Z', '2026-01-06T11:00:00.000Z'),
      row('gone', '2026-01-07T10:00:00.000Z', '2026-01-07T11:00:00.000Z'),
      row('past', '2025-11-01T10:00:00.000Z', '2025-11-01T11:00:00.000Z'),
    ];
    const incoming = [
      { externalEventId: 'same', etag: null, title: 'event same', startAt: '2026-01-05T10:00:00.000Z' as Instant, endAt: '2026-01-05T11:00:00.000Z' as Instant, timeZone: 'UTC' },
      { externalEventId: 'moved', etag: null, title: 'event moved', startAt: '2026-01-06T12:00:00.000Z' as Instant, endAt: '2026-01-06T13:00:00.000Z' as Instant, timeZone: 'UTC' },
      { externalEventId: 'new', etag: null, title: 'event new', startAt: '2026-01-08T12:00:00.000Z' as Instant, endAt: '2026-01-08T13:00:00.000Z' as Instant, timeZone: 'UTC' },
    ];
    const changes = diffCommitments(existing, incoming, window, true);
    expect(changes.create.map((values) => values.externalEventId)).toEqual(['new']);
    expect(changes.update.map((change) => change.row.externalEventId)).toEqual(['moved']);
    expect(changes.remove.map((entry) => entry.externalEventId)).toEqual(['gone']);
    expect(diffCommitments(existing, incoming, window, false).remove).toEqual([]);
  });
});

const AVAILABILITY_BODY = {
  timeZone: 'UTC',
  rules: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, startLocal: '09:00', endLocal: '18:00', kind: 'work' })),
  exceptions: [],
  prefs: {
    maxDailyFocusMin: 480,
    breakAfterMin: 60,
    breakMin: 15,
    dayStartLocal: '08:00',
    dayEndLocal: '18:00',
    riskLevel: 'p50',
  },
};

describe.skipIf(!hasDatabase)('Google import through the API (CAL-03)', () => {
  let ctx: TestContext;
  let google: FakeGoogle;
  let ownerA: Id;
  let ownerB: Id;
  let sessionA: TestSession;
  const PRIMARY = 'primary@example.test';

  beforeEach(async () => {
    google = new FakeGoogle();
    ctx = await createTestContext({
      google: {
        secrets: testGoogleSecrets(),
        oauth: google,
        calendar: google,
        nudgeScheduler: new ManualScheduler().scheduler,
        maxEventPages: 3,
      },
    });
    ownerA = (await ctx.seedUser({ email: 'import-a@example.com', password: 'correct-horse' })) as Id;
    ownerB = (await ctx.seedUser({ email: 'import-b@example.com', password: 'correct-horse' })) as Id;
    sessionA = await login(ctx, 'import-a@example.com', 'correct-horse');
    // Import only: keeps these tests about import.
    google.grantedScopes = [
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ];
    await connect(sessionA);
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function connect(session: TestSession): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:connect',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    });
    const state = new URL((response.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state');
    const callback = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?code=c&state=${state ?? ''}`,
      headers: { cookie: session.cookie },
    });
    expect(callback.headers['location']).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=connected`);
  }

  async function sync(session: TestSession = sessionA) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:sync',
      headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      imported: { created: number; updated: number; removed: number; dayEvents: number };
    };
  }

  function liveGoogleCommitments(ownerId: Id) {
    return ctx.db
      .selectFrom('commitment_event')
      .select(['id', 'title', 'start_at', 'end_at', 'version', 'external_event_id', 'source'])
      .where('owner_id', '=', ownerId)
      .where('source', '=', 'google')
      .where('deleted_at', 'is', null)
      .orderBy('external_event_id')
      .execute();
  }

  async function availabilityVersion(ownerId: Id): Promise<number> {
    const row = await ctx.db
      .selectFrom('user_availability_version')
      .select('version')
      .where('owner_id', '=', ownerId)
      .executeTakeFirst();
    return row?.version ?? 1;
  }

  test('timed events become 약속, all-day events day events; cancelled/declined/transparent are skipped', async () => {
    google.events.set(PRIMARY, [
      timedEvent('meet', '2026-01-02T10:00:00+09:00', '2026-01-02T11:00:00+09:00', { summary: '치과' }),
      allDayEvent('trip', '2026-01-05', '2026-01-07', { summary: '부산 여행' }),
      timedEvent('cancel', '2026-01-03T10:00:00+09:00', '2026-01-03T11:00:00+09:00', { status: 'cancelled' }),
      timedEvent('declined', '2026-01-03T12:00:00+09:00', '2026-01-03T13:00:00+09:00', {
        attendees: [{ self: true, responseStatus: 'declined' }],
      }),
      timedEvent('free', '2026-01-03T14:00:00+09:00', '2026-01-03T15:00:00+09:00', { transparency: 'transparent' }),
    ]);
    const versionBefore = await availabilityVersion(ownerA);
    const result = await sync();
    expect(result.imported).toEqual({ created: 1, updated: 0, removed: 0, dayEvents: 1 });

    const list = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/commitments?from=2026-01-01T00:00:00Z&to=2026-01-10T00:00:00Z',
      headers: authHeaders(sessionA),
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        title: '치과',
        source: 'google',
        startAt: '2026-01-02T01:00:00.000Z',
        endAt: '2026-01-02T02:00:00.000Z',
        timeZone: 'Asia/Seoul',
      }),
    ]);
    const days = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/calendar-day-events?from=2026-01-01&to=2026-01-31',
      headers: authHeaders(sessionA),
    });
    expect(days.statusCode).toBe(200);
    expect(compile(CalendarDayEventPageSchema)(days.json())).toBe(true);
    expect((days.json() as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ title: '부산 여행', startDate: '2026-01-05', endDate: '2026-01-07', source: 'google', calendarName: 'me@example.test' }),
    ]);
    // A real 약속 change bumps availability_version like a manual write.
    expect(await availabilityVersion(ownerA)).toBe(versionBefore + 1);
  });

  test('paging reads every page; a capped listing removes nothing and reports too_many_events', async () => {
    google.eventPageSize = 2;
    google.events.set(
      PRIMARY,
      ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
        timedEvent(id, `2026-01-0${String(index + 2)}T10:00:00Z`, `2026-01-0${String(index + 2)}T11:00:00Z`),
      ),
    );
    expect((await sync()).imported.created).toBe(5);
    expect(google.callCount('listEvents')).toBe(3);

    google.events.set(
      PRIMARY,
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, index) =>
        timedEvent(id, `2026-01-${String(index + 10)}T10:00:00Z`, `2026-01-${String(index + 10)}T11:00:00Z`),
      ),
    );
    // 7 events / 2 per page with a 3-page cap: incomplete. Rows not seen stay.
    const result = await sync();
    expect(result.imported.removed).toBe(0);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(status.json()).toMatchObject({ lastError: 'too_many_events' });
    // a-f seen (6 of 7 listed), nothing removed.
    expect(await liveGoogleCommitments(ownerA)).toHaveLength(6);
  });

  test('changes update rows, vanished events inside the window are removed, past rows are kept', async () => {
    google.events.set(PRIMARY, [
      timedEvent('keep', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z'),
      timedEvent('move', '2026-01-03T10:00:00Z', '2026-01-03T11:00:00Z'),
      timedEvent('drop', '2026-01-04T10:00:00Z', '2026-01-04T11:00:00Z'),
    ]);
    await sync();
    // A row from long before the listing window (e.g. imported months ago).
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerA,
        title: 'old',
        start_at: new Date('2025-10-01T10:00:00Z'),
        end_at: new Date('2025-10-01T11:00:00Z'),
        time_zone: 'UTC',
        source: 'google',
        external_calendar_id: PRIMARY,
        external_event_id: 'ancient',
      })
      .execute();
    const before = new Map((await liveGoogleCommitments(ownerA)).map((row) => [row.external_event_id, row]));

    google.events.set(PRIMARY, [
      timedEvent('keep', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z'),
      timedEvent('move', '2026-01-03T15:00:00Z', '2026-01-03T16:00:00Z', { summary: '옮긴 약속' }),
    ]);
    const versionBefore = await availabilityVersion(ownerA);
    expect((await sync()).imported).toMatchObject({ created: 0, updated: 1, removed: 1 });
    const after = new Map((await liveGoogleCommitments(ownerA)).map((row) => [row.external_event_id, row]));
    expect([...after.keys()].sort()).toEqual(['ancient', 'keep', 'move']);
    expect(after.get('keep')?.version).toBe(before.get('keep')?.version);
    expect(after.get('move')).toMatchObject({ title: '옮긴 약속', version: (before.get('move')?.version ?? 0) + 1 });
    expect(await availabilityVersion(ownerA)).toBe(versionBefore + 1);
  });

  test('an unchanged sync touches nothing: no row version, no availability version', async () => {
    google.events.set(PRIMARY, [
      timedEvent('a', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z'),
      allDayEvent('d', '2026-01-05', '2026-01-06'),
    ]);
    await sync();
    const rows = await liveGoogleCommitments(ownerA);
    const version = await availabilityVersion(ownerA);
    // A new etag alone (e.g. a description edit at Google) is not a change here.
    google.events.set(PRIMARY, [
      timedEvent('a', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', { etag: '"a-2"' }),
      allDayEvent('d', '2026-01-05', '2026-01-06'),
    ]);
    expect((await sync()).imported).toEqual({ created: 0, updated: 0, removed: 0, dayEvents: 0 });
    expect(await liveGoogleCommitments(ownerA)).toEqual(rows);
    expect(await availabilityVersion(ownerA)).toBe(version);
  });

  test("another owner's rows with the same Google ids are never touched", async () => {
    await ctx.db
      .insertInto('commitment_event')
      .values({
        id: ctx.ids.next(),
        owner_id: ownerB,
        title: 'B 약속',
        start_at: new Date('2026-01-02T10:00:00Z'),
        end_at: new Date('2026-01-02T11:00:00Z'),
        time_zone: 'UTC',
        source: 'google',
        external_calendar_id: PRIMARY,
        external_event_id: 'shared',
      })
      .execute();
    const bBefore = await liveGoogleCommitments(ownerB);
    google.events.set(PRIMARY, [timedEvent('shared', '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z')]);
    await sync();
    google.events.set(PRIMARY, []);
    await sync();
    expect(await liveGoogleCommitments(ownerB)).toEqual(bBefore);
    expect(await liveGoogleCommitments(ownerA)).toEqual([]);
  });

  test('one failing calendar is recorded and the others still import; deselecting removes its rows', async () => {
    google.calendars.push({ id: 'second@example.test', summary: 'second', accessRole: 'owner' });
    google.events.set(PRIMARY, [timedEvent('p', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z')]);
    google.events.set('second@example.test', [timedEvent('s', '2026-01-02T12:00:00Z', '2026-01-02T13:00:00Z')]);
    google.failingCalendars.set(PRIMARY, 'rate_limited');
    const first = await sync();
    expect(first.imported.created).toBe(1);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(status.json()).toMatchObject({ lastError: 'rate_limited' });

    google.failingCalendars.clear();
    await sync();
    expect((await liveGoogleCommitments(ownerA)).map((row) => row.external_event_id).sort()).toEqual(['p', 's']);
    const fresh = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(fresh.json()).toMatchObject({ lastError: null });

    const body = fresh.json() as { calendars: { id: string; name: string }[]; settings: unknown };
    const primary = body.calendars.find((calendar) => calendar.name === 'me@example.test');
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/google/settings',
      headers: authHeaders(sessionA, { 'if-match': fresh.headers['etag'] as string, 'idempotency-key': newIdempotencyKey() }),
      payload: { selectedCalendarIds: [primary?.id], settings: body.settings },
    });
    expect(put.statusCode).toBe(200);
    expect((await sync()).imported.removed).toBe(1);
    expect((await liveGoogleCommitments(ownerA)).map((row) => row.external_event_id)).toEqual(['p']);
  });

  test('CAL-03F: an empty calendar list is a failed step: nothing is replaced or removed', async () => {
    google.calendars.push({ id: 'second@example.test', summary: 'second', accessRole: 'owner' });
    google.events.set(PRIMARY, [
      timedEvent('p', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z'),
      allDayEvent('d', '2026-01-05', '2026-01-06'),
    ]);
    expect((await sync()).imported).toMatchObject({ created: 1, dayEvents: 1 });
    const calendarRows = () =>
      ctx.db
        .selectFrom('google_calendar')
        .select(['id', 'google_calendar_id', 'selected', 'version'])
        .where('owner_id', '=', ownerA)
        .orderBy('google_calendar_id')
        .execute();
    const liveDayEvents = () =>
      ctx.db.selectFrom('calendar_day_event').select(['id', 'version']).where('owner_id', '=', ownerA).where('deleted_at', 'is', null).execute();
    const calendarsBefore = await calendarRows();
    expect(calendarsBefore).toHaveLength(2);
    const commitmentsBefore = await liveGoogleCommitments(ownerA);
    const dayEventsBefore = await liveDayEvents();
    const versionBefore = await availabilityVersion(ownerA);
    const statusBefore = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });

    // Google answers 200 with no calendar at all (an account always has its primary one).
    const listed = google.calendars;
    google.calendars = [];
    const result = await sync();
    expect(result.imported).toEqual({ created: 0, updated: 0, removed: 0, dayEvents: 0 });
    expect(await calendarRows()).toEqual(calendarsBefore);
    expect(await liveGoogleCommitments(ownerA)).toEqual(commitmentsBefore);
    expect(await liveDayEvents()).toEqual(dayEventsBefore);
    expect(await availabilityVersion(ownerA)).toBe(versionBefore);
    expect(google.callCount('listEvents')).toBe(2);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(status.json()).toMatchObject({
      status: 'connected',
      lastError: 'google_rejected',
      calendars: (statusBefore.json() as { calendars: unknown[] }).calendars,
      version: (statusBefore.json() as { version: number }).version,
    });

    // The next good listing imports as before.
    google.calendars = listed;
    expect((await sync()).imported).toEqual({ created: 0, updated: 0, removed: 0, dayEvents: 0 });
    const fresh = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(fresh.json()).toMatchObject({ lastError: null });
  });

  test('clients cannot create a google 약속 nor edit or delete an imported one', async () => {
    google.events.set(PRIMARY, [timedEvent('locked', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z')]);
    await sync();
    const [imported] = await liveGoogleCommitments(ownerA);
    if (imported === undefined) throw new Error('expected an imported row');

    const create = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '가짜', startAt: '2026-01-03T10:00:00Z', endAt: '2026-01-03T11:00:00Z', timeZone: 'UTC', source: 'google' },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json()).toMatchObject({ code: 'validation_failed' });

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${imported.id}`,
      headers: authHeaders(sessionA, { 'if-match': `W/"${String(imported.version)}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '바꾸기' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json()).toMatchObject({ code: 'illegal_transition' });
    const remove = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/commitments/${imported.id}`,
      headers: authHeaders(sessionA, { 'if-match': `W/"${String(imported.version)}"`, 'idempotency-key': newIdempotencyKey() }),
    });
    expect(remove.statusCode).toBe(409);
    expect(await liveGoogleCommitments(ownerA)).toEqual([imported]);

    const manual = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '직접', startAt: '2026-01-03T10:00:00Z', endAt: '2026-01-03T11:00:00Z', timeZone: 'UTC' },
    });
    expect(manual.statusCode).toBe(201);
    const intoGoogle = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${(manual.json() as { id: string }).id}`,
      headers: authHeaders(sessionA, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
      payload: { source: 'google' },
    });
    expect(intoGoogle.statusCode).toBe(400);
  });

  test('an imported 약속 is busy time for the scheduler, exactly like a manual one', async () => {
    const versionBefore = await availabilityVersion(ownerA);
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/availability',
      headers: authHeaders(sessionA, { 'if-match': `W/"availability:${String(versionBefore)}"`, 'idempotency-key': newIdempotencyKey() }),
      payload: AVAILABILITY_BODY,
    });
    expect(put.statusCode).toBe(200);
    // Google says the user is busy 09:00-17:00 UTC on Jan 2; work hours are 09:00-18:00.
    google.events.set(PRIMARY, [timedEvent('busy', '2026-01-02T09:00:00Z', '2026-01-02T17:00:00Z', { summary: '워크숍' })]);
    await sync();

    const project = await ctx.repos.projects.create(ownerA, { title: 'p' }, randomUUID());
    await ctx.db.insertInto('project').values({ id: project.id, owner_id: ownerA, title: 'p', kind: 'normal' }).execute();
    const task = await ctx.repos.tasks.create(ownerA, { projectId: project.id, title: '보고서' }, randomUUID());
    await ctx.db
      .insertInto('task')
      .values({
        id: task.id,
        owner_id: ownerA,
        project_id: project.id,
        title_cache: task.title,
        status_cache: 'todo',
        splittable: true,
        min_session_min: 30,
        max_session_min: 90,
        priority: 2,
      })
      .execute();
    await ctx.db
      .insertInto('estimate')
      .values({ id: ctx.ids.next(), owner_id: ownerA, task_id: task.id, p50_min: 60, p90_min: 60, method: 'template', confidence: 0.6, is_current: true })
      .execute();

    const plan = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/plans',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        scope: { taskIds: [task.id] },
        policies: ['balanced'],
        horizon: { start: '2026-01-02T00:00:00Z', end: '2026-01-03T00:00:00Z' },
      },
    });
    expect(plan.statusCode).toBe(201);
    const blocks = (plan.json() as Plan).candidates.flatMap((candidate) => candidate.blocks);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const overlaps =
        Date.parse(block.startAt) < Date.parse('2026-01-02T17:00:00Z') &&
        Date.parse(block.endAt) > Date.parse('2026-01-02T09:00:00Z');
      expect({ block, overlaps }).toEqual({ block, overlaps: false });
    }
  });
});
