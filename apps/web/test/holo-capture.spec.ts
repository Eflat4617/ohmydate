import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, h, nextTick, onUnmounted } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../src/api';
import LlmConsentDialog from '../src/components/LlmConsentDialog.vue';
import CaptureBar from '../src/components/capture/CaptureBar.vue';
import {
  captureCreateInput,
  captureKindOf,
  captureNeedsReading,
  captureNextStep,
  captureSegments,
  captureTitle,
  fieldsOfCommitmentDraft,
  fieldsOfTaskDraft,
  flipCapture,
  matchesSearch,
  segmentKind,
  withTypedStart,
  type CaptureFields,
} from '../src/domain/capture';
import { localDateOf } from '../src/domain/time';
import { setLayoutClock } from '../src/layout/clock';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { OWNER_STORAGE_KEY } from '../src/session/owner';
import { adoptActiveOwner } from '../src/session/ownerEpoch';
import { useAuthStore } from '../src/stores/auth';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import { useOfflineStore } from '../src/stores/offline';
import { useUiStore } from '../src/stores/ui';

/**
 * HOLO-04 담기 (FLOW.md §2 ①, §4): the capture bar. One line in plain Korean
 * becomes to-dos and appointments; a line that needs no reading is added at
 * once; when the AI cannot be used the line is a to-do's title; and the
 * ending is the next stage — "계획에 넣을까요?".
 * The mock's day is 2026-11-14 (Sat) in Asia/Seoul.
 */
const ZONE = 'Asia/Seoul';
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const OTHER_OWNER = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77';
const Stub = defineComponent({ template: '<div />' });
const mounted: VueWrapper[] = [];

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/tasks', name: 'tasks', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/plan', name: 'plan', component: Stub },
      { path: '/plan/schedule', name: 'plan-scope', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/focus', name: 'focus-home', component: Stub },
      { path: '/insights', name: 'insights', component: Stub },
      { path: '/notes', name: 'notes', component: Stub },
      { path: '/settings', name: 'settings', component: Stub },
    ],
  });
}

interface Recorded {
  readonly method: string;
  readonly path: string;
  readonly key: string;
}

function recordRequests(): Recorded[] {
  const seen: Recorded[] = [];
  server.events.on('request:start', ({ request }) => {
    seen.push({ method: request.method, path: new URL(request.url).pathname, key: request.headers.get('Idempotency-Key') ?? '' });
  });
  return seen;
}

const reads = (seen: readonly Recorded[], kind: 'tasks' | 'commitments') =>
  seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith(`/${kind}:parse`));
const creates = (seen: readonly Recorded[], kind: 'tasks' | 'commitments') =>
  seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith(`/api/v1/${kind}`));

/** The consent dialog exactly as AppShell hosts it: capture must never open it. */
const ConsentHost = defineComponent({
  setup() {
    const consent = useLlmConsentStore();
    onUnmounted(consent.attachHost());
    return () => h(LlmConsentDialog, { open: consent.open, onClose: () => consent.closed() });
  },
});

interface Mounted {
  readonly wrapper: VueWrapper;
  readonly router: Router;
  readonly pinia: Pinia;
}

async function mountBar(options: { pinia?: Pinia; variant?: 'bar' | 'sheet'; host?: boolean } = {}): Promise<Mounted> {
  const pinia = options.pinia ?? createPinia();
  if (options.pinia === undefined) await useAuthStore(pinia).loadCurrent();
  const router = testRouter();
  await router.push('/planner');
  const Host = defineComponent({
    setup: () => () => [h(CaptureBar, { variant: options.variant ?? 'bar' }), options.host === true ? h(ConsentHost) : null],
  });
  const wrapper = mount(Host, { global: { plugins: [pinia, VueQueryPlugin, router] as never }, attachTo: document.body });
  mounted.push(wrapper);
  await flushPromises();
  return { wrapper, router, pinia };
}

const input = (wrapper: VueWrapper) => wrapper.get<HTMLInputElement>('[data-capture-input]');
const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-capture-row]');

