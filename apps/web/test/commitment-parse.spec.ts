/**
 * CAL-02 "말로 적기", in the planner's 약속 추가 dialog (HOLO-04: the 약속
 * screen it used to open on is gone): read a note into drafts, add one / all,
 * 고치기 into the manual fields, 빼기, a draft without a time, the leftover,
 * consent, failures that keep the note and the manual fields, offline, the one
 * filled button, and the section's a11y. MSW mock API (mocks/commitment-parse.ts).
 */
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, h, onUnmounted } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { CommitmentDraft, User } from '../src/api';
import { createPlannerClient, newActionId } from '../src/api';
import LlmConsentDialog from '../src/components/LlmConsentDialog.vue';
import {
  clockMinutes,
  draftCreateInput,
  draftFormValues,
  weeklyRepeatOf,
} from '../src/domain/commitmentDraft';
import { localParts, todayInZone, addDaysToDate } from '../src/domain/time';
import { readCommitmentNote } from '../src/mocks/commitment-parse';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { useAuthStore } from '../src/stores/auth';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import { useOfflineStore } from '../src/stores/offline';
import CommitmentAddDialog from '../src/components/planner/CommitmentAddDialog.vue';
import { mountWithPlugins, settle } from './planning-test-utils';

const ZONE = 'Asia/Seoul';
const TWO = '내일 오후 3시에 치과, 모레 저녁 7시부터 9시까지 동창 모임';

function router() {
  const Stub = defineComponent({ render: () => h('div') });
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/commitments', component: Stub },
      { path: '/settings/ai', component: Stub },
    ],
  });
}

/** The consent dialog exactly as AppShell hosts it (FU-91). */
const ConsentHost = defineComponent({
  setup() {
    const consent = useLlmConsentStore();
    onUnmounted(consent.attachHost());
    return () => h(LlmConsentDialog, { open: consent.open, onClose: () => consent.closed() });
  },
});

interface Recorded {
  readonly method: string;
  readonly path: string;
}

function recordRequests(): Recorded[] {
  const seen: Recorded[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push({ method: request.method, path: new URL(request.url).pathname });
  });
  return seen;
}

function parseRequests(seen: readonly Recorded[]): number {
  return seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/commitments:parse')).length;
}

async function mountView(pinia: Pinia = createPinia()): Promise<VueWrapper> {
  const wrapper = mountWithPlugins(CommitmentAddDialog, {
    pinia,
    router: router(),
    props: { timeZone: ZONE, date: todayInZone(ZONE) },
  });
  await settle();
  await vi.waitFor(() => expect(wrapper.find('#commitment-note').exists()).toBe(true));
  return wrapper;
}

async function read(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('#commitment-note').setValue(text);
  await wrapper.get('form.nl-entry-form').trigger('submit');
  await settle();
}

function rows(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="nl-draft"]');
}

function row(wrapper: VueWrapper, index: number): DOMWrapper<Element> {
  const found = rows(wrapper)[index];
  if (found === undefined) throw new Error(`draft row ${index} not found`);
  return found;
}

