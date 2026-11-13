import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isUuidV7Key, type GoogleSyncErrorCode } from '../src/api';
import { setTopLevelNavigator } from '../src/composables/useGoogleCalendar';
import {
  GOOGLE_SETUP,
  draftFrom,
  googleCallbackResult,
  isAllowedAuthorizationUrl,
  localWebOrigin,
  reminderChoices,
  reminderFromOptionValue,
  reminderOptionValue,
  sameDraft,
  settingsPutBody,
} from '../src/domain/googleIntegration';
import { ko, lookup, t, type MessageKey } from '../src/i18n';
import { mockDb } from '../src/mocks/db';
import {
  GOOGLE_CALENDAR_CLUB_ID,
  GOOGLE_CALENDAR_FAMILY_ID,
  GOOGLE_CALENDAR_HOLIDAYS_ID,
  GOOGLE_CALENDAR_PRIMARY_ID,
  seedGoogle,
} from '../src/mocks/google';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';
import CalendarSettingsView from '../src/views/CalendarSettingsView.vue';

const Stub = defineComponent({ template: '<div />' });

interface Captured {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const captured: Captured[] = [];
const navigations: string[] = [];
const mounted: VueWrapper[] = [];

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/settings/calendar', name: 'calendar-settings', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
    ],
  });
}