/** Type a line and press Enter (the form's submit). */
async function enter(wrapper: VueWrapper, text: string): Promise<void> {
  await input(wrapper).trigger('focus');
  await input(wrapper).setValue(text);
  await wrapper.get('[data-capture-form]').trigger('submit');
  await flushPromises();
}

function taskTitled(title: string) {
  return [...mockDb.tasks.values()].filter((task) => task.title === title && task.deletedAt === undefined);
}

function deepseek(consent?: { granted: boolean }): User {
  return {
    ...mockDb.user,
    llmProvider: 'deepseek',
    ...(consent === undefined ? { llm: {} } : { llm: { consent: { ...consent, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } } }),
  };
}

async function signedIn(user: User): Promise<Pinia> {
  mockDb.user = user;
  const pinia = createPinia();
  await useAuthStore(pinia).loadCurrent();
  return pinia;
}

function unavailable(code: string): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'x', status: 503, code, detail: 'synthetic' },
    { status: 503, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(OWNER_STORAGE_KEY, mockDb.user.id);
  adoptActiveOwner(mockDb.user.id, 'bootstrap');
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
  adoptActiveOwner(null, 'bootstrap');
  document.body.innerHTML = '';
});

// ── What a line looks like ──────────────────────────────────────────────────

describe('담기 — what a line looks like (domain/capture.ts)', () => {
  it('splits a line into the things it names', () => {
    expect(captureSegments('금요일까지 보고서 초안, 내일 장보기')).toEqual(['금요일까지 보고서 초안', '내일 장보기']);
    expect(captureSegments('빨래\n설거지；청소 그리고 장보기')).toEqual(['빨래', '설거지', '청소', '장보기']);
    expect(captureSegments('  ,  ')).toEqual([]);
  });

  it('an appointment has a clock time or is a kind of meeting; a deadline is a to-do', () => {
    expect(segmentKind('내일 오후 3시에 치과')).toBe('commitment');
    expect(segmentKind('수요일 팀 회의')).toBe('commitment');
    expect(segmentKind('15:30 면담')).toBe('commitment');
    // "by then" is a deadline even with a clock time (negative).
    expect(segmentKind('내일 3시까지 보고서')).toBe('task');
    expect(segmentKind('금요일까지 회의 자료 제출')).toBe('task');
    expect(segmentKind('장보기')).toBe('task');
  });

  it('picks the appointment reader only when everything on the line is one', () => {
    expect(captureKindOf('내일 오후 3시에 치과')).toBe('commitment');
    expect(captureKindOf('내일 오후 3시에 치과, 모레 저녁 7시 동창 모임')).toBe('commitment');
    // Mixed: the to-do reader, whose drafts flip without losing their time.
    expect(captureKindOf('내일 오후 3시에 치과, 금요일까지 보고서')).toBe('task');
    expect(captureKindOf('장보기')).toBe('task');
    expect(captureKindOf('')).toBe('task');
  });

  it('reads only what needs reading: one thing without a day or a time is its own title', () => {
    expect(captureNeedsReading('장보기')).toBe(false);
    expect(captureNeedsReading('교수님께 메일 보내기')).toBe(false);
    expect(captureNeedsReading('내일 장보기')).toBe(true);
    expect(captureNeedsReading('보고서 초안 금요일까지')).toBe(true);
    expect(captureNeedsReading('3시 치과')).toBe(true);
    expect(captureNeedsReading('빨래, 설거지')).toBe(true);
    expect(captureNeedsReading('   ')).toBe(false);
  });

  it('makes a title of a line: one line, trimmed, within the limit', () => {
    expect(captureTitle('  장보기 \n  우유 ')).toBe('장보기 우유');
    expect(Array.from(captureTitle('가'.repeat(260)))).toHaveLength(200);
  });

  it('flips a to-do into an appointment at its deadline for an hour, and back without losing the time', () => {
    const task = fieldsOfTaskDraft({ title: '치과', dueAt: '2026-11-15T06:00:00.000Z', notes: [] }, ZONE);
    const appointment = flipCapture(task);
    expect(appointment).toMatchObject({ kind: 'commitment', at: '2026-11-15T06:00:00.000Z', endAt: '2026-11-15T07:00:00.000Z', timeZone: ZONE });
    expect(flipCapture(appointment)).toMatchObject({ kind: 'task', at: '2026-11-15T06:00:00.000Z', endAt: null });
  });

  it('a to-do without a deadline becomes an appointment without a time, which cannot be added yet (negative)', () => {
    const appointment = flipCapture(fieldsOfTaskDraft({ title: '면담', notes: [] }, ZONE));
    expect(appointment).toMatchObject({ kind: 'commitment', at: null, endAt: null });
    expect(captureCreateInput(appointment)).toBeNull();
    const timed = withTypedStart(appointment, '2026-11-16T10:00');
    expect(timed).toMatchObject({ at: '2026-11-16T01:00:00.000Z', endAt: '2026-11-16T02:00:00.000Z' });
    expect(captureCreateInput(timed)).toEqual({
      kind: 'commitment',
      body: { title: '면담', startAt: '2026-11-16T01:00:00.000Z', endAt: '2026-11-16T02:00:00.000Z', timeZone: ZONE },
    });
    // A start that is no date-time leaves it without one.
    expect(withTypedStart(appointment, 'soon')).toMatchObject({ at: null, endAt: null });
  });

  it('an appointment that had only a day is due at the end of that day as a to-do; its repeat rule is kept', () => {
    const draft = { title: '수업', date: '2026-11-18', timeZone: ZONE, rrule: 'FREQ=WEEKLY;BYDAY=WE', notes: [] };
    const fields = fieldsOfCommitmentDraft(draft as never);
    expect(fields).toMatchObject({ kind: 'commitment', at: null, rrule: 'FREQ=WEEKLY;BYDAY=WE' });
    const task = flipCapture(fields, draft.date);
    expect(task).toMatchObject({ kind: 'task', at: '2026-11-18T14:59:00.000Z' });
    expect(captureCreateInput(task)).toEqual({ kind: 'task', body: { title: '수업', dueAt: '2026-11-18T14:59:00.000Z' } });
    expect(flipCapture(task).rrule).toBe('FREQ=WEEKLY;BYDAY=WE');
  });

  it('adds nothing without a title, and no appointment that ends before it starts (negative)', () => {
    const base: CaptureFields = { kind: 'task', title: '  ', at: null, endAt: null, rrule: undefined, timeZone: ZONE };
    expect(captureCreateInput(base)).toBeNull();
    expect(captureCreateInput({ ...base, title: '가'.repeat(201) })).toBeNull();
    expect(captureCreateInput({ ...base, title: '장보기' })).toEqual({ kind: 'task', body: { title: '장보기' } });
    expect(
      captureCreateInput({ ...base, kind: 'commitment', title: '회의', at: '2026-11-16T02:00:00.000Z', endAt: '2026-11-16T01:00:00.000Z' }),
    ).toBeNull();
  });

  it('the next step is the plan with the new to-dos picked; appointments alone lead to the planner', () => {
    expect(
      captureNextStep([
        { kind: 'task', id: 'a', title: 'x', at: null },
        { kind: 'commitment', id: 'c', title: 'y', at: '2026-11-16T01:00:00.000Z' },
        { kind: 'task', id: 'b', title: 'z', at: null },
      ]),
    ).toEqual({ to: 'plan', taskIds: ['a', 'b'] });
    expect(captureNextStep([{ kind: 'commitment', id: 'c', title: 'y', at: '2026-11-16T01:00:00.000Z' }])).toEqual({
      to: 'planner',
      at: '2026-11-16T01:00:00.000Z',
    });
    expect(captureNextStep([])).toBeNull();
  });

  it('search matches every word typed, in any case; an empty query matches nothing (negative)', () => {
    expect(matchesSearch('졸업 논문 3장 초고', '논문 초고')).toBe(true);
    expect(matchesSearch('Weekly Review', 'weekly')).toBe(true);
    expect(matchesSearch('졸업 논문 3장 초고', '논문 발표')).toBe(false);
    expect(matchesSearch('졸업 논문', '  ')).toBe(false);
  });
});