function buttonIn(scope: { findAll(selector: string): DOMWrapper<Element>[] }, label: string) {
  const found = scope.findAll('button').find((item) => item.text().endsWith(label) || item.text() === label);
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function readButton(wrapper: VueWrapper) {
  return wrapper.get('form.nl-entry-form button[type="submit"]');
}

function manualSubmit(wrapper: VueWrapper) {
  return wrapper.get('[data-planner-add-manual] button[type="submit"]');
}

function filledButtons(wrapper: VueWrapper): string[] {
  return wrapper.findAll('button.btn--primary').map((item) => item.text());
}

function problem(status: number, code: string): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'x', status, code, detail: 'synthetic' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('commitmentDraft helpers', () => {
  const untimed: CommitmentDraft = { title: '영화', timeZone: ZONE, date: '2026-11-21', notes: [] };

  it('a draft without a time is not ready until a valid start (and an end after it, if given)', () => {
    expect(draftCreateInput(untimed, { start: '', end: '' })).toBeNull();
    expect(draftCreateInput(untimed, { start: '25:00', end: '' })).toBeNull();
    expect(draftCreateInput(untimed, { start: '19:00', end: '18:00' })).toBeNull();
    expect(draftCreateInput(untimed, { start: '19:00', end: 'x' })).toBeNull();
    expect(draftCreateInput(untimed, { start: '19:00', end: '' })).toEqual({
      title: '영화',
      startAt: '2026-11-21T10:00:00.000Z',
      endAt: '2026-11-21T11:00:00.000Z',
      timeZone: ZONE,
    });
    expect(clockMinutes('07:30')).toBe(450);
    expect(clockMinutes('7:30')).toBeNull();
  });

  it('a timed draft keeps its own instants and RRULE; 고치기 opens it as local form values', () => {
    const weekly: CommitmentDraft = {
      title: '스터디',
      timeZone: ZONE,
      date: '2026-11-19',
      startAt: '2026-11-19T10:00:00.000Z',
      endAt: '2026-11-19T11:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231',
      notes: ['duration_defaulted', 'repeats_weekly'],
    };
    expect(draftCreateInput(weekly, { start: '', end: '' })).toMatchObject({ rrule: weekly.rrule, startAt: weekly.startAt });
    expect(draftFormValues(weekly, { start: '', end: '' })).toEqual({
      title: '스터디',
      startLocal: '2026-11-19T19:00',
      endLocal: '2026-11-19T20:00',
      timeZone: ZONE,
      rrule: weekly.rrule,
    });
    expect(draftFormValues(untimed, { start: '', end: '' })).toMatchObject({ startLocal: '2026-11-21T09:00' });
    expect(weeklyRepeatOf(weekly.rrule)).toEqual({ days: ['TH'], until: '2026-12-31' });
    expect(weeklyRepeatOf('FREQ=DAILY')).toBeNull();
    expect(weeklyRepeatOf(undefined)).toBeNull();
  });
});

describe('mock reader (VITE_MOCK and tests)', () => {
  it('reads the fixed phrase shapes and leaves the rest', () => {
    const now = Date.now();
    const tomorrow = addDaysToDate(todayInZone(ZONE, now), 1);
    const result = readCommitmentNote('내일 오후 3시에 치과, 보고서 쓰기', ZONE, now);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ title: '치과', date: tomorrow, notes: ['duration_defaulted'] });
    expect(localParts(result.drafts[0]?.startAt as string, ZONE)).toMatchObject({ date: tomorrow, hour: 15, minute: 0 });
    expect(result.leftover).toBe('보고서 쓰기');
    expect(readCommitmentNote('요즘 너무 피곤하다', ZONE, now)).toEqual({ drafts: [], leftover: '요즘 너무 피곤하다' });
  });

  it('the mock route answers like the API, replays a key and rejects a blank note (negative)', async () => {
    const client = createPlannerClient();
    const key = newActionId('commitment-parse');
    const first = await client.parseCommitments(TWO, key);
    expect(first.drafts.map((draft) => draft.title)).toEqual(['치과', '동창 모임']);
    expect(await client.parseCommitments(TWO, key)).toEqual(first);
    expect(mockDb.commitments.size).toBeGreaterThan(0);
    const before = mockDb.commitments.size;
    await expect(client.parseCommitments('   ', newActionId('commitment-parse'))).rejects.toMatchObject({ status: 400 });
    expect(mockDb.commitments.size).toBe(before);
  });
});