async function mountSettings(
  path = '/settings/calendar',
  options: { online?: boolean } = {},
): Promise<{ wrapper: VueWrapper; router: Router }> {
  const router = testRouter();
  await router.push(path);
  const pinia = createPinia();
  if (options.online === false) useOfflineStore(pinia).setOnline(false);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(CalendarSettingsView, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return { wrapper, router };
}

async function ready(wrapper: VueWrapper, status: string): Promise<void> {
  await vi.waitFor(() => expect(wrapper.find(`[data-google-status="${status}"]`).exists()).toBe(true));
}

function filledButtons(): string[] {
  return [...document.body.querySelectorAll('button.btn--primary')].map((item) => item.textContent?.trim() ?? '');
}

function mutations(): Captured[] {
  return captured.filter((request) => request.method !== 'GET');
}

function dialog(): HTMLElement {
  const found = document.body.querySelector<HTMLElement>('[aria-modal="true"]');
  if (found === null) throw new Error('no dialog');
  return found;
}

function buttonIn(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

async function onRequest({ request }: { request: Request }): Promise<void> {
  const url = new URL(request.url);
  const text = request.method === 'GET' ? '' : await request.clone().text();
  captured.push({
    method: request.method,
    path: url.pathname,
    search: url.search,
    headers: Object.fromEntries(request.headers.entries()),
    body: text.length > 0 ? JSON.parse(text) : null,
  });
}

beforeEach(() => {
  captured.length = 0;
  navigations.length = 0;
  server.events.on('request:start', onRequest);
  setTopLevelNavigator((url) => {
    navigations.push(url);
  });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  server.events.removeListener('request:start', onRequest);
  setTopLevelNavigator(null);
  document.body.innerHTML = '';
});

describe('캘린더 연동: one state per status', () => {
  it('not_configured: says what connecting does and the one-time setup, with no button that cannot work', async () => {
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'not_configured');
    const text = wrapper.text();
    expect(wrapper.get('h1').text()).toBe('캘린더 연동');
    expect(text).toContain('설정 전');
    expect(text).toContain(t('googleCalendar.intro.toPhone'));
    expect(text).toContain(t('googleCalendar.intro.fromPhone'));
    // The exact file path and restart commands of docs/user/Google-캘린더-연동-설정.md.
    expect(wrapper.get('[data-google-client-file]').text()).toContain('deploy/secrets/local/google-oauth-client.json');
    expect(wrapper.get('[data-google-client-file]').text()).toContain('chmod 600 deploy/secrets/local/google-oauth-client.json');
    expect(wrapper.get('[data-google-restart]').text()).toBe(
      'corepack pnpm local:secrets\ncorepack pnpm local:stop\ncorepack pnpm local:start',
    );
    expect(wrapper.get('[data-google-redirect-uri]').text()).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?\/api\/v1\/integrations\/google\/callback$/);
    expect(wrapper.findAll('.google-steps > li')).toHaveLength(6);
    // Negative: no connect, no filled button at all; only the re-check, which works.
    expect(wrapper.find('[data-google-connect]').exists()).toBe(false);
    expect(filledButtons()).toEqual([]);
    await wrapper.get('[data-google-check]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-google-check-note]').text()).toBe(t('googleCalendar.setup.stillNotConfigured')));
    expect(mutations()).toEqual([]);
  });

  it('disconnected: what is read and sent, and 구글 계정 연결 as the one filled button', async () => {
    seedGoogle(mockDb, 'disconnected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'disconnected');
    const plan = wrapper.get('.google-plan').text();
    expect(plan).toContain('가져오는 것');
    expect(plan).toContain(t('googleCalendar.plan.read'));
    expect(plan).toContain('‘OhMyDate’ 캘린더 하나에만');
    expect(plan).toContain(t('googleCalendar.plan.keep'));
    expect(filledButtons()).toEqual(['구글 계정 연결']);
    // Negative: nothing of the connected page.
    expect(wrapper.find('[data-google-sync-now]').exists()).toBe(false);
    expect(wrapper.find('form.google-settings-form').exists()).toBe(false);
    expect(wrapper.find('[data-google-setup]').exists()).toBe(false);
  });

  it('connected: last sync in words, sync now, the calendars and what to send, with 저장 as the one filled button', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    expect(wrapper.text()).toContain('연결됨');
    expect(wrapper.get('[data-google-last-sync]').text()).toBe('마지막 동기화 11월 14일 (토) 오후 6:36 문제없이 끝났어요.');
    expect(wrapper.find('[data-google-sync-now]').exists()).toBe(true);
    const rows = wrapper.findAll('.google-calendar').map((row) => row.text().replace(/\s+/g, ' '));
    expect(rows).toEqual(['내 캘린더, 기본', '대한민국의 휴일, 읽기 전용', '가족', '동아리 공유, 읽기 전용']);
    const ticked = wrapper.findAll<HTMLInputElement>('[data-google-calendar]').map((box) => box.element.checked);
    expect(ticked).toEqual([true, true, true, false]);
    for (const key of ['exportBlocks', 'exportCommitments', 'dailySummary']) {
      expect((wrapper.get(`[data-google-setting="${key}"]`).element as HTMLInputElement).checked).toBe(true);
    }
    const reminder = wrapper.get('[data-google-setting="reminderMinutes"]');
    expect((reminder.element as HTMLSelectElement).value).toBe('10');
    expect(reminder.findAll('option').map((option) => option.text())).toEqual([
      '없음',
      '정각',
      '5분 전',
      '10분 전',
      '15분 전',
      '30분 전',
      '60분 전',
    ]);
    expect(filledButtons()).toEqual(['연동 설정 저장']);
    // Negative: nothing changed yet, so the save cannot act; no connect, no scope notes.
    expect(wrapper.get('[data-google-save]').attributes('disabled')).toBeDefined();
    expect(wrapper.find('[data-google-connect]').exists()).toBe(false);
    expect(wrapper.find('[data-google-scope]').exists()).toBe(false);
  });

  it('connected without the export permission: says which and offers to reconnect', async () => {
    seedGoogle(mockDb, 'partial');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const note = wrapper.get('[data-google-scope="export"]');
    expect(note.text()).toContain(t('googleCalendar.scopes.exportOff'));
    expect(note.find('button').text()).toBe('다시 연결');
    expect(wrapper.find('[data-google-scope="import"]').exists()).toBe(false);
    // The recorded failure is a sentence.
    expect(wrapper.get('[data-google-last-sync]').text()).toContain(t('googleCalendar.lastError.rate_limited'));
    expect(filledButtons()).toEqual(['연동 설정 저장']);
  });

  it('needs_reauth: one line that sign-in expired, 다시 연결 as the one filled button, nothing else lost', async () => {
    seedGoogle(mockDb, 'needs_reauth');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'needs_reauth');
    expect(wrapper.get('[data-google-reauth]').text()).toContain(t('googleCalendar.reauth.line'));
    expect(filledButtons()).toEqual(['다시 연결']);
    // Said once: the last-sync line gives the time, not the same reason again.
    expect(wrapper.get('[data-google-last-sync]').text()).toBe('마지막 동기화 11월 14일 (토) 오전 8:10');
    // The settings and the calendars are still there; saving is still possible (outline).
    expect(wrapper.findAll('.google-calendar')).toHaveLength(4);
    expect(wrapper.get('[data-google-save]').classes()).toContain('btn--secondary');
    // Negative: syncing is stopped, so there is no sync button.
    expect(wrapper.find('[data-google-sync-now]').exists()).toBe(false);
  });

  it('shows a skeleton while loading, an error with retry when the read fails, and recovers', async () => {
    seedGoogle(mockDb, 'connected');
    let fail = true;
    server.use(
      http.get('*/api/v1/integrations/google', () =>
        fail
          ? HttpResponse.json({ type: 'about:blank', title: 'x', status: 404, code: 'not_found', detail: 'x' }, { status: 404 })
          : HttpResponse.json(mockDb.google.integration as never, { headers: { ETag: `W/"${mockDb.google.integration.version}"` } }),
      ),
    );
    const { wrapper } = await mountSettings();
    expect(wrapper.text()).toContain(t('googleCalendar.loading'));
    await vi.waitFor(() => expect(wrapper.find('[data-google-retry]').exists()).toBe(true));
    expect(wrapper.text()).toContain(t('googleCalendar.loadError'));
    expect(wrapper.find('[data-google-status]').exists()).toBe(false);
    fail = false;
    await wrapper.get('[data-google-retry]').trigger('click');
    await ready(wrapper, 'connected');
  });

  it('is read-only offline: every control is disabled and nothing is sent', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings('/settings/calendar', { online: false });
    await ready(wrapper, 'connected');
    expect(wrapper.text()).toContain(t('googleCalendar.offline'));
    for (const selector of ['[data-google-sync-now]', '[data-google-save]', '[data-google-disconnect]', '[data-google-calendar]']) {
      for (const control of wrapper.findAll(selector)) expect(control.attributes('disabled'), selector).toBeDefined();
    }
    await wrapper.get('[data-google-sync-now]').trigger('click');
    await flushPromises();
    expect(mutations()).toEqual([]);
  });
});