// ── The bar ─────────────────────────────────────────────────────────────────

describe('담기 줄 — a line becomes a to-do', () => {
  it('is a labelled field whose panel opens with the focus, in glass', async () => {
    const { wrapper } = await mountBar();
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(false);
    expect(input(wrapper).attributes('aria-expanded')).toBe('false');
    expect(wrapper.get('label').text()).toBe('할 일이나 약속 적기');
    expect(input(wrapper).attributes('placeholder')).toBe('할 일이나 약속을 말로 적어 보세요');

    await input(wrapper).trigger('focus');
    const panel = wrapper.get('[data-capture-panel]');
    expect(panel.classes()).toContain('glass');
    expect(input(wrapper).attributes('aria-expanded')).toBe('true');
    expect(input(wrapper).attributes('aria-controls')).toBe(panel.attributes('id'));
    expect(wrapper.get('[data-capture-hint]').text()).toContain('엔터로 담아요');
    // Nothing to add yet: the one filled button is inert (negative).
    expect(wrapper.get('[data-capture-submit]').attributes('disabled')).toBeDefined();
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1);
  });

  it('adds a plain line at once, without a read, and ends on the next step: 계획에 넣기 with it picked', async () => {
    const seen = recordRequests();
    const { wrapper, router } = await mountBar();
    await enter(wrapper, '장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(reads(seen, 'tasks')).toHaveLength(0);
    expect(creates(seen, 'tasks')).toHaveLength(1);
    const [created] = taskTitled('장보기');
    expect(created).toBeDefined();

    const done = wrapper.get('[data-capture-done]');
    expect(done.text()).toContain('‘장보기’을(를) 담았어요');
    expect(done.text()).toContain('계획에 넣을까요?');
    // The line is clear for the next thing, and the ending has one filled button.
    expect(input(wrapper).element.value).toBe('');
    expect(wrapper.findAll('.btn--primary').map((button) => button.text())).toEqual(['계획에 넣기']);
    expect(wrapper.get('[data-capture-again]').text()).toBe('계속 담기');

    await wrapper.get('[data-capture-next="plan"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/plan/schedule'));
    expect(router.currentRoute.value.query).toEqual({ taskIds: created?.id });
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(false);
  });

  it('keeps what was put down across lines: the hand-off carries every new to-do', async () => {
    const { wrapper, router } = await mountBar();
    await enter(wrapper, '장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    await enter(wrapper, '빨래');
    await vi.waitFor(() => expect(wrapper.get('[data-capture-done]').text()).toContain('2개 담았어요'));
    // Enter on the empty line takes the next step.
    await wrapper.get('[data-capture-form]').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/plan/schedule'));
    const ids = String(router.currentRoute.value.query['taskIds']).split(',');
    expect(ids).toEqual([taskTitled('장보기')[0]?.id, taskTitled('빨래')[0]?.id]);
  });

  it('계속 담기 starts over without going anywhere (negative: no navigation)', async () => {
    const { wrapper, router } = await mountBar();
    await enter(wrapper, '장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-again]').exists()).toBe(true));
    await wrapper.get('[data-capture-again]').trigger('click');
    expect(wrapper.find('[data-capture-done]').exists()).toBe(false);
    expect(router.currentRoute.value.path).toBe('/planner');
    expect(document.activeElement).toBe(input(wrapper).element);
  });
});