describe('/commitments 말로 적기', () => {
  it('reads a note into ruled draft rows, announces the count and moves focus to the result', async () => {
    const wrapper = await mountView();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(rows(wrapper)[0]?.text()).toContain('치과');
    expect(rows(wrapper)[0]?.text()).toContain('오후 3:00');
    expect(rows(wrapper)[0]?.text()).toContain('끝 시간을 1시간 뒤로 잡았어요.');
    expect(rows(wrapper)[1]?.text()).toContain('동창 모임');
    expect(rows(wrapper)[1]?.text()).toContain('오후 7:00~9:00');
    const live = wrapper.get('[data-testid="nl-entry"] [role="status"]');
    expect(live.attributes('aria-live')).toBe('polite');
    expect(live.text()).toBe('약속 2개를 읽었어요.');
    expect(document.activeElement?.id).toBe('nl-result-heading');
    // Nothing is saved by the read.
    expect([...mockDb.commitments.values()].some((item) => item.title === '치과')).toBe(false);
    wrapper.unmount();
  });

  it('adds one draft through the create call: the row turns done', async () => {
    const seen = recordRequests();
    const wrapper = await mountView();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect(rows(wrapper)[0]?.text()).toContain('추가했어요'));
    const created = [...mockDb.commitments.values()].find((item) => item.title === '치과');
    expect(created).toBeDefined();
    expect(created?.timeZone).toBe(ZONE);
    expect(wrapper.get('[data-testid="nl-entry"] [role="status"]').text()).toBe('‘치과’ 약속을 추가했어요.');
    expect(seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/commitments'))).toHaveLength(1);
    // The other draft is still there to add.
    expect(rows(wrapper)[1]?.text()).not.toContain('추가했어요');
    wrapper.unmount();
  });

  it('adds every ready draft with one action, one idempotency key each; the note clears when all are in', async () => {
    const keys: string[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/commitments')) {
        keys.push(request.headers.get('Idempotency-Key') ?? '');
      }
    });
    const wrapper = await mountView();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    const addAll = wrapper.get('[data-testid="nl-add-all"]');
    expect(addAll.text()).toBe('2개 모두 추가');
    await addAll.trigger('click');
    await settle();
    await vi.waitFor(() => expect(rows(wrapper).every((row) => row.text().includes('추가했어요'))).toBe(true));
    expect(new Set(keys).size).toBe(2);
    expect(wrapper.get('[data-testid="nl-entry"] [role="status"]').text()).toBe('약속 2개를 추가했어요.');
    expect((wrapper.get('#commitment-note').element as HTMLTextAreaElement).value).toBe('');
    wrapper.unmount();
  });

  it('고치기 loads the draft into the manual form, which then holds the filled button', async () => {
    const wrapper = await mountView();
    await read(wrapper, '내일 오후 3시에 치과');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    await buttonIn(row(wrapper, 0), '고치기').trigger('click');
    await settle();
    expect((wrapper.get('#planner-commitment-title').element as HTMLInputElement).value).toBe('치과');
    const start = (wrapper.get('#planner-commitment-start').element as HTMLInputElement).value;
    expect(start.endsWith('T15:00')).toBe(true);
    expect(rows(wrapper)).toHaveLength(0);
    expect(wrapper.get('[data-testid="nl-entry"] [role="status"]').text()).toContain('직접 입력 칸으로 옮겼어요');
    expect(filledButtons(wrapper)).toEqual(['약속 추가']);
    // The manual form behaves as before: it creates the commitment.
    await wrapper.get('[data-planner-add-manual]').trigger('submit');
    await settle();
    await vi.waitFor(() => expect([...mockDb.commitments.values()].some((item) => item.title === '치과')).toBe(true));
    wrapper.unmount();
  });

  it('빼기 removes a draft without saving anything', async () => {
    const wrapper = await mountView();
    const before = mockDb.commitments.size;
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    await buttonIn(row(wrapper, 0), '빼기').trigger('click');
    await settle();
    expect(rows(wrapper)).toHaveLength(1);
    expect(rows(wrapper)[0]?.text()).toContain('동창 모임');
    expect(wrapper.get('[data-testid="nl-entry"] [role="status"]').text()).toBe('‘치과’ 초안을 뺐어요.');
    expect(mockDb.commitments.size).toBe(before);
    wrapper.unmount();
  });

  it('a draft without a time asks for one and cannot be added until it has a valid start (negative)', async () => {
    const wrapper = await mountView();
    await read(wrapper, '다음 주 토요일 영화 보기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    const untimed = row(wrapper, 0);
    expect(untimed.text()).toContain('시간 필요');
    expect(untimed.text()).toContain('시작 시간을 넣으면 추가할 수 있어요');
    const add = buttonIn(untimed, '추가');
    expect(add.attributes('disabled')).toBeDefined();
    const [start, end] = untimed.findAll('input[type="time"]');
    expect(untimed.find(`label[for="${start?.attributes('id')}"]`).text()).toBe('시작 시간');
    await end?.setValue('20:00');
    await start?.setValue('21:00');
    await settle();
    expect(untimed.text()).toContain('끝 시간이 시작보다 늦어야 해요.');
    expect(buttonIn(row(wrapper, 0), '추가').attributes('disabled')).toBeDefined();
    await end?.setValue('');
    await start?.setValue('19:30');
    await settle();
    expect(rows(wrapper)[0]?.text()).toContain('끝 시간을 1시간 뒤로 잡았어요.');
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect([...mockDb.commitments.values()].some((item) => item.title === '영화 보기')).toBe(true));
    const created = [...mockDb.commitments.values()].find((item) => item.title === '영화 보기');
    expect(localParts(created?.startAt as string, created?.timeZone as string)).toMatchObject({ hour: 19, minute: 30 });
    wrapper.unmount();
  });

  it('shows what it could not read as 읽지 못한 부분', async () => {
    const wrapper = await mountView();
    await read(wrapper, '내일 오후 3시에 치과, 보고서 쓰기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(wrapper.get('.nl-leftover').text()).toBe('읽지 못한 부분: 보고서 쓰기');
    await read(wrapper, '요즘 너무 피곤하다');
    await vi.waitFor(() => expect(wrapper.text()).toContain('약속으로 읽을 부분을 찾지 못했어요.'));
    expect(rows(wrapper)).toHaveLength(0);
    expect(wrapper.get('.nl-leftover').text()).toBe('읽지 못한 부분: 요즘 너무 피곤하다');
    wrapper.unmount();
  });

  it('Enter reads; Shift+Enter and an IME composition do not (negative)', async () => {
    const seen = recordRequests();
    const wrapper = await mountView();
    const note = wrapper.get('#commitment-note');
    await note.setValue('내일 오후 3시에 치과');
    await note.trigger('keydown', { key: 'Enter', shiftKey: true });
    await note.trigger('keydown', { key: 'Enter', isComposing: true });
    await settle();
    expect(parseRequests(seen)).toBe(0);
    await note.trigger('keydown', { key: 'Enter' });
    await settle();
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(parseRequests(seen)).toBe(1);
    wrapper.unmount();
  });

  it('one filled button at a time: 읽기, then the add action, then the manual form when in use', async () => {
    const wrapper = await mountView();
    expect(readButton(wrapper).classes()).toContain('btn--primary');
    expect(manualSubmit(wrapper).classes()).not.toContain('btn--primary');
    expect(readButton(wrapper).attributes('disabled')).toBeDefined(); // nothing to read yet
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(filledButtons(wrapper)).toEqual(['2개 모두 추가']);
    await wrapper.get('#planner-commitment-title').setValue('직접 쓰는 약속');
    await settle();
    expect(filledButtons(wrapper)).toEqual(['약속 추가']);
    await wrapper.get('#planner-commitment-title').setValue('');
    await buttonIn(row(wrapper, 1), '빼기').trigger('click');
    await settle();
    // One ready draft: its own 추가 is the filled button.
    expect(filledButtons(wrapper)).toEqual(['치과 추가']);
    wrapper.unmount();
  });

  it('cancel stops the read, keeps the note and lets the next read start fresh', async () => {
    let resolveHeld: () => void = () => undefined;
    server.use(
      http.post(/\/api\/v1\/commitments:parse$/, async () => {
        await new Promise<void>((resolve) => {
          resolveHeld = resolve;
        });
        return problem(503, 'llm_unavailable');
      }),
    );
    const wrapper = await mountView();
    await wrapper.get('#commitment-note').setValue(TWO);
    await wrapper.get('form.nl-entry-form').trigger('submit');
    await settle();
    const wait = wrapper.get('[data-testid="nl-wait"]');
    expect(wait.text()).toContain('AI가 메모를 읽고 있어요');
    // The elapsed time appears from the first second on (no "0초").
    expect(wait.find('[role="timer"]').exists()).toBe(false);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="nl-wait"] [role="timer"]').text()).toBe('1초 지났어요'), {
      timeout: 3_000,
    });
    await buttonIn(wrapper.get('[data-testid="nl-wait"]'), '취소').trigger('click');
    await settle();
    resolveHeld();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="nl-wait"]').exists()).toBe(false));
    expect(wrapper.get('[data-testid="nl-entry"] [role="status"]').text()).toBe('읽기를 멈췄어요. 메모는 그대로 있어요.');
    expect((wrapper.get('#commitment-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    ['llm_unavailable', '지금은 AI로 읽을 수 없어요.'],
    ['budget_exceeded', 'AI 사용 한도에 닿아 지금은 읽을 수 없어요.'],
  ])('%s: one line, the note stays and the manual form still works (negative)', async (code, line) => {
    server.use(http.post(/\/api\/v1\/commitments:parse$/, () => problem(503, code)));
    const wrapper = await mountView();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(wrapper.get('.nl-failure').text()).toContain(line));
    expect(wrapper.get('.nl-failure').attributes('role')).toBe('alert');
    expect((wrapper.get('#commitment-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(rows(wrapper)).toHaveLength(0);
    await wrapper.get('#planner-commitment-title').setValue('직접 적은 치과');
    await wrapper.get('[data-planner-add-manual]').trigger('submit');
    await settle();
    await vi.waitFor(() => expect([...mockDb.commitments.values()].some((item) => item.title === '직접 적은 치과')).toBe(true));
    wrapper.unmount();
  });

  it('offline: reading and adding are disabled (negative)', async () => {
    const pinia = createPinia();
    const wrapper = await mountView(pinia);
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    useOfflineStore(pinia).setOnline(false);
    await settle();
    expect(readButton(wrapper).attributes('disabled')).toBeDefined();
    expect(buttonIn(row(wrapper, 0), '추가').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="nl-add-all"]').attributes('disabled')).toBeDefined();
    const before = mockDb.commitments.size;
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    expect(mockDb.commitments.size).toBe(before);
    wrapper.unmount();
  });

  it('a11y: the note has a label and help, the result is a labelled region, every row action names its draft', async () => {
    const wrapper = await mountView();
    const note = wrapper.get('#commitment-note');
    expect(wrapper.get('label[for="commitment-note"]').text()).toBe('약속 메모');
    const describedby = note.attributes('aria-describedby') ?? '';
    expect(describedby.length).toBeGreaterThan(0);
    expect(document.getElementById(describedby)?.textContent).toContain('Shift+Enter');
    expect(wrapper.get('[data-testid="nl-entry"]').attributes('aria-labelledby')).toBe('nl-entry-heading');
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(wrapper.get('[data-testid="nl-result"]').attributes('aria-labelledby')).toBe('nl-result-heading');
    expect(wrapper.get('#nl-result-heading').attributes('tabindex')).toBe('-1');
    const group = rows(wrapper)[0]?.get('[role="group"]');
    expect(group?.attributes('aria-label')).toBe('치과 초안');
    expect(buttonIn(row(wrapper, 0), '추가').text()).toBe('치과 추가');
    wrapper.unmount();
  });
});

describe('/commitments 말로 적기: AI consent (FU-91 rules)', () => {
  function deepseek(consent?: { granted: boolean }): User {
    return {
      ...mockDb.user,
      llmProvider: 'deepseek',
      ...(consent === undefined
        ? { llm: {} }
        : { llm: { consent: { ...consent, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } } }),
    };
  }

  async function signedIn(user: User): Promise<Pinia> {
    mockDb.user = user;
    const pinia = createPinia();
    await useAuthStore(pinia).loadCurrent();
    return pinia;
  }

  function consentEndpoint(): void {
    server.use(
      http.patch('*/api/v1/me/settings', async ({ request }) => {
        const body = (await request.json()) as { llm?: { consent?: { granted?: boolean } } };
        const granted = body.llm?.consent?.granted === true;
        mockDb.user = {
          ...mockDb.user,
          version: mockDb.user.version + 1,
          llm: { consent: { granted, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
        };
        return HttpResponse.json(mockDb.user as unknown as Record<string, unknown>, {
          headers: { ETag: `W/"${mockDb.user.version}"` },
        });
      }),
    );
  }

  it('undecided: 읽기 opens the consent dialog first and reads once AI is allowed', async () => {
    consentEndpoint();
    const seen = recordRequests();
    const pinia = await signedIn(deepseek());
    useLlmConsentStore(pinia).closed(); // dismissed once earlier: only an AI action asks again
    const host = mountWithPlugins(ConsentHost, { pinia });
    const wrapper = await mountView(pinia);
    await wrapper.get('#commitment-note').setValue(TWO);
    await wrapper.get('form.nl-entry-form').trigger('submit');
    await vi.waitFor(() => expect(document.body.textContent).toContain('AI 계획 도움을 쓸까요?'));
    expect(parseRequests(seen)).toBe(0);
    const allow = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.includes('AI 계획 도움 허용'));
    allow?.click();
    await vi.waitFor(() => expect(parseRequests(seen)).toBe(1));
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    wrapper.unmount();
    host.unmount();
  });

  it('AI turned off (직접 작성 모드): no request, one line that offers to turn it on right there, the manual form beside it (negative)', async () => {
    const seen = recordRequests();
    const pinia = await signedIn(deepseek({ granted: false }));
    const wrapper = await mountView(pinia);
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(wrapper.find('.nl-failure').exists()).toBe(true));
    expect(wrapper.get('.nl-failure').text()).toContain('AI를 쓰지 않도록 설정되어 있어요.');
    // HOLO-04 (FLOW §1): the way on is asked for right here — the consent dialog, not a link to 설정.
    expect(wrapper.find('.nl-failure a').exists()).toBe(false);
    const turnOn = wrapper.get('.nl-failure [data-nl-consent]');
    expect(turnOn.text()).toBe('여기서 AI 켜기');
    const consent = useLlmConsentStore(pinia);
    const detach = consent.attachHost();
    expect(consent.open).toBe(false); // turned off by answer: the dialog does not come by itself
    await turnOn.trigger('click');
    expect(consent.open).toBe(true);
    detach();
    expect(parseRequests(seen)).toBe(0);
    expect((wrapper.get('#commitment-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(wrapper.find('#planner-commitment-title').attributes('disabled')).toBeUndefined();
    // The disclosure the wizard uses is one click away.
    expect(wrapper.get('.nl-entry-disclosure summary').text()).toBe('AI에 보내는 내용');
    expect(wrapper.get('.nl-entry-disclosure').text()).toContain('말로 적기');
    wrapper.unmount();
  });
});