describe('캘린더 연동: connect', () => {
  it('navigates the page to the URL the server returned, and only that', async () => {
    seedGoogle(mockDb, 'disconnected');
    const consent = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic&state=s1&code_challenge=c';
    server.use(http.post(/\/api\/v1\/integrations\/google:connect$/, () => HttpResponse.json({ authorizationUrl: consent })));
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'disconnected');
    await wrapper.get('[data-google-connect]').trigger('click');
    await vi.waitFor(() => expect(navigations).toEqual([consent]));
    const sent = mutations();
    expect(sent.map((request) => `${request.method} ${request.path}`)).toEqual(['POST /api/v1/integrations/google:connect']);
    expect(isUuidV7Key(sent[0]?.headers['idempotency-key'] ?? '')).toBe(true);
    expect(wrapper.text()).toContain(t('googleCalendar.connecting'));
    expect(wrapper.get('[data-google-connect]').attributes('aria-busy')).toBe('true');
  });

  it('refuses to go anywhere but Google (negative)', async () => {
    seedGoogle(mockDb, 'disconnected');
    server.use(
      http.post(/\/api\/v1\/integrations\/google:connect$/, () => HttpResponse.json({ authorizationUrl: 'https://accounts.google.com.evil.example/x' })),
    );
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'disconnected');
    await wrapper.get('[data-google-connect]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-google-error]').text()).toBe(t('googleCalendar.connectRefused')));
    expect(navigations).toEqual([]);
    expect(wrapper.get('[data-google-connect]').attributes('disabled')).toBeUndefined();
  });

  it('reconnects from needs_reauth through the same consent', async () => {
    seedGoogle(mockDb, 'needs_reauth');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'needs_reauth');
    await wrapper.get('[data-google-reconnect]').trigger('click');
    // The mock answers with this app's own stand-in for Google's consent screen.
    await vi.waitFor(() => expect(navigations).toEqual([`${location.origin}/settings/calendar?google=connected`]));
  });

  it('a refused connect (409) re-reads the state and moves nowhere (negative)', async () => {
    seedGoogle(mockDb, 'disconnected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'disconnected');
    // The server lost its configuration meanwhile.
    seedGoogle(mockDb, 'not_configured');
    await wrapper.get('[data-google-connect]').trigger('click');
    await ready(wrapper, 'not_configured');
    expect(wrapper.get('[data-google-error]').text()).toBe(t('googleCalendar.changed'));
    expect(navigations).toEqual([]);
  });
});