describe('담기 줄 — a line with a day or a time is read into drafts', () => {
  it('reads to-dos with the to-do reader and adds them with one key each', async () => {
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '금요일까지 보고서 초안, 내일 장보기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(reads(seen, 'tasks')).toHaveLength(1);
    expect(reads(seen, 'commitments')).toHaveLength(0);
    expect(creates(seen, 'tasks')).toHaveLength(0);
    expect(rows(wrapper).map((row) => row.get('[data-capture-kind]').text())).toEqual(['할 일', '할 일']);
    expect(rows(wrapper).map((row) => row.get<HTMLInputElement>('.capture-row-title').element.value)).toEqual(['보고서 초안', '장보기']);
    expect(rows(wrapper)[0]?.get('[data-capture-when]').text()).toMatch(/11월 20일 \(금\).*까지/);
    expect(wrapper.get('[data-capture-status]').text()).toBe('초안 2개를 읽었어요. 엔터로 담아요.');
    expect(wrapper.get('[data-capture-submit]').text()).toBe('2개 담기');

    // Enter again adds what was read.
    await wrapper.get('[data-capture-form]').trigger('submit');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    const sent = creates(seen, 'tasks');
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((entry) => entry.key)).size).toBe(2);
    expect(taskTitled('보고서 초안')[0]?.dueAt).toBeDefined();
    expect(wrapper.get('[data-capture-done]').text()).toContain('2개 담았어요');
  });

  it('reads an appointment with the appointment reader; added, the next step is its day in the planner', async () => {
    const seen = recordRequests();
    const { wrapper, router } = await mountBar();
    await enter(wrapper, '내일 오후 3시에 치과');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(reads(seen, 'commitments')).toHaveLength(1);
    expect(reads(seen, 'tasks')).toHaveLength(0);
    const row = rows(wrapper)[0];
    expect(row?.attributes('data-capture-row')).toBe('commitment');
    expect(row?.get('[data-capture-kind]').text()).toBe('약속');
    // (The mock reader's "내일" follows the machine's own day, so only the time is pinned here.)
    expect(row?.get('[data-capture-when]').text()).toContain('오후 3:00~4:00');

    await wrapper.get('[data-capture-submit]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-next="planner"]').exists()).toBe(true));
    expect([...mockDb.commitments.values()].some((item) => item.title === '치과')).toBe(true);
    expect(creates(seen, 'tasks')).toHaveLength(0);
    // An appointment is not something to plan: no "계획에 넣을까요?" (negative).
    expect(wrapper.get('[data-capture-done]').text()).not.toContain('계획에 넣을까요');
    await wrapper.get('[data-capture-next="planner"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.query['view']).toBe('day'));
    const created = [...mockDb.commitments.values()].find((item) => item.title === '치과');
    expect(router.currentRoute.value.path).toBe('/planner');
    expect(router.currentRoute.value.query).toEqual({ view: 'day', d: localDateOf(created?.startAt ?? '', ZONE) });
  });

  it('flips a draft to the other kind before it is added: the to-do with a time becomes an appointment at that time', async () => {
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '내일 오후 3시까지 치과 가기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    const row = () => rows(wrapper)[0];
    expect(row()?.attributes('data-capture-row')).toBe('task');
    expect(row()?.get('[data-capture-flip]').text()).toBe('약속으로 바꾸기');

    await row()?.get('[data-capture-flip]').trigger('click');
    expect(row()?.attributes('data-capture-row')).toBe('commitment');
    expect(row()?.get('[data-capture-kind]').text()).toBe('약속');
    expect(row()?.get('[data-capture-when]').text()).toContain('오후 3:00~4:00');
    expect(row()?.get('[data-capture-flip]').text()).toBe('할 일로 바꾸기');
    expect(wrapper.get('[data-capture-status]').text()).toContain('약속으로 바꿨어요');

    await wrapper.get('[data-capture-submit]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(creates(seen, 'commitments')).toHaveLength(1);
    expect(creates(seen, 'tasks')).toHaveLength(0);
    const created = [...mockDb.commitments.values()].find((item) => item.title === row()?.text() || item.title.includes('치과'));
    expect(created?.timeZone).toBe(ZONE);
  });

  it('a to-do without a deadline flipped to an appointment asks when, starting from the next full hour', async () => {
    const { wrapper } = await mountBar();
    // Two things, so the line is read; neither has a day.
    await enter(wrapper, '면담, 빨래');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    const first = () => rows(wrapper)[0];
    expect(first()?.find('[data-capture-start]').exists()).toBe(false);
    await first()?.get('[data-capture-flip]').trigger('click');
    const start = first()?.get<HTMLInputElement>('[data-capture-start]');
    // 18:40 now → 19:00.
    expect(start?.element.value).toBe('2026-11-14T19:00');
    expect(first()?.get('[data-capture-when]').text()).toContain('오후 7:00~8:00');
    await start?.setValue('2026-11-16T10:00');
    expect(first()?.get('[data-capture-when]').text()).toContain('11월 16일 (월) 오전 10:00~11:00');
  });

  it('빼기 takes a draft out; a draft whose title was emptied cannot be added (negative)', async () => {
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '금요일까지 보고서 초안, 내일 장보기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    await rows(wrapper)[1]?.get('[data-capture-remove]').trigger('click');
    expect(rows(wrapper)).toHaveLength(1);
    await rows(wrapper)[0]?.get('.capture-row-title').setValue('   ');
    expect(rows(wrapper)[0]?.get('.capture-row-title').attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('[data-capture-submit]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-capture-form]').trigger('submit');
    await flushPromises();
    expect(creates(seen, 'tasks')).toHaveLength(0);
  });

  it('취소 stops the read and keeps the line; nothing is added (negative)', async () => {
    let release: () => void = () => undefined;
    server.use(
      http.post(/\/api\/v1\/tasks:parse$/, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json({ drafts: [], leftover: '' });
      }),
    );
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '내일 장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-wait]').exists()).toBe(true));
    expect(wrapper.get('[data-capture-wait]').text()).toContain('읽고 있어요');
    await wrapper.get('[data-capture-cancel]').trigger('click');
    release();
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.find('[data-capture-wait]').exists()).toBe(false));
    expect(input(wrapper).element.value).toBe('내일 장보기');
    expect(wrapper.get('[data-capture-status]').text()).toBe('읽기를 멈췄어요. 적은 글은 그대로 있어요.');
    expect(creates(seen, 'tasks')).toHaveLength(0);
    expect(wrapper.find('[data-capture-done]').exists()).toBe(false);
  });

  it('“읽지 않고 제목 그대로 담기” skips the read for a line that would be read', async () => {
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await input(wrapper).trigger('focus');
    await input(wrapper).setValue('내일 장보기');
    await wrapper.get('[data-capture-as-title]').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(reads(seen, 'tasks')).toHaveLength(0);
    expect(taskTitled('내일 장보기')).toHaveLength(1);
  });
});

