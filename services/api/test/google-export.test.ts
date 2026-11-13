import { randomUUID } from 'node:crypto';
import type { Id, Instant } from '@ohmydate/domain';
import {
  desiredEvents,
  exportEventId,
  fingerprintOf,
  summaryTitle,
} from '../src/application/google-export.js';
import type { ExportSource } from '../src/application/google-calendar-ports.js';
import { GOOGLE_EXPORT_NUDGE_OPERATIONS } from '../src/http/routes.js';
import { jsonb } from '../src/db/types.js';
import {
  FakeGoogle,
  ManualScheduler,
  TEST_WEB_ORIGIN,
  testGoogleSecrets,
  timedEvent,
} from './support/google-fakes.js';
import {
  authHeaders,
  createTestContext,
  hasDatabase,
  login,
  newIdempotencyKey,
  type TestContext,
  type TestSession,
} from './support/test-context.js';

const SETTINGS = { exportBlocks: true, exportCommitments: true, dailySummary: true, reminderMinutes: 10 };
const BASE32HEX_ID = /^[a-v0-9]{5,1024}$/;

function source(overrides: Partial<ExportSource> = {}): ExportSource {
  return {
    timeZone: 'Asia/Seoul',
    dayStartLocal: '08:00',
    locale: 'ko-KR',
    blocks: [],
    commitments: [],
    cachedTaskTitles: new Map(),
    ...overrides,
  };
}

const TASK = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55' as Id;
const BLOCK_1 = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0001' as Id;
const BLOCK_2 = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0002' as Id;

