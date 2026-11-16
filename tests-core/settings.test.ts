/**
 * `updateMySettings` (RC-10A): the rules the generic suite cannot know.
 *
 * `services/api/test/llm-settings.test.ts` and `auth.test.ts` pin the same
 * answers for the TypeScript API (consent record, additive budget, unknown
 * zone 400, header rules). Where the core differs on purpose the test says
 * so and blueprint 15 §2.2 / §2.4 records it.
 */
import type { User } from '@ohmydate/contracts';
import { API_PREFIX, expectProblem, expectSuccess, routeById } from './support/contract.js';
import { startCore, type Core, type CoreResponse } from './support/core.js';
import { newIdempotencyKey, readMe } from './support/routes.js';

let core: Core;

beforeEach(async () => {
  // Every test starts from an owner nobody has changed (version 1).
  core = await startCore();
});

afterEach(async () => {
  await core.dispose();
});

const route = routeById('updateMySettings');
const PATH = `${API_PREFIX}/me/settings`;

function patch(version: number, body: unknown, key: string = newIdempotencyKey()): Promise<CoreResponse> {
  return core.request('PATCH', PATH, {
    headers: { 'if-match': `W/"${version}"`, 'idempotency-key': key },
    body,
  });
}

async function me(): Promise<User> {
  const response = await core.request('GET', `${API_PREFIX}/me`);
  expectSuccess(routeById('getMe'), response, 200);
  return response.body as User;
}

function errorsOf(response: CoreResponse): unknown {
  return (response.body as { errors?: unknown }).errors;
}

describe('updateMySettings: time zone and locale', () => {
  test('a change answers the whole owner, tagged with the version the next If-Match names', async () => {
    const before = await me();
    expect([before.timeZone, before.locale, before.version]).toEqual(['Asia/Seoul', 'ko-KR', 1]);

    const response = await patch(1, { timeZone: 'Europe/Berlin', locale: 'de-DE' });
    expectSuccess(route, response, 200);
    const updated = response.body as User;
    expect(updated).toEqual({
      ...before,
      timeZone: 'Europe/Berlin',
      locale: 'de-DE',
      version: 2,
      updatedAt: updated.updatedAt,
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt));
    expect(response.headers.get('etag')).toBe('W/"2"');

    // GET /me is the same owner, under its own kind of tag.
    const read = await core.request('GET', `${API_PREFIX}/me`);
    expect(read.body).toEqual(updated);
    expect(read.headers.get('etag')).toBe(`W/"${before.id}:2"`);
  });

  test('one field alone leaves the other as it was', async () => {
    const zone = await patch(1, { timeZone: 'America/New_York' });
    expect(zone.body).toMatchObject({ timeZone: 'America/New_York', locale: 'ko-KR', version: 2 });
    const locale = await patch(2, { locale: 'en-GB' });
    expect(locale.body).toMatchObject({ timeZone: 'America/New_York', locale: 'en-GB', version: 3 });
  });

  test('an empty patch is accepted and is a new version (as in the TypeScript API)', async () => {
    const before = await me();
    const response = await patch(1, {});
    expectSuccess(route, response, 200);
    expect(response.body).toEqual({ ...before, version: 2, updatedAt: (response.body as User).updatedAt });
  });

  test('a zone the tz database does not know, or does not spell that way, is 400', async () => {
    for (const timeZone of ['Mars/Olympus_Mons', 'asia/seoul', 'ASIA/SEOUL', 'Seoul', '+09:00', '', ' Asia/Seoul']) {
      const response = await patch(1, { timeZone });
      expectProblem(route, response, 400, 'validation_failed');
      expect(errorsOf(response), timeZone).toMatchObject([{ path: '/timeZone' }]);
      // The rejected value is never repeated back.
      if (timeZone.trim().length > 3) expect(JSON.stringify(response.body)).not.toContain(timeZone);
    }
    expect((await me()).version).toBe(1);
  });

  test('every name of the tz database is a zone here, old spelling or new (15 §2.4 S3)', async () => {
    // The reference takes its list from its runtime's ICU, which spells this
    // zone `Asia/Calcutta` and refuses the name the tz database now uses.
    // The core takes both, and stores what it was sent: it does not rename.
    const referenceKnows = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC', 'Etc/UTC']);
    let version = 1;
    for (const timeZone of ['Asia/Calcutta', 'Asia/Kolkata', 'Europe/Kyiv', 'Etc/GMT+9', 'US/Pacific']) {
      const response = await patch(version, { timeZone });
      expect(response.status, timeZone).toBe(200);
      expect((response.body as User).timeZone).toBe(timeZone);
      const read = await core.request('GET', `${API_PREFIX}/me`);
      expect((read.body as User).timeZone).toBe(timeZone);
      // The other side of the decision: a `User` carrying a name this
      // runtime's ICU does not list fails the reference's own format check,
      // so the body is checked against the contract only for names it knows.
      if (referenceKnows.has(timeZone)) expectSuccess(route, response, 200);
      version += 1;
    }
    expect(referenceKnows.has('Asia/Calcutta')).toBe(true);
    // In the database, and nobody's time zone.
    expectProblem(route, await patch(version, { timeZone: 'Factory' }), 400, 'validation_failed');
  });

  test('a locale outside 2..35 characters is 400', async () => {
    for (const locale of ['k', 'x'.repeat(36), 7, null]) {
      expectProblem(route, await patch(1, { locale }), 400, 'validation_failed');
    }
    expectSuccess(route, await patch(1, { locale: 'x'.repeat(35) }), 200);
  });

  test('a stale version is 412 and changes nothing; the key stays free', async () => {
    const before = await me();
    const key = newIdempotencyKey();
    const stale = await patch(4, { locale: 'en-GB' }, key);
    expectProblem(route, stale, 412, 'version_conflict');
    expect(await me()).toEqual(before);
    // The refused attempt did not use up its key.
    expectSuccess(route, await patch(1, { locale: 'en-GB' }, key), 200);
  });
});