describe('캘린더 연동: settings', () => {
  it('saves exactly the chosen calendars and options with If-Match and an Idempotency-Key', async () => {
    seedGoogle(mockDb, 'connected');
    const version = mockDb.google.integration.version;
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get(`[data-google-calendar="${GOOGLE_CALENDAR_FAMILY_ID}"]`).setValue(false);
    await wrapper.get(`[data-google-calendar="${GOOGLE_CALENDAR_CLUB_ID}"]`).setValue(true);
    await wrapper.get('[data-google-setting="dailySummary"]').setValue(false);
    await wrapper.get('[data-google-setting="reminderMinutes"]').setValue('30');
    expect(wrapper.text()).toContain('저장 안 됨');
    await wrapper.get('form.google-settings-form').trigger('submit');
    await vi.waitFor(() => expect(wrapper.text()).toContain(t('googleCalendar.saved')));

    const puts = mutations().filter((request) => request.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0]?.path).toBe('/api/v1/integrations/google/settings');
    expect(puts[0]?.headers['if-match']).toBe(`W/"${version}"`);
    expect(isUuidV7Key(puts[0]?.headers['idempotency-key'] ?? '')).toBe(true);
    expect(puts[0]?.body).toEqual({
      selectedCalendarIds: [GOOGLE_CALENDAR_PRIMARY_ID, GOOGLE_CALENDAR_HOLIDAYS_ID, GOOGLE_CALENDAR_CLUB_ID],
      settings: { exportBlocks: true, exportCommitments: true, dailySummary: false, reminderMinutes: 30 },
    });
    expect(mockDb.google.integration.settings.reminderMinutes).toBe(30);
    expect(wrapper.text()).toContain('저장됨');
    expect(wrapper.get('[data-google-save]').attributes('disabled')).toBeDefined();
  });

  it('a reminder of 없음 is sent as null', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-setting="reminderMinutes"]').setValue('none');
    await wrapper.get('form.google-settings-form').trigger('submit');
    await vi.waitFor(() => expect(mockDb.google.integration.settings.reminderMinutes).toBeNull());
  });

  it('on 412 re-reads and lets the user keep the change; the retry carries the new If-Match', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-setting="exportBlocks"]').setValue(false);
    // Changed elsewhere meanwhile.
    mockDb.google.integration = { ...mockDb.google.integration, version: mockDb.google.integration.version + 1 };
    const serverVersion = mockDb.google.integration.version;
    await wrapper.get('form.google-settings-form').trigger('submit');
    await vi.waitFor(() => expect(dialog().textContent).toContain(t('googleCalendar.conflict.title')));
    expect(mockDb.google.integration.settings.exportBlocks).toBe(true);
    buttonIn(dialog(), t('googleCalendar.conflict.keepLocal')).click();
    await flushPromises();
    expect((wrapper.get('[data-google-setting="exportBlocks"]').element as HTMLInputElement).checked).toBe(false);
    await wrapper.get('form.google-settings-form').trigger('submit');
    await vi.waitFor(() => expect(mockDb.google.integration.settings.exportBlocks).toBe(false));
    const puts = mutations().filter((request) => request.method === 'PUT');
    expect(puts.map((request) => request.headers['if-match'])).toEqual([`W/"${serverVersion - 1}"`, `W/"${serverVersion}"`]);
    // A new If-Match is a new attempt: a new key.
    expect(puts[0]?.headers['idempotency-key']).not.toBe(puts[1]?.headers['idempotency-key']);
  });

  it('on 412 the user can take the server settings instead (negative: nothing is overwritten)', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-setting="exportBlocks"]').setValue(false);
    mockDb.google.integration = { ...mockDb.google.integration, version: mockDb.google.integration.version + 1 };
    await wrapper.get('form.google-settings-form').trigger('submit');
    await vi.waitFor(() => expect(dialog().textContent).toContain(t('googleCalendar.conflict.title')));
    buttonIn(dialog(), t('googleCalendar.conflict.useServer')).click();
    await flushPromises();
    expect((wrapper.get('[data-google-setting="exportBlocks"]').element as HTMLInputElement).checked).toBe(true);
    expect(wrapper.get('[data-google-save]').attributes('disabled')).toBeDefined();
    expect(mutations().filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(mockDb.google.integration.settings.exportBlocks).toBe(true);
  });
});