describe('담기 줄 — when the AI cannot be used the line is a to-do’s title at once', () => {
  it('without consent: no read, no consent dialog, the line is added as it is and says so', async () => {
    const seen = recordRequests();
    const pinia = await signedIn(deepseek());
    // The undecided owner dismissed the dialog this session; capture must not bring it back.
    useLlmConsentStore(pinia).closed();
    const { wrapper } = await mountBar({ pinia, host: true });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await enter(wrapper, '금요일까지 보고서 초안');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(reads(seen, 'tasks')).toHaveLength(0);
    expect(reads(seen, 'commitments')).toHaveLength(0);
    expect(taskTitled('금요일까지 보고서 초안')).toHaveLength(1);
    expect(wrapper.get('[data-capture-notice]').text()).toBe('AI 없이 제목 그대로 담았어요.');
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(useLlmConsentStore(pinia).requested).toBe(false);
  });

  it('with AI turned off (직접 작성 모드): the same, and nothing is sent to be read (negative)', async () => {
    const seen = recordRequests();
    const pinia = await signedIn(deepseek({ granted: false }));
    const { wrapper } = await mountBar({ pinia });
    await enter(wrapper, '내일 오후 3시에 치과');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(seen.filter((entry) => entry.path.endsWith(':parse'))).toHaveLength(0);
    expect(taskTitled('내일 오후 3시에 치과')).toHaveLength(1);
    expect(mockDb.commitments.size).toBe([...mockDb.commitments.values()].filter((item) => item.title !== '치과').length);
  });

  it.each(['llm_unavailable', 'budget_exceeded'] as const)(
    '%s: the read fails once and the line is added as a to-do at once, with one quiet line',
    async (code) => {
    server.use(http.post(/\/api\/v1\/tasks:parse$/, () => unavailable(code)));
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '내일 장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    expect(reads(seen, 'tasks')).toHaveLength(1);
    expect(taskTitled('내일 장보기')).toHaveLength(1);
    expect(wrapper.get('[data-capture-notice]').text()).toContain('지금은 AI가 읽을 수 없어서 제목 그대로 담았어요');
    // Never an error state: the ending is still the next step.
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.get('[data-capture-next="plan"]').text()).toBe('계획에 넣기');
    },
  );

  it('a read that finds nothing offers the line as it is, and adds it only when confirmed (negative: not by itself)', async () => {
    server.use(http.post(/\/api\/v1\/tasks:parse$/, () => HttpResponse.json({ drafts: [], leftover: '' })));
    const seen = recordRequests();
    const { wrapper } = await mountBar();
    await enter(wrapper, '내일 뭔가 하기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(wrapper.get('[data-capture-notice]').text()).toBe('날짜나 시간을 읽어 내지 못했어요. 제목 그대로 담을까요?');
    expect(rows(wrapper)[0]?.get<HTMLInputElement>('.capture-row-title').element.value).toBe('내일 뭔가 하기');
    expect(creates(seen, 'tasks')).toHaveLength(0);
    await wrapper.get('[data-capture-submit]').trigger('click');
    await vi.waitFor(() => expect(taskTitled('내일 뭔가 하기')).toHaveLength(1));
  });

  it('offline: nothing is sent and the line stays (negative)', async () => {
    const seen = recordRequests();
    const { wrapper, pinia } = await mountBar();
    useOfflineStore(pinia).setOnline(false);
    await enter(wrapper, '장보기');
    expect(wrapper.get('[data-capture-offline]').text()).toContain('오프라인에서는 담을 수 없어요');
    expect(wrapper.get('[data-capture-submit]').attributes('disabled')).toBeDefined();
    expect(seen.filter((entry) => entry.method === 'POST')).toHaveLength(0);
    expect(input(wrapper).element.value).toBe('장보기');
    expect(taskTitled('장보기')).toHaveLength(0);
  });
});