describe('updateMySettings: AI consent and budget', () => {
  test('a fresh owner has decided nothing, and no provider is announced before RC-70', async () => {
    const owner = await me();
    expect(owner.llm).toBeUndefined();
    expect(owner.llmProvider).toBeUndefined();
  });

  test('consent records its time and provider; a budget is added without losing it', async () => {
    // The sequence of services/api/test/llm-settings.test.ts.
    const granted = await patch(1, { llm: { consent: { granted: true } } });
    expectSuccess(route, granted, 200);
    const afterGrant = granted.body as User;
    expect(afterGrant.llm?.consent).toEqual({ granted: true, provider: 'deepseek', at: afterGrant.updatedAt });
    expect(afterGrant.llm?.budget).toBeUndefined();

    const budgeted = await patch(2, { llm: { budget: { dailyUsd: 1.5, monthlyUsd: 20 } } });
    expectSuccess(route, budgeted, 200);
    const afterBudget = budgeted.body as User;
    expect(afterBudget.llm?.budget).toEqual({ dailyUsd: 1.5, monthlyUsd: 20 });
    expect(afterBudget.llm?.consent).toEqual(afterGrant.llm?.consent);

    const revoked = await patch(3, { llm: { consent: { granted: false } } });
    expectSuccess(route, revoked, 200);
    const afterRevoke = revoked.body as User;
    expect(afterRevoke.llm?.consent).toMatchObject({ granted: false, provider: 'deepseek' });
    expect(afterRevoke.llm?.budget).toEqual({ dailyUsd: 1.5, monthlyUsd: 20 });
    expect(await me()).toEqual(afterRevoke);
  });

  test('a budget patch fills the limit it does not name: the default, then the kept value', async () => {
    const daily = await patch(1, { llm: { budget: { dailyUsd: 1 } } });
    expect((daily.body as User).llm?.budget).toEqual({ dailyUsd: 1, monthlyUsd: 5 });
    const monthly = await patch(2, { llm: { budget: { monthlyUsd: 0.75 } } });
    expect((monthly.body as User).llm?.budget).toEqual({ dailyUsd: 1, monthlyUsd: 0.75 });
    const zero = await patch(3, { llm: { budget: { dailyUsd: 0 } } });
    expect((zero.body as User).llm?.budget).toEqual({ dailyUsd: 0, monthlyUsd: 0.75 });
  });

  test('an llm object that names nothing decides nothing', async () => {
    const response = await patch(1, { llm: {} });
    expectSuccess(route, response, 200);
    expect((response.body as User).llm).toBeUndefined();
  });

  test('the client cannot write the consent time or provider, or a negative limit (400)', async () => {
    for (const llm of [
      { consent: { granted: true, at: '2020-01-01T00:00:00Z' } },
      { consent: { granted: true, provider: 'someone-else' } },
      { consent: {} },
      { consent: { granted: 'yes' } },
      { budget: { dailyUsd: -1 } },
      { budget: { dailyUsd: '1' } },
      { budget: { yearlyUsd: 1 } },
      { provider: 'someone-else' },
    ]) {
      expectProblem(route, await patch(1, { llm }), 400, 'validation_failed');
    }
    expect((await me()).llm).toBeUndefined();
  });

  test('an amount is kept to the micro-dollar; one beyond a billion dollars is a stored 422 (core rule)', async () => {
    const fine = await patch(1, { llm: { budget: { dailyUsd: 0.1234567, monthlyUsd: 1_000_000_000 } } });
    expectSuccess(route, fine, 200);
    expect((fine.body as User).llm?.budget).toEqual({ dailyUsd: 0.123457, monthlyUsd: 1_000_000_000 });

    const key = newIdempotencyKey();
    const body = { locale: 'en-GB', llm: { budget: { dailyUsd: 1e12, monthlyUsd: 1e300 } } };
    const refused = await patch(2, body, key);
    expectProblem(route, refused, 422, 'validation_failed');
    expect(errorsOf(refused)).toEqual([
      { path: 'llm.budget.dailyUsd', message: 'llm.budget.dailyUsd must be between 0 and 1000000000' },
      { path: 'llm.budget.monthlyUsd', message: 'llm.budget.monthlyUsd must be between 0 and 1000000000' },
    ]);
    const replay = await patch(2, body, key);
    expect([replay.status, replay.body]).toEqual([422, refused.body]);
    // Nothing of the refused patch was applied, the locale included.
    expect(await me()).toEqual(fine.body);
  });
});

describe('updateMySettings: durability', () => {
  test('settings survive a restart, and so does the stored answer of the key', async () => {
    const key = newIdempotencyKey();
    const body = { timeZone: 'Pacific/Auckland', llm: { consent: { granted: true }, budget: { dailyUsd: 2 } } };
    const first = await patch(1, body, key);
    expectSuccess(route, first, 200);
    expect(await core.stop()).toBe(0);

    core = await startCore({ dataDir: core.dataDir });
    expect(await me()).toEqual(first.body);
    expect((await readMe(core)).version).toBe(2);
    const replay = await patch(1, body, key);
    expect([replay.status, replay.body]).toEqual([200, first.body]);
    expect((await readMe(core)).version).toBe(2);
  });
});