describe('캘린더 연동: sync now', () => {
  it('runs one sync and says the counts it returned in one sentence', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-sync-now]').trigger('click');
    await vi.waitFor(() =>
      expect(wrapper.get('[data-google-sync-result]').text()).toBe(
        '동기화했어요. 가져온 약속은 새로 1개·바뀜 2개·빠짐 0개, 종일 일정 1개, 폰으로 보낸 일정은 새로 3개·바뀜 1개·지움 0개예요.',
      ),
    );
    const sync = mutations().find((request) => request.path === '/api/v1/integrations/google:sync');
    expect(isUuidV7Key(sync?.headers['idempotency-key'] ?? '')).toBe(true);
    expect(wrapper.find('[data-google-error]').exists()).toBe(false);
  });

  it('says so when Google cannot be reached (503) and shows no counts (negative)', async () => {
    seedGoogle(mockDb, 'connected');
    mockDb.google.syncFailure = 'provider_unavailable';
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-sync-now]').trigger('click');
    await vi.waitFor(() => expect(wrapper.get('[data-google-error]').text()).toBe(t('googleCalendar.sync.unavailable')));
    expect(wrapper.get('[data-google-sync-result]').text()).toBe('');
    // The recorded failure shows as a sentence after the re-read.
    await vi.waitFor(() => expect(wrapper.get('[data-google-last-sync]').text()).toContain(t('googleCalendar.lastError.google_unavailable')));
  });

  it('a revoked grant turns the page to needs_reauth with the reason', async () => {
    seedGoogle(mockDb, 'connected');
    mockDb.google.syncFailure = 'auth_revoked';
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    await wrapper.get('[data-google-sync-now]').trigger('click');
    await ready(wrapper, 'needs_reauth');
    expect(wrapper.get('[data-google-error]').text()).toBe(t('googleCalendar.sync.reauth'));
  });
});

describe('캘린더 연동: disconnect', () => {
  async function openDialog(wrapper: VueWrapper): Promise<HTMLElement> {
    await wrapper.get('[data-google-disconnect]').trigger('click');
    await vi.waitFor(() => expect(dialog().textContent).toContain('구글 연결을 끊을까요?'));
    return dialog();
  }

  it('says what happens, and removes the "OhMyDate" calendar too by default', async () => {
    seedGoogle(mockDb, 'connected');
    const version = mockDb.google.integration.version;
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const sheet = await openDialog(wrapper);
    expect(sheet.textContent).toContain(t('googleCalendar.disconnect.imported'));
    expect(sheet.textContent).toContain('구글의 ‘OhMyDate’ 캘린더도 지우기');
    expect(sheet.querySelector<HTMLInputElement>('[data-google-remove-exported]')?.checked).toBe(true);
    buttonIn(sheet, '연결 끊기').click();
    await ready(wrapper, 'disconnected');
    const sent = mutations().filter((request) => request.method === 'DELETE');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.search).toBe('?removeExported=true');
    expect(sent[0]?.headers['if-match']).toBe(`W/"${version}"`);
    expect(mockDb.google.lastRemoveExported).toBe(true);
    expect([...mockDb.commitments.values()].some((item) => item.source === 'google')).toBe(false);
    expect(wrapper.text()).toContain(t('googleCalendar.disconnect.done'));
    expect(filledButtons()).toEqual(['구글 계정 연결']);
  });

  it('keeps the "OhMyDate" calendar on the phone when the box is unticked', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const sheet = await openDialog(wrapper);
    const box = sheet.querySelector<HTMLInputElement>('[data-google-remove-exported]');
    box?.click();
    await flushPromises();
    buttonIn(sheet, '연결 끊기').click();
    await ready(wrapper, 'disconnected');
    expect(mutations().find((request) => request.method === 'DELETE')?.search).toBe('?removeExported=false');
    expect(mockDb.google.lastRemoveExported).toBe(false);
    expect(wrapper.text()).toContain('‘OhMyDate’ 캘린더는 폰에 남겨 두었어요.');
  });

  it('cancel sends nothing (negative)', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const sheet = await openDialog(wrapper);
    buttonIn(sheet, '취소').click();
    await flushPromises();
    expect(document.body.querySelector('[aria-modal="true"]')).toBeNull();
    expect(mutations()).toEqual([]);
    expect(mockDb.google.integration.status).toBe('connected');
  });

  it('a 412 re-reads and says the state changed, without disconnecting', async () => {
    seedGoogle(mockDb, 'connected');
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const sheet = await openDialog(wrapper);
    mockDb.google.integration = { ...mockDb.google.integration, version: mockDb.google.integration.version + 1 };
    buttonIn(sheet, '연결 끊기').click();
    await vi.waitFor(() => expect(wrapper.get('[data-google-error]').text()).toBe(t('googleCalendar.changed')));
    expect(mockDb.google.integration.status).toBe('connected');
  });
});