describe('담기 줄 — owner isolation', () => {
  it('another user signing in clears the line, the drafts and what was added (negative: no hand-off for them)', async () => {
    const { wrapper } = await mountBar();
    await enter(wrapper, '금요일까지 보고서 초안, 내일 장보기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    await nextTick();
    expect(rows(wrapper)).toHaveLength(0);
    expect(input(wrapper).element.value).toBe('');
    expect(wrapper.find('[data-capture-done]').exists()).toBe(false);
  });

  it('a create that answers after the switch is not counted for the new user', async () => {
    let release: () => void = () => undefined;
    server.use(
      http.post(/\/api\/v1\/tasks$/, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return HttpResponse.json(
          { id: '01900000-0000-7000-8000-0000000009a1', title: '장보기', status: 'todo', projectId: 'p', version: 1 } as never,
          { status: 201 },
        );
      }),
    );
    const { wrapper } = await mountBar();
    await enter(wrapper, '장보기');
    adoptActiveOwner(OTHER_OWNER, 'bootstrap');
    release();
    await flushPromises();
    await nextTick();
    expect(wrapper.find('[data-capture-done]').exists()).toBe(false);
    expect(wrapper.find('[data-capture-next]').exists()).toBe(false);
  });
});

describe('담기 줄 — search lives in it', () => {
  it('“/” on the empty line turns it into the search; Backspace on the empty search turns it back', async () => {
    const { wrapper, pinia } = await mountBar();
    await input(wrapper).trigger('focus');
    await input(wrapper).trigger('keydown', { key: '/' });
    expect(useUiStore(pinia).captureMode).toBe('search');
    expect(wrapper.get('[data-capture]').attributes('data-capture-mode')).toBe('search');
    expect(input(wrapper).attributes('placeholder')).toBe('작업이나 화면 이름으로 찾기');
    expect(wrapper.get('[data-capture-mode-button="search"]').attributes('aria-pressed')).toBe('true');
    await input(wrapper).trigger('keydown', { key: 'Backspace' });
    expect(useUiStore(pinia).captureMode).toBe('capture');
    // In a line that has text, "/" is a character (negative).
    await input(wrapper).setValue('11');
    await input(wrapper).trigger('keydown', { key: '/' });
    expect(useUiStore(pinia).captureMode).toBe('capture');
  });

  it('finds the owner’s tasks by the words of their titles, and the places by name', async () => {
    const { wrapper, pinia, router } = await mountBar();
    useUiStore(pinia).setCaptureMode('search');
    await input(wrapper).trigger('focus');
    const seeded = [...mockDb.tasks.values()].find((task) => task.deletedAt === undefined);
    if (seeded === undefined) throw new Error('the mock has no task');
    await input(wrapper).setValue(seeded.title.slice(0, 3));
    await vi.waitFor(() => expect(wrapper.findAll('[data-capture-result="task"]').length).toBeGreaterThan(0));
    const result = wrapper.findAll('[data-capture-result="task"]').find((link) => link.text().includes(seeded.title));
    expect(result?.attributes('href')).toBe(`/tasks/${seeded.id}`);

    await input(wrapper).setValue('플래너');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-result="place"]').exists()).toBe(true));
    const place = wrapper.get('[data-capture-result="place"]');
    expect(place.attributes('href')).toBe('/planner');
    expect(place.text()).toContain('화면');
    // Opening a result puts the search away.
    await router.push('/tasks');
    await place.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/planner'));
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(false);
    expect(useUiStore(pinia).captureMode).toBe('capture');
  });

  it('nothing found leads back a stage: the words can be put down instead', async () => {
    const { wrapper, pinia } = await mountBar();
    useUiStore(pinia).setCaptureMode('search');
    await input(wrapper).trigger('focus');
    await input(wrapper).setValue('없는이름zz');
    const none = await vi.waitFor(() => wrapper.get('[data-capture-search-none]'));
    expect(none.text()).toContain('‘없는이름zz’에 맞는 것이 없어요.');
    await none.get('[data-capture-search-capture]').trigger('click');
    expect(useUiStore(pinia).captureMode).toBe('capture');
    expect(input(wrapper).element.value).toBe('없는이름zz');
  });
});