describe('export builder (pure)', () => {
  test('deterministic base32hex ids: b/c + uuid hex, s + date', () => {
    expect(exportEventId('block', BLOCK_1)).toBe('b0193a8f26c1e7b419a2e1f1d6a0b0001');
    expect(exportEventId('commitment', BLOCK_1)).toBe('c0193a8f26c1e7b419a2e1f1d6a0b0001');
    expect(exportEventId('summary', '2026-01-02')).toBe('s20260102');
    for (const id of [exportEventId('block', BLOCK_1), exportEventId('summary', '2026-12-31')]) {
      expect(id).toMatch(BASE32HEX_ID);
    }
    expect(() => exportEventId('block', 'not-a-uuid')).toThrow();
  });

  test('blocks carry the task title, owner zone and one popup; skipped/moved blocks are not exported', () => {
    const events = desiredEvents({
      source: source({
        blocks: [
          { id: BLOCK_1, taskId: TASK, startAt: '2026-01-02T01:00:00.000Z' as Instant, endAt: '2026-01-02T02:00:00.000Z' as Instant, status: 'planned' },
          { id: BLOCK_2, taskId: TASK, startAt: '2026-01-02T03:00:00.000Z' as Instant, endAt: '2026-01-02T04:00:00.000Z' as Instant, status: 'skipped' },
        ],
      }),
      taskTitles: new Map([[TASK, '논문 5편 요약']]),
      settings: { ...SETTINGS, dailySummary: false },
      calendarId: 'cal',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'block',
      localKey: BLOCK_1,
      endsAt: '2026-01-02T02:00:00.000Z',
      body: {
        summary: '논문 5편 요약',
        start: { dateTime: '2026-01-02T01:00:00.000Z', timeZone: 'Asia/Seoul' },
        end: { dateTime: '2026-01-02T02:00:00.000Z', timeZone: 'Asia/Seoul' },
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
        transparency: 'opaque',
        status: 'confirmed',
      },
    });
    expect(Object.keys(events[0]?.body ?? {})).not.toContain('description');
  });

  test('reminderMinutes null exports no popup; the planner title cache and a neutral title are fallbacks', () => {
    const [cached, neutral] = desiredEvents({
      source: source({
        blocks: [
          { id: BLOCK_1, taskId: TASK, startAt: '2026-01-02T01:00:00.000Z' as Instant, endAt: '2026-01-02T02:00:00.000Z' as Instant, status: 'done' },
          { id: BLOCK_2, taskId: BLOCK_2, startAt: '2026-01-02T03:00:00.000Z' as Instant, endAt: '2026-01-02T04:00:00.000Z' as Instant, status: 'planned' },
        ],
        cachedTaskTitles: new Map([[TASK, '캐시 제목']]),
      }),
      taskTitles: new Map(),
      settings: { ...SETTINGS, dailySummary: false, reminderMinutes: null },
      calendarId: 'cal',
    });
    expect(cached?.body.summary).toBe('캐시 제목');
    expect(neutral?.body.summary).toBe('할 일');
    expect(cached?.body.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  test('a repeating manual 약속 is one recurring event in its own zone and never ages out', () => {
    const [event] = desiredEvents({
      source: source({
        commitments: [
          {
            id: BLOCK_1,
            title: '주간 회의',
            startAt: '2026-01-05T01:00:00.000Z' as Instant,
            endAt: '2026-01-05T02:00:00.000Z' as Instant,
            timeZone: 'Europe/Berlin',
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
          },
        ],
      }),
      taskTitles: new Map(),
      settings: SETTINGS,
      calendarId: 'cal',
    });
    expect(event).toMatchObject({
      kind: 'commitment',
      eventId: 'c0193a8f26c1e7b419a2e1f1d6a0b0001',
      endsAt: null,
      body: {
        summary: '주간 회의',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
        start: { timeZone: 'Europe/Berlin' },
      },
    });
  });

  test('daily summary: one 10-minute event per local day at the day start (or the earlier first block)', () => {
    const blocks = [
      { id: BLOCK_1, taskId: TASK, startAt: '2026-01-02T01:00:00.000Z' as Instant, endAt: '2026-01-02T02:00:00.000Z' as Instant, status: 'planned' },
      { id: BLOCK_2, taskId: TASK, startAt: '2026-01-02T05:30:00.000Z' as Instant, endAt: '2026-01-02T06:00:00.000Z' as Instant, status: 'planned' },
    ];
    const events = desiredEvents({
      source: source({ blocks }),
      taskTitles: new Map([[TASK, '보고서']]),
      settings: SETTINGS,
      calendarId: 'cal',
    });
    const summary = events.find((event) => event.kind === 'summary');
    expect(summary).toMatchObject({
      localKey: '2026-01-02',
      eventId: 's20260102',
      body: {
        summary: '오늘 할 일 2개',
        // 08:00 Asia/Seoul = 2026-01-01T23:00Z, earlier than the 10:00 KST first block.
        start: { dateTime: '2026-01-01T23:00:00.000Z', timeZone: 'Asia/Seoul' },
        end: { dateTime: '2026-01-01T23:10:00.000Z' },
        description: '10:00–11:00 보고서\n14:30–15:00 보고서',
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] },
        transparency: 'transparent',
      },
    });

    const early = desiredEvents({
      source: source({ blocks, dayStartLocal: '11:00' }),
      taskTitles: new Map(),
      settings: SETTINGS,
      calendarId: 'cal',
    }).find((event) => event.kind === 'summary');
    expect(early?.body.start.dateTime).toBe('2026-01-02T01:00:00.000Z');

    expect(
      desiredEvents({ source: source({ blocks }), taskTitles: new Map(), settings: { ...SETTINGS, dailySummary: false }, calendarId: 'cal' }).some(
        (event) => event.kind === 'summary',
      ),
    ).toBe(false);
    expect(summaryTitle(1, 'en-US')).toBe('Today: 1 task');
  });

  test('the fingerprint covers the body and the calendar, and is stable', () => {
    const [event] = desiredEvents({
      source: source({
        blocks: [{ id: BLOCK_1, taskId: TASK, startAt: '2026-01-02T01:00:00.000Z' as Instant, endAt: '2026-01-02T02:00:00.000Z' as Instant, status: 'planned' }],
      }),
      taskTitles: new Map(),
      settings: { ...SETTINGS, dailySummary: false },
      calendarId: 'cal',
    });
    if (event === undefined) throw new Error('expected one event');
    expect(event.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf('cal', event.body)).toBe(event.fingerprint);
    expect(fingerprintOf('other', event.body)).not.toBe(event.fingerprint);
    expect(fingerprintOf('cal', { ...event.body, summary: 'x' })).not.toBe(event.fingerprint);
  });

  test('the nudge list is exactly the mutations that can change what is exported', () => {
    expect([...GOOGLE_EXPORT_NUDGE_OPERATIONS].sort()).toEqual(
      [
        'acceptToday',
        'approvePlanCandidate',
        'approveReplanProposal',
        'approveTodayProposal',
        'createCommitment',
        'deleteCommitment',
        'rescheduleToday',
        'shrinkToday',
        'updateCommitment',
      ].sort(),
    );
    expect(GOOGLE_EXPORT_NUDGE_OPERATIONS.has('lockScheduleBlock')).toBe(false);
  });
});

describe.skipIf(!hasDatabase)('Google export through the API (CAL-03)', () => {
  let ctx: TestContext;
  let google: FakeGoogle;
  let manual: ManualScheduler;
  let ownerA: Id;
  let sessionA: TestSession;
  let taskId: Id;
  let planVersionId: Id;

  beforeEach(async () => {
    google = new FakeGoogle();
    manual = new ManualScheduler();
    ctx = await createTestContext({
      google: { secrets: testGoogleSecrets(), oauth: google, calendar: google, nudgeScheduler: manual.scheduler },
    });
    ownerA = (await ctx.seedUser({ email: 'export-a@example.com', password: 'correct-horse', timeZone: 'Asia/Seoul', locale: 'ko-KR' })) as Id;
    sessionA = await login(ctx, 'export-a@example.com', 'correct-horse');
    google.calendars = [];
    await connect();
    manual.flush();
    // Wait for the connect-time background sync to settle before each test.
    await sync();
    ({ taskId, planVersionId } = await seedPlan('논문 요약'));
  });

  afterEach(async () => {
    await ctx.close();
  });

  async function connect(): Promise<void> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:connect',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
    });
    const state = new URL((response.json() as { authorizationUrl: string }).authorizationUrl).searchParams.get('state');
    const callback = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/integrations/google/callback?code=c&state=${state ?? ''}`,
      headers: { cookie: sessionA.cookie },
    });
    expect(callback.headers['location']).toBe(`${TEST_WEB_ORIGIN}/settings/calendar?google=connected`);
  }

  async function sync(): Promise<{ exported: { created: number; updated: number; removed: number } }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/google:sync',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { exported: { created: number; updated: number; removed: number } };
  }

  async function putSettings(settings: typeof SETTINGS | Record<string, unknown>): Promise<void> {
    const current = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    const body = current.json() as { calendars: { id: string; selected: boolean }[] };
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/integrations/google/settings',
      headers: authHeaders(sessionA, { 'if-match': current.headers['etag'] as string, 'idempotency-key': newIdempotencyKey() }),
      payload: {
        selectedCalendarIds: body.calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id),
        settings,
      },
    });
    expect(response.statusCode).toBe(200);
  }

  async function seedPlan(title: string): Promise<{ taskId: Id; planVersionId: Id }> {
    const project = await ctx.repos.projects.create(ownerA, { title: 'p' }, randomUUID());
    await ctx.db.insertInto('project').values({ id: project.id, owner_id: ownerA, title: 'p', kind: 'normal' }).execute();
    const task = await ctx.repos.tasks.create(ownerA, { projectId: project.id, title }, randomUUID());
    await ctx.db
      .insertInto('task')
      .values({ id: task.id, owner_id: ownerA, project_id: project.id, title_cache: title, status_cache: 'todo', splittable: true, priority: 2 })
      .execute();
    const planId = ctx.ids.next();
    const versionId = ctx.ids.next();
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('plan')
        .values({
          id: planId,
          owner_id: ownerA,
          scope: jsonb({ taskIds: [task.id] }),
          status: 'active',
          current_version_id: versionId,
          availability_version: 1,
          horizon_start: new Date('2026-01-01T00:00:00Z'),
          horizon_end: new Date('2026-01-31T00:00:00Z'),
          time_zone: 'Asia/Seoul',
        })
        .execute();
      await trx
        .insertInto('plan_version')
        .values({ id: versionId, owner_id: ownerA, plan_id: planId, seq: 1, availability_version: 1 })
        .execute();
    });
    return { taskId: task.id as Id, planVersionId: versionId as Id };
  }

  async function seedBlock(start: string, end: string): Promise<Id> {
    const id = ctx.ids.next() as Id;
    await ctx.db
      .insertInto('schedule_block')
      .values({ id, owner_id: ownerA, plan_version_id: planVersionId, task_id: taskId, start_at: new Date(start), end_at: new Date(end), status: 'planned' })
      .execute();
    return id;
  }

  function exportedSummaries(): string[] {
    return [...google.exported().values()].map((event) => event.body.summary).sort();
  }

  test('creates the OhMyDate calendar once and exports blocks with the summary; a second run patches nothing', async () => {
    expect(google.callCount('insertCalendar')).toBe(1);
    expect(google.calls.find((call) => call.op === 'insertCalendar')?.args).toMatchObject({ summary: 'OhMyDate', timeZone: 'Asia/Seoul' });
    const block = await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    const first = await sync();
    expect(first.exported).toEqual({ created: 2, updated: 0, removed: 0 });
    expect(google.exported().get(exportEventId('block', block))?.body).toMatchObject({
      summary: '논문 요약',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    });
    expect(exportedSummaries()).toEqual(['논문 요약', '오늘 할 일 1개']);

    const writes = google.callCount('insertEvent') + google.callCount('patchEvent');
    expect((await sync()).exported).toEqual({ created: 0, updated: 0, removed: 0 });
    expect(google.callCount('insertEvent') + google.callCount('patchEvent')).toBe(writes);
    expect(google.callCount('insertCalendar')).toBe(1);
  });

  test('a moved block is patched in place and a superseded block is deleted', async () => {
    const block = await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    await sync();
    await ctx.db
      .updateTable('schedule_block')
      .set({ start_at: new Date('2026-01-02T03:00:00Z'), end_at: new Date('2026-01-02T04:00:00Z') })
      .where('id', '=', block)
      .execute();
    expect((await sync()).exported).toMatchObject({ created: 0, updated: 2 });
    expect(google.exported().get(exportEventId('block', block))?.body.start.dateTime).toBe('2026-01-02T03:00:00.000Z');

    await ctx.db.updateTable('schedule_block').set({ status: 'superseded' }).where('id', '=', block).execute();
    expect((await sync()).exported).toMatchObject({ removed: 2 });
    expect(google.exported().size).toBe(0);
    expect(await ctx.db.selectFrom('google_export_mapping').selectAll().execute()).toEqual([]);
  });

  test('manual 약속 are exported (repeating as RRULE); imported 약속 never are', async () => {
    const manualCommitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: {
        title: '주간 회의',
        startAt: '2026-01-05T01:00:00Z',
        endAt: '2026-01-05T02:00:00Z',
        timeZone: 'Asia/Seoul',
        rrule: 'FREQ=WEEKLY;BYDAY=MO',
      },
    });
    expect(manualCommitment.statusCode).toBe(201);
    google.calendars = [{ id: 'primary@example.test', summary: 'me', accessRole: 'owner', primary: true }];
    google.events.set('primary@example.test', [
      timedEvent('g1', '2026-01-03T10:00:00Z', '2026-01-03T11:00:00Z', { summary: '구글 약속' }),
    ]);
    await sync();
    const id = (manualCommitment.json() as { id: string }).id;
    const exported = google.exported().get(exportEventId('commitment', id));
    expect(exported?.body).toMatchObject({ summary: '주간 회의', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] });
    const imported = await ctx.db
      .selectFrom('commitment_event')
      .select('id')
      .where('source', '=', 'google')
      .execute();
    expect(imported).toHaveLength(1);
    expect(google.exported().has(exportEventId('commitment', imported[0]?.id ?? ''))).toBe(false);
    expect(exportedSummaries()).not.toContain('구글 약속');
  });

  test('settings: reminder minutes (incl. none) and daily summary off re-push and remove', async () => {
    const block = await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    await sync();
    await putSettings({ ...SETTINGS, reminderMinutes: 30 });
    // The summary pops up at its own start whatever the lead, so only the block changes.
    expect((await sync()).exported.updated).toBe(1);
    expect(google.exported().get(exportEventId('block', block))?.body.reminders.overrides).toEqual([{ method: 'popup', minutes: 30 }]);
    expect(google.exported().get('s20260102')?.body.reminders.overrides).toEqual([{ method: 'popup', minutes: 0 }]);

    await putSettings({ ...SETTINGS, reminderMinutes: null, dailySummary: false });
    const result = await sync();
    expect(result.exported).toMatchObject({ updated: 1, removed: 1 });
    expect(google.exported().get(exportEventId('block', block))?.body.reminders.overrides).toEqual([]);
    expect(google.exported().has('s20260102')).toBe(false);

    await putSettings({ ...SETTINGS, exportBlocks: false, dailySummary: false });
    expect((await sync()).exported.removed).toBe(1);
    expect(google.exported().size).toBe(0);
  });

  test('duplicate-id recovery: a lost mapping or a deleted (cancelled) event is patched back', async () => {
    const block = await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    await sync();
    const eventId = exportEventId('block', block);
    // Lose the mapping (e.g. a crash after insert, before the mapping write).
    await ctx.db.deleteFrom('google_export_mapping').execute();
    // And delete the event at Google: it stays as a cancelled tombstone.
    const calendarId = [...google.ownCalendars.keys()][0] ?? '';
    await google.deleteEvent('t', calendarId, eventId);
    expect(google.exported().has(eventId)).toBe(false);

    const result = await sync();
    expect(result.exported).toMatchObject({ created: 0, updated: 2 });
    expect(google.exported().get(eventId)?.status).toBe('confirmed');
    expect(google.calls.filter((call) => call.op === 'insertEvent' && call.args['id'] === eventId).length).toBe(2);
    const mappings = await ctx.db.selectFrom('google_export_mapping').select(['local_kind', 'google_event_id']).execute();
    expect(mappings.map((row) => row.google_event_id).sort()).toEqual([eventId, 's20260102'].sort());
  });

  test('404/410 on patch drops the mapping and re-creates the event', async () => {
    const block = await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    await sync();
    const eventId = exportEventId('block', block);
    await ctx.db.updateTable('schedule_block').set({ end_at: new Date('2026-01-02T02:30:00Z') }).where('id', '=', block).execute();
    google.patchGone.set(eventId, 'gone');
    google.patchGone.set('s20260102', 'not_found');
    const result = await sync();
    expect(result.exported).toMatchObject({ created: 2, updated: 0 });
    expect(google.exported().get(eventId)?.body.end.dateTime).toBe('2026-01-02T02:30:00.000Z');
  });

  test('a deleted OhMyDate calendar is forgotten and re-created on the next run', async () => {
    await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    await sync();
    const first = [...google.ownCalendars.keys()][0] ?? '';
    google.ownCalendars.delete(first);
    await ctx.db.deleteFrom('google_export_mapping').execute();
    await sync();
    expect(google.callCount('insertCalendar')).toBe(1);
    await sync();
    expect(google.callCount('insertCalendar')).toBe(2);
    expect(google.exported().size).toBe(2);
  });

  test('one event Google rejects is recorded and the rest are still exported', async () => {
    google.rejectRecurrence = true;
    await seedBlock('2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z');
    const commitment = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '반복', startAt: '2026-01-05T01:00:00Z', endAt: '2026-01-05T02:00:00Z', timeZone: 'Asia/Seoul', rrule: 'FREQ=DAILY' },
    });
    expect(commitment.statusCode).toBe(201);
    const result = await sync();
    expect(result.exported.created).toBe(2);
    const status = await ctx.app.inject({ method: 'GET', url: '/api/v1/integrations/google', headers: authHeaders(sessionA) });
    expect(status.json()).toMatchObject({ lastError: 'google_rejected', exportCalendarName: 'OhMyDate' });
  });

  test('commitment mutations nudge a debounced export; a failed mutation or a read does not', async () => {
    expect(manual.pending).toBe(0);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/commitments',
      headers: authHeaders(sessionA, { 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '치과', startAt: '2026-01-06T01:00:00Z', endAt: '2026-01-06T02:00:00Z', timeZone: 'Asia/Seoul' },
    });
    expect(created.statusCode).toBe(201);
    expect(manual.pending).toBe(1);
    const id = (created.json() as { id: string }).id;
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${id}`,
      headers: authHeaders(sessionA, { 'if-match': 'W/"1"', 'idempotency-key': newIdempotencyKey() }),
      payload: { title: '치과 (변경)' },
    });
    expect(updated.statusCode).toBe(200);
    // Debounced: still one pending run for the owner.
    expect(manual.pending).toBe(1);

    manual.flush();
    await sync();
    expect(exportedSummaries()).toContain('치과 (변경)');

    const failed = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/v1/commitments/${id}`,
      headers: authHeaders(sessionA, { 'if-match': 'W/"99"', 'idempotency-key': newIdempotencyKey() }),
      payload: { title: 'x' },
    });
    expect(failed.statusCode).toBe(412);
    await ctx.app.inject({ method: 'GET', url: '/api/v1/commitments?from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z', headers: authHeaders(sessionA) });
    expect(manual.pending).toBe(0);

    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/v1/commitments/${id}`,
      headers: authHeaders(sessionA, { 'if-match': 'W/"2"', 'idempotency-key': newIdempotencyKey() }),
    });
    expect(removed.statusCode).toBe(204);
    expect(manual.pending).toBe(1);
  });
});

describe.skipIf(!hasDatabase)('export nudges never fail the request', () => {
  test('a scheduler that throws does not change the mutation response', async () => {
    const google = new FakeGoogle();
    let attempts = 0;
    const ctx = await createTestContext({
      google: {
        secrets: testGoogleSecrets(),
        oauth: google,
        calendar: google,
        nudgeScheduler: () => {
          attempts += 1;
          throw new Error('scheduler exploded');
        },
      },
    });
    try {
      await ctx.seedUser({ email: 'nudge@example.com', password: 'correct-horse' });
      const session = await login(ctx, 'nudge@example.com', 'correct-horse');
      const created = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/commitments',
        headers: authHeaders(session, { 'idempotency-key': newIdempotencyKey() }),
        payload: { title: '약속', startAt: '2026-01-06T01:00:00Z', endAt: '2026-01-06T02:00:00Z', timeZone: 'UTC' },
      });
      expect(created.statusCode).toBe(201);
      expect(attempts).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