describe('캘린더 연동: back from Google (?google=…)', () => {
  it.each([
    ['connected', 'success', '구글 계정을 연결했어요. 몇 초 안에 첫 동기화가 시작돼요.'],
    ['denied', 'warn', t('googleCalendar.returned.denied')],
  ] as const)('?google=%s shows its message once and cleans the URL', async (result, tone, text) => {
    seedGoogle(mockDb, result === 'connected' ? 'connected' : 'disconnected');
    const { wrapper, router } = await mountSettings(`/settings/calendar?google=${result}&keep=1`);
    const banner = await vi.waitFor(() => wrapper.get(`[data-google-returned="${result}"]`));
    expect(banner.text()).toBe(text);
    expect(banner.classes()).toContain(`banner--${tone}`);
    await vi.waitFor(() => expect(router.currentRoute.value.query['google']).toBeUndefined());
    expect(router.currentRoute.value.query['keep']).toBe('1');
    expect(router.currentRoute.value.path).toBe('/settings/calendar');
  });

  it('?google=error is an alert that says how to fix it', async () => {
    seedGoogle(mockDb, 'disconnected');
    const { wrapper, router } = await mountSettings('/settings/calendar?google=error');
    const banner = await vi.waitFor(() => wrapper.get('[data-google-returned="error"]'));
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('주소로 열었는지 확인하고 다시 연결해 주세요');
    await vi.waitFor(() => expect(router.currentRoute.value.query['google']).toBeUndefined());
  });

  it('an unknown value shows nothing but is still cleaned (negative)', async () => {
    seedGoogle(mockDb, 'disconnected');
    const { wrapper, router } = await mountSettings('/settings/calendar?google=granted');
    await ready(wrapper, 'disconnected');
    expect(wrapper.find('[data-google-returned]').exists()).toBe(false);
    await vi.waitFor(() => expect(router.currentRoute.value.query['google']).toBeUndefined());
  });
});

describe('캘린더 연동: lastError in words', () => {
  const CODES: Record<GoogleSyncErrorCode, true> = {
    auth_revoked: true,
    rate_limited: true,
    google_unavailable: true,
    google_rejected: true,
    too_many_events: true,
    run_deadline: true,
    internal_error: true,
  };

  it.each(Object.keys(CODES) as GoogleSyncErrorCode[])('%s is a Korean sentence on the page', async (code) => {
    seedGoogle(mockDb, 'connected');
    mockDb.google.integration = { ...mockDb.google.integration, lastError: code };
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const line = wrapper.get('[data-google-last-sync]').text();
    expect(line).toContain(t(`googleCalendar.lastError.${code}`));
    expect(line).not.toContain(code);
  });

  it('an unknown code falls back to a general sentence, never the raw code (negative)', async () => {
    seedGoogle(mockDb, 'connected');
    mockDb.google.integration = { ...mockDb.google.integration, lastError: 'quota_party' as GoogleSyncErrorCode };
    const { wrapper } = await mountSettings();
    await ready(wrapper, 'connected');
    const line = wrapper.get('[data-google-last-sync]').text();
    expect(line).toContain(t('googleCalendar.lastErrorUnknown'));
    expect(line).not.toContain('quota_party');
  });
});