describe('담기 줄 — the panel steps away', () => {
  it('Escape closes it and keeps an unfinished line; a press elsewhere does the same', async () => {
    const { wrapper } = await mountBar();
    await input(wrapper).trigger('focus');
    await input(wrapper).setValue('금요일까지');
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(false);
    expect(input(wrapper).element.value).toBe('금요일까지');

    await input(wrapper).trigger('focus');
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await nextTick();
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(false);
  });

  it('closing after a finished round puts it away: the next opening starts clean', async () => {
    const { wrapper } = await mountBar();
    await enter(wrapper, '장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-done]').exists()).toBe(true));
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await input(wrapper).trigger('focus');
    expect(wrapper.find('[data-capture-done]').exists()).toBe(false);
    expect(wrapper.find('[data-capture-hint]').exists()).toBe(true);
  });

  it('in the sheet the panel is always there and closing is the sheet’s (emits close)', async () => {
    const pinia = createPinia();
    await useAuthStore(pinia).loadCurrent();
    const router = testRouter();
    await router.push('/planner');
    const wrapper = mount(CaptureBar, {
      props: { variant: 'sheet' },
      global: { plugins: [pinia, VueQueryPlugin, router] as never },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    expect(wrapper.find('[data-capture-panel]').exists()).toBe(true);
    expect(wrapper.get('[data-capture-panel]').classes()).not.toContain('glass'); // the sheet is the glass
    expect(wrapper.find('.capture-key').exists()).toBe(false);
    await enter(wrapper, '장보기');
    await vi.waitFor(() => expect(wrapper.find('[data-capture-next="plan"]').exists()).toBe(true));
    await wrapper.get('[data-capture-next="plan"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/plan/schedule'));
  });
});