describe('catalog and helpers (CAL-04)', () => {
  const HANGUL = /[가-힣]/;

  it('has a Korean sentence for every lastError code, status and callback result', () => {
    const codes: GoogleSyncErrorCode[] = [
      'auth_revoked',
      'rate_limited',
      'google_unavailable',
      'google_rejected',
      'too_many_events',
      'run_deadline',
      'internal_error',
    ];
    expect(Object.keys(ko.googleCalendar.lastError).sort()).toEqual([...codes].sort());
    const keys: MessageKey[] = [
      ...codes.map((code) => `googleCalendar.lastError.${code}` as MessageKey),
      'googleCalendar.status.not_configured',
      'googleCalendar.status.disconnected',
      'googleCalendar.status.connected',
      'googleCalendar.status.needs_reauth',
      'googleCalendar.returned.connected',
      'googleCalendar.returned.denied',
      'googleCalendar.returned.error',
      'googleCalendar.lastErrorUnknown',
      'nav.calendarSettings',
      'commitments.google.source',
      'month.legendDayEvent',
    ];
    for (const key of keys) expect(HANGUL.test(String(lookup(key))), key).toBe(true);
  });

  it('reads the callback result and nothing else', () => {
    expect(googleCallbackResult('connected')).toBe('connected');
    expect(googleCallbackResult(['denied'])).toBe('denied');
    expect(googleCallbackResult('error')).toBe('error');
    expect(googleCallbackResult('granted')).toBeNull();
    expect(googleCallbackResult(undefined)).toBeNull();
    expect(googleCallbackResult(null)).toBeNull();
  });

  it('allows only Google consent or this app as the place to go', () => {
    const app = 'http://127.0.0.1:5180';
    expect(isAllowedAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1', app)).toBe(true);
    expect(isAllowedAuthorizationUrl('http://127.0.0.1:5180/settings/calendar?google=connected', app)).toBe(true);
    for (const bad of [
      'http://accounts.google.com/o/oauth2',
      'https://accounts.google.com.evil.example/',
      'https://user:pw@accounts.google.com/',
      'javascript:alert(1)',
      '/settings/calendar',
      'http://localhost:5180/settings/calendar',
      '',
      42,
      null,
    ]) {
      expect(isAllowedAuthorizationUrl(bad, app), String(bad)).toBe(false);
    }
  });

  it('keeps a stored reminder that is not on the list, and maps none to null', () => {
    expect(reminderChoices(10)).toEqual([null, 0, 5, 10, 15, 30, 60]);
    expect(reminderChoices(20)).toEqual([null, 0, 5, 10, 15, 20, 30, 60]);
    expect(reminderOptionValue(null)).toBe('none');
    expect(reminderFromOptionValue('none')).toBeNull();
    expect(reminderFromOptionValue('15')).toBe(15);
    expect(reminderFromOptionValue('-3')).toBeNull();
  });

  it('sends only calendars the server listed, in its order (negative: an unknown id is dropped)', () => {
    const calendars = [
      { id: 'a', selected: true },
      { id: 'b', selected: false },
      { id: 'c', selected: true },
    ];
    const settings = { exportBlocks: true, exportCommitments: false, dailySummary: true, reminderMinutes: null };
    const draft = { selected: ['c', 'gone', 'a'], settings };
    expect(settingsPutBody(draft, calendars)).toEqual({ selectedCalendarIds: ['a', 'c'], settings });
    expect(sameDraft(draftFrom({ calendars, settings }), { selected: ['c', 'a'], settings })).toBe(true);
    expect(sameDraft(draftFrom({ calendars, settings }), { selected: ['a'], settings })).toBe(false);
  });

  it('writes the address to open the app at as 127.0.0.1, never localhost', () => {
    expect(localWebOrigin({ protocol: 'http:', hostname: 'localhost', port: '5180' })).toBe('http://127.0.0.1:5180');
    expect(localWebOrigin({ protocol: 'http:', hostname: '127.0.0.1', port: '5199' })).toBe('http://127.0.0.1:5199');
    expect(localWebOrigin(null)).toBe('http://127.0.0.1:5180');
    expect(GOOGLE_SETUP.clientFile).toBe('deploy/secrets/local/google-oauth-client.json');
  });
});
