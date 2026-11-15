/**
 * CAL-05 "말로 적기" in the inbox: read a to-do note into task drafts, add one /
 * all, edit the title in place, change or clear the deadline, 빼기, leftover,
 * consent, failures that keep the note and the quick add, cancel, offline, the
 * quick add unchanged, `n` focus, one filled button, a11y; the guessed-AM/PM
 * switch on both draft lists (CAL-05 addendum); the inbox row's 마감 line.
 * MSW mock API (mocks/task-parse.ts, mocks/commitment-parse.ts).
 */
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { mount } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { createPinia, type Pinia } from 'pinia';
import { defineComponent, h, onUnmounted } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { CommitmentDraft, Task, TaskDraft, User } from '../src/api';
import { createPlannerClient, newActionId } from '../src/api';
import LlmConsentDialog from '../src/components/LlmConsentDialog.vue';
import TaskItem from '../src/components/TaskItem.vue';
import { switchDraftMeridiem } from '../src/domain/commitmentDraft';
import { shiftHalfDay, shiftSpanHalfDay } from '../src/domain/meridiem';
import {
  dueFromInputValue,
  dueInputValue,
  switchDueMeridiem,
  taskDraftCreateInput,
  taskDraftMeridiemGuessed,
} from '../src/domain/taskDraft';
import { addDaysToDate, localParts, todayInZone } from '../src/domain/time';
import { readTaskNote } from '../src/mocks/task-parse';
import { mockDb } from '../src/mocks/db';
import { server } from '../src/mocks/server';
import { useAuthStore } from '../src/stores/auth';
import { useLlmConsentStore } from '../src/stores/llmConsent';
import { useOfflineStore } from '../src/stores/offline';
import { useUiStore } from '../src/stores/ui';
import CommitmentAddDialog from '../src/components/planner/CommitmentAddDialog.vue';
import InboxView from '../src/views/InboxView.vue';
import { mountWithPlugins, settle } from './planning-test-utils';

const ZONE = 'Asia/Seoul';
const TWO = '내일까지 교수님께 메일, 장보기';

function router() {
  const Stub = defineComponent({ render: () => h('div') });
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/commitments', component: Stub },
      { path: '/tasks/:id', component: Stub },
      { path: '/settings/ai', component: Stub },
    ],
  });
}

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
  readonly key: string;
  readonly body: string;
}

function recordRequests(): Recorded[] {
  const seen: Recorded[] = [];
  server.events.on('request:start', ({ request }) => {
    const clone = request.clone();
    const entry = {
      method: request.method,
      path: new URL(request.url).pathname,
      key: request.headers.get('Idempotency-Key') ?? '',
      body: '',
    };
    seen.push(entry);
    void clone.text().then((text) => {
      entry.body = text;
    });
  });
  return seen;
}

function parseRequests(seen: readonly Recorded[]): Recorded[] {
  return seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/tasks:parse'));
}

function createRequests(seen: readonly Recorded[]): Recorded[] {
  return seen.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/api/v1/tasks'));
}

async function mountInbox(pinia: Pinia = createPinia()): Promise<VueWrapper> {
  const wrapper = mountWithPlugins(InboxView, { pinia, router: router() });
  await settle();
  await vi.waitFor(() => expect(wrapper.find('#task-note').exists()).toBe(true));
  return wrapper;
}

async function read(wrapper: VueWrapper, text: string): Promise<void> {
  await wrapper.get('#task-note').setValue(text);
  await wrapper.get('form.task-parse-form').trigger('submit');
  await settle();
}

function rows(wrapper: VueWrapper) {
  return wrapper.findAll('[data-testid="task-draft"]');
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

function filledButtons(wrapper: VueWrapper): string[] {
  return wrapper.findAll('button.btn--primary').map((item) => item.text());
}

function readButton(wrapper: VueWrapper) {
  return wrapper.get('form.task-parse-form button[type="submit"]');
}

function quickAddButton(wrapper: VueWrapper) {
  return wrapper.get('form.quick-add button[type="submit"]');
}

function problem(status: number, code: string): Response {
  return HttpResponse.json(
    { type: 'about:blank', title: 'x', status, code, detail: 'synthetic' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function tasksTitled(title: string): Task[] {
  return [...mockDb.tasks.values()].filter((task) => task.title === title && task.deletedAt === undefined);
}

function status(wrapper: VueWrapper): string {
  return wrapper.get('[data-testid="task-parse"] [role="status"]').text();
}

afterEach(() => {
  document.body.innerHTML = '';
});

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('taskDraft helpers', () => {
  it('a row is added with its trimmed title and its deadline, or not at all while the title is blank (negative)', () => {
    expect(taskDraftCreateInput('  보고서 초안 ', '2026-11-13T14:59:00.000Z')).toEqual({
      title: '보고서 초안',
      dueAt: '2026-11-13T14:59:00.000Z',
    });
    expect(taskDraftCreateInput('장보기', null)).toEqual({ title: '장보기' });
    expect(taskDraftCreateInput('   ', null)).toBeNull();
    expect(taskDraftCreateInput('가'.repeat(201), null)).toBeNull();
  });

  it('the deadline input reads and writes local date-times in the zone; empty is no deadline, junk is ignored', () => {
    expect(dueInputValue('2026-11-13T14:59:00.000Z', ZONE)).toBe('2026-11-13T23:59');
    expect(dueInputValue(null, ZONE)).toBe('');
    expect(dueFromInputValue('2026-11-20T18:00', ZONE)).toBe('2026-11-20T09:00:00.000Z');
    expect(dueFromInputValue('', ZONE)).toBeNull();
    expect(dueFromInputValue('next friday', ZONE)).toBeUndefined();
  });

  it('half a day on the wall clock: AM <-> PM, over midnight, and across a DST change', () => {
    // 09:00 KST -> 21:00 KST and back.
    expect(shiftHalfDay('2026-11-14T00:00:00.000Z', ZONE, 1)).toBe('2026-11-14T12:00:00.000Z');
    expect(shiftHalfDay('2026-11-14T12:00:00.000Z', ZONE, -1)).toBe('2026-11-14T00:00:00.000Z');
    // 13:00 KST + 12 h = 01:00 the next day.
    expect(localParts(shiftHalfDay('2026-11-14T04:00:00.000Z', ZONE, 1), ZONE)).toMatchObject({ date: '2026-11-15', hour: 1 });
    // New York, the fall-back day: 01:00 EDT -> 13:00 EST is 13 real hours, the wall clock says 1 PM.
    const afternoon = shiftHalfDay('2026-11-01T05:00:00.000Z', 'America/New_York', 1);
    expect(afternoon).toBe('2026-11-01T18:00:00.000Z');
    expect(localParts(afternoon, 'America/New_York')).toMatchObject({ date: '2026-11-01', hour: 13 });
  });

  it('a span keeps its length and its end stays after its start when it crosses midnight', () => {
    // 11:00-13:00 KST -> 23:00-01:00 (+1 day).
    const span = shiftSpanHalfDay('2026-11-14T02:00:00.000Z', '2026-11-14T04:00:00.000Z', ZONE, 1);
    expect(span).toEqual({ startAt: '2026-11-14T14:00:00.000Z', endAt: '2026-11-14T16:00:00.000Z' });
    expect(Date.parse(span.endAt)).toBeGreaterThan(Date.parse(span.startAt));
    expect(localParts(span.endAt, ZONE)).toMatchObject({ date: '2026-11-15', hour: 1 });
  });

  it('switching a commitment draft moves both ends and keeps its date and repeat; an untimed draft is unchanged', () => {
    const study: CommitmentDraft = {
      title: '스터디',
      timeZone: ZONE,
      date: '2026-11-19',
      startAt: '2026-11-18T22:00:00.000Z',
      endAt: '2026-11-18T23:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      notes: ['duration_defaulted', 'repeats_weekly', 'meridiem_assumed'],
    };
    expect(switchDraftMeridiem(study, 1)).toEqual({
      ...study,
      startAt: '2026-11-19T10:00:00.000Z',
      endAt: '2026-11-19T11:00:00.000Z',
    });
    const untimed: CommitmentDraft = { title: '영화', timeZone: ZONE, date: '2026-11-21', notes: [] };
    expect(switchDraftMeridiem(untimed, 1)).toBe(untimed);
  });

  it('only a timed task draft marked meridiem_assumed offers the switch (negative)', () => {
    const guessed: TaskDraft = { title: '회의록 정리', dueAt: '2026-11-14T00:00:00.000Z', notes: ['meridiem_assumed'] };
    expect(taskDraftMeridiemGuessed(guessed)).toBe(true);
    expect(taskDraftMeridiemGuessed({ title: '장보기', notes: [] })).toBe(false);
    expect(taskDraftMeridiemGuessed({ title: '보고서', dueAt: '2026-11-14T14:59:00.000Z', notes: ['due_time_defaulted'] })).toBe(false);
    expect(switchDueMeridiem('2026-11-14T00:00:00.000Z', ZONE, 1)).toBe('2026-11-14T12:00:00.000Z');
  });
});

describe('mock reader (VITE_MOCK and tests)', () => {
  it('reads every part as a task, a named day or time as its deadline, and leaves remarks', () => {
    const now = Date.now();
    const today = todayInZone(ZONE, now);
    const tomorrow = addDaysToDate(today, 1);
    const result = readTaskNote('내일까지 교수님께 메일, 장보기, 요즘 너무 피곤하다', ZONE, now);
    expect(result.drafts).toEqual([
      { title: '교수님께 메일', dueAt: expect.any(String), notes: ['due_time_defaulted'] },
      { title: '장보기', notes: [] },
    ]);
    expect(localParts(result.drafts[0]?.dueAt as string, ZONE)).toMatchObject({ date: tomorrow, hour: 23, minute: 59 });
    expect(result.leftover).toBe('요즘 너무 피곤하다');
    const guessed = readTaskNote('내일 9시까지 회의록 정리', ZONE, now).drafts[0];
    expect(guessed).toMatchObject({ title: '회의록 정리', notes: ['meridiem_assumed'] });
    expect(localParts(guessed?.dueAt as string, ZONE)).toMatchObject({ date: tomorrow, hour: 9 });
    expect(readTaskNote('내일 오후 3시까지 서류', ZONE, now).drafts[0]?.notes).toEqual([]);
  });

  it('the mock route answers like the API, replays a key, writes nothing and rejects a blank note (negative)', async () => {
    const client = createPlannerClient();
    const before = mockDb.tasks.size;
    const key = newActionId('task-parse');
    const first = await client.parseTasks(TWO, key, { timeZone: ZONE });
    expect(first.drafts.map((draft) => draft.title)).toEqual(['교수님께 메일', '장보기']);
    expect(await client.parseTasks(TWO, key, { timeZone: ZONE })).toEqual(first);
    expect(mockDb.tasks.size).toBe(before);
    await expect(client.parseTasks('   ', newActionId('task-parse'))).rejects.toMatchObject({ status: 400 });
  });
});

// ── The inbox ───────────────────────────────────────────────────────────────

describe('/inbox 말로 적기', () => {
  it('the quick add is unchanged: type a title, Enter, it is added at once, no read', async () => {
    const seen = recordRequests();
    const wrapper = await mountInbox();
    await wrapper.get('#quick-add-title').setValue('빠른 할 일');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(tasksTitled('빠른 할 일')).toHaveLength(1));
    expect((wrapper.get('#quick-add-title').element as HTMLInputElement).value).toBe('');
    expect(parseRequests(seen)).toHaveLength(0);
    expect(createRequests(seen)).toHaveLength(1);
    wrapper.unmount();
  });

  it('reads a note into ruled rows with 마감 or 마감 없음, announces the count and moves focus to the result', async () => {
    const seen = recordRequests();
    const wrapper = await mountInbox();
    const before = mockDb.tasks.size;
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect((row(wrapper, 0).get('input.task-draft-title').element as HTMLInputElement).value).toBe('교수님께 메일');
    expect(row(wrapper, 0).get('[data-testid="task-draft-due"]').text()).toMatch(/^마감 \d+월 \d+일 \(.\) 오후 11:59$/);
    expect(row(wrapper, 0).text()).toContain('시간이 없어 그날 밤 11시 59분까지로 잡았어요.');
    expect(row(wrapper, 1).get('[data-testid="task-draft-due"]').text()).toBe('마감 없음');
    expect(status(wrapper)).toBe('할 일 2개를 읽었어요.');
    expect(document.activeElement?.id).toBe('task-parse-result-heading');
    // The read sends the zone the inbox shows deadlines in, and saves nothing.
    await vi.waitFor(() => expect(JSON.parse(parseRequests(seen)[0]?.body ?? '{}')).toMatchObject({ timeZone: ZONE }));
    expect(mockDb.tasks.size).toBe(before);
    wrapper.unmount();
  });

  it('adds one draft with the quick add create call: the row turns done and the inbox list shows it with its 마감', async () => {
    const seen = recordRequests();
    const wrapper = await mountInbox();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect(row(wrapper, 0).text()).toContain('추가했어요'));
    const [created] = tasksTitled('교수님께 메일');
    expect(created?.projectId).toBe(mockDb.inboxProjectId);
    expect(localParts(created?.dueAt as string, ZONE)).toMatchObject({ hour: 23, minute: 59 });
    const body = JSON.parse(createRequests(seen)[0]?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['dueAt', 'title']); // no project: the inbox, like the quick add
    expect(status(wrapper)).toBe('‘교수님께 메일’ 할 일을 인박스에 추가했어요.');
    await vi.waitFor(() => {
      const listed = wrapper.findAll('li.task-item').find((item) => item.text().includes('교수님께 메일'));
      expect(listed?.get('[data-testid="task-due"]').text()).toMatch(/^마감 \d+월 \d+일 \(.\) 오후 11:59$/);
    });
    expect(row(wrapper, 1).text()).not.toContain('추가했어요');
    wrapper.unmount();
  });

  it('adds every ready draft with one action, one idempotency key each; the note clears when all are in', async () => {
    const seen = recordRequests();
    const wrapper = await mountInbox();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    const addAll = wrapper.get('[data-testid="task-parse-add-all"]');
    expect(addAll.text()).toBe('2개 모두 추가');
    await addAll.trigger('click');
    await settle();
    await vi.waitFor(() => expect(rows(wrapper).every((item) => item.text().includes('추가했어요'))).toBe(true));
    const keys = createRequests(seen).map((entry) => entry.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(tasksTitled('장보기')).toHaveLength(1);
    expect(tasksTitled('장보기')[0]?.dueAt).toBeUndefined();
    expect(status(wrapper)).toBe('할 일 2개를 인박스에 추가했어요.');
    expect((wrapper.get('#task-note').element as HTMLTextAreaElement).value).toBe('');
    wrapper.unmount();
  });

  it('the title is edited in place; a blank title cannot be added (negative)', async () => {
    const wrapper = await mountInbox();
    await read(wrapper, '장보기');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    const title = row(wrapper, 0).get('input.task-draft-title');
    expect(row(wrapper, 0).get(`label[for="${title.attributes('id')}"]`).text()).toBe('할 일 제목');
    await title.setValue('   ');
    await settle();
    expect(buttonIn(row(wrapper, 0), '추가').attributes('disabled')).toBeDefined();
    expect(row(wrapper, 0).text()).toContain('제목을 적어야 추가할 수 있어요.');
    expect(title.attributes('aria-invalid')).toBe('true');
    await title.setValue('마트에서 장보기');
    await settle();
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect(tasksTitled('마트에서 장보기')).toHaveLength(1));
    expect(tasksTitled('장보기')).toHaveLength(0);
    wrapper.unmount();
  });

  it('the deadline changes with the date-time input and can be cleared', async () => {
    const wrapper = await mountInbox();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    // Give 장보기 a deadline.
    const change = buttonIn(row(wrapper, 1), '마감 바꾸기');
    expect(change.attributes('aria-expanded')).toBe('false');
    await change.trigger('click');
    await settle();
    const due = row(wrapper, 1).get('input[type="datetime-local"]');
    expect(row(wrapper, 1).get(`label[for="${due.attributes('id')}"]`).text()).toBe('마감');
    expect(document.activeElement?.id).toBe(due.attributes('id'));
    await due.setValue('2030-01-05T18:30');
    await settle();
    expect(row(wrapper, 1).get('[data-testid="task-draft-due"]').text()).toBe('마감 1월 5일 (토) 오후 6:30');
    // Clear 교수님께 메일's deadline: its AI notes no longer apply.
    await buttonIn(row(wrapper, 0), '마감 바꾸기').trigger('click');
    await settle();
    await buttonIn(row(wrapper, 0), '마감 없애기').trigger('click');
    await settle();
    expect(row(wrapper, 0).get('[data-testid="task-draft-due"]').text()).toBe('마감 없음');
    expect(row(wrapper, 0).text()).not.toContain('11시 59분');
    await wrapper.get('[data-testid="task-parse-add-all"]').trigger('click');
    await settle();
    await vi.waitFor(() => expect(tasksTitled('장보기')).toHaveLength(1));
    expect(localParts(tasksTitled('장보기')[0]?.dueAt as string, ZONE)).toMatchObject({ date: '2030-01-05', hour: 18, minute: 30 });
    await vi.waitFor(() => expect(tasksTitled('교수님께 메일')).toHaveLength(1));
    expect(tasksTitled('교수님께 메일')[0]?.dueAt).toBeUndefined();
    wrapper.unmount();
  });

  it('빼기 removes a draft without saving anything', async () => {
    const wrapper = await mountInbox();
    const before = mockDb.tasks.size;
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    await buttonIn(row(wrapper, 0), '빼기').trigger('click');
    await settle();
    expect(rows(wrapper)).toHaveLength(1);
    expect(status(wrapper)).toBe('‘교수님께 메일’ 초안을 뺐어요.');
    expect(mockDb.tasks.size).toBe(before);
    wrapper.unmount();
  });

  it('shows what it could not read as 읽지 못한 부분, and says when nothing was a to-do', async () => {
    const wrapper = await mountInbox();
    await read(wrapper, '장보기, 요즘 너무 피곤하다');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(wrapper.get('[data-testid="task-parse"] .nl-leftover').text()).toBe('읽지 못한 부분: 요즘 너무 피곤하다');
    await read(wrapper, '요즘 너무 피곤하다');
    await vi.waitFor(() => expect(wrapper.text()).toContain('할 일로 읽을 부분을 찾지 못했어요.'));
    expect(rows(wrapper)).toHaveLength(0);
    wrapper.unmount();
  });

  it('a guessed AM says so and switches to PM and back; the switched time is what gets added', async () => {
    const wrapper = await mountInbox();
    await read(wrapper, '내일 9시까지 회의록 정리');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    const meridiem = row(wrapper, 0).get('[data-testid="nl-meridiem"]');
    expect(meridiem.text()).toContain('오전인지 오후인지 적혀 있지 않아 오전으로 잡았어요.');
    expect(row(wrapper, 0).get('[data-testid="task-draft-due"]').text()).toContain('오전 9:00');
    await buttonIn(meridiem, '오후로 바꾸기').trigger('click');
    await settle();
    expect(row(wrapper, 0).get('[data-testid="task-draft-due"]').text()).toContain('오후 9:00');
    expect(row(wrapper, 0).text()).toContain('오후로 바꿨어요.');
    expect(status(wrapper)).toMatch(/^‘회의록 정리’ 시간을 오후로 바꿨어요: .*오후 9:00$/);
    // Back and forth is exact.
    await buttonIn(row(wrapper, 0), '오전으로 바꾸기').trigger('click');
    await settle();
    expect(row(wrapper, 0).get('[data-testid="task-draft-due"]').text()).toContain('오전 9:00');
    await buttonIn(row(wrapper, 0), '오후로 바꾸기').trigger('click');
    await settle();
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect(tasksTitled('회의록 정리')).toHaveLength(1));
    expect(localParts(tasksTitled('회의록 정리')[0]?.dueAt as string, ZONE)).toMatchObject({ hour: 21, minute: 0 });
    wrapper.unmount();
  });

  it('an explicit 오후 or 저녁 offers no switch (negative)', async () => {
    const wrapper = await mountInbox();
    await read(wrapper, '내일 오후 3시까지 서류 제출, 내일 저녁 7시 전에 운동');
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(wrapper.find('[data-testid="nl-meridiem"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('Enter reads; Shift+Enter and an IME composition do not (negative)', async () => {
    const seen = recordRequests();
    const wrapper = await mountInbox();
    const note = wrapper.get('#task-note');
    await note.setValue('장보기');
    await note.trigger('keydown', { key: 'Enter', shiftKey: true });
    await note.trigger('keydown', { key: 'Enter', isComposing: true });
    await settle();
    expect(parseRequests(seen)).toHaveLength(0);
    await note.trigger('keydown', { key: 'Enter' });
    await settle();
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(1));
    expect(parseRequests(seen)).toHaveLength(1);
    wrapper.unmount();
  });

  it('one filled button: the quick add, 읽기 once the note has text, then the add action; typing a title takes it back', async () => {
    const wrapper = await mountInbox();
    expect(quickAddButton(wrapper).classes()).toContain('btn--primary');
    expect(readButton(wrapper).classes()).not.toContain('btn--primary');
    await wrapper.get('#task-note').setValue(TWO);
    await settle();
    expect(filledButtons(wrapper)).toEqual(['읽기']);
    await wrapper.get('form.task-parse-form').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(filledButtons(wrapper)).toEqual(['2개 모두 추가']);
    await wrapper.get('#quick-add-title').setValue('직접 적는 할 일');
    await settle();
    expect(filledButtons(wrapper)).toEqual(['작업 추가']);
    await wrapper.get('#quick-add-title').setValue('');
    await buttonIn(row(wrapper, 1), '빼기').trigger('click');
    await settle();
    expect(filledButtons(wrapper)).toEqual(['교수님께 메일 추가']);
    wrapper.unmount();
  });

  it('`n` / 새 작업 still focuses the quick add, also with drafts on screen', async () => {
    const pinia = createPinia();
    const wrapper = await mountInbox(pinia);
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('task-parse-result-heading'));
    useUiStore(pinia).requestNewTask();
    await settle();
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('quick-add-title'));
    wrapper.unmount();
  });

  it('cancel stops the read, keeps the note and leaves no failure line', async () => {
    let release: () => void = () => undefined;
    server.use(
      http.post(/\/api\/v1\/tasks:parse$/, async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return problem(503, 'llm_unavailable');
      }),
    );
    const wrapper = await mountInbox();
    await wrapper.get('#task-note').setValue(TWO);
    await wrapper.get('form.task-parse-form').trigger('submit');
    await settle();
    const wait = wrapper.get('[data-testid="task-parse-wait"]');
    expect(wait.text()).toContain('AI가 메모를 읽고 있어요');
    await buttonIn(wait, '취소').trigger('click');
    await settle();
    release();
    await vi.waitFor(() => expect(wrapper.find('[data-testid="task-parse-wait"]').exists()).toBe(false));
    expect(status(wrapper)).toBe('읽기를 멈췄어요. 메모는 그대로 있어요.');
    expect((wrapper.get('#task-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(wrapper.find('[data-testid="task-parse"] [role="alert"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it.each([
    ['llm_unavailable', '지금은 AI로 읽을 수 없어요.'],
    ['budget_exceeded', 'AI 사용 한도에 닿아 지금은 읽을 수 없어요.'],
  ])('%s: one line, the note stays and the quick add still works (negative)', async (code, line) => {
    server.use(http.post(/\/api\/v1\/tasks:parse$/, () => problem(503, code)));
    const wrapper = await mountInbox();
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(wrapper.get('[data-testid="task-parse"] .nl-failure').text()).toContain(line));
    expect(wrapper.get('[data-testid="task-parse"] .nl-failure').attributes('role')).toBe('alert');
    expect((wrapper.get('#task-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(rows(wrapper)).toHaveLength(0);
    await wrapper.get('#quick-add-title').setValue('직접 적은 메일');
    await wrapper.get('form.quick-add').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(tasksTitled('직접 적은 메일')).toHaveLength(1));
    wrapper.unmount();
  });

  it('offline: reading and adding are disabled; nothing is sent (negative)', async () => {
    const pinia = createPinia();
    const wrapper = await mountInbox(pinia);
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    const seen = recordRequests();
    useOfflineStore(pinia).setOnline(false);
    await settle();
    expect(readButton(wrapper).attributes('disabled')).toBeDefined();
    expect(wrapper.get('#task-note').attributes('disabled')).toBeDefined();
    expect(buttonIn(row(wrapper, 0), '추가').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="task-parse-add-all"]').attributes('disabled')).toBeDefined();
    await buttonIn(row(wrapper, 0), '추가').trigger('click');
    await wrapper.get('[data-testid="task-parse-add-all"]').trigger('click');
    await settle();
    expect(createRequests(seen)).toHaveLength(0);
    wrapper.unmount();
  });

  it('a11y: labelled note with help, labelled regions, and every row action names its draft', async () => {
    const wrapper = await mountInbox();
    const note = wrapper.get('#task-note');
    expect(wrapper.get('label[for="task-note"]').text()).toBe('할 일 메모');
    const describedby = note.attributes('aria-describedby') ?? '';
    expect(document.getElementById(describedby)?.textContent).toContain('금요일까지 보고서 초안, 내일 교수님께 메일');
    expect(wrapper.get('[data-testid="task-parse"]').attributes('aria-labelledby')).toBe('task-parse-heading');
    expect(wrapper.get('#task-parse-heading').text()).toBe('말로 적기');
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    expect(wrapper.get('[data-testid="task-parse-result"]').attributes('aria-labelledby')).toBe('task-parse-result-heading');
    expect(wrapper.get('#task-parse-result-heading').attributes('tabindex')).toBe('-1');
    expect(row(wrapper, 0).get('[role="group"]').attributes('aria-label')).toBe('교수님께 메일 초안');
    expect(buttonIn(row(wrapper, 0), '추가').text()).toBe('교수님께 메일 추가');
    expect(buttonIn(row(wrapper, 0), '빼기').text()).toBe('교수님께 메일 빼기');
    expect(buttonIn(row(wrapper, 0), '마감 바꾸기').text()).toBe('교수님께 메일 마감 바꾸기');
    wrapper.unmount();
  });
});

describe('/inbox 말로 적기: AI consent (FU-91 rules)', () => {
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

  it('undecided: 읽기 opens the consent dialog first and reads once AI is allowed', async () => {
    server.use(
      http.patch('*/api/v1/me/settings', async ({ request }) => {
        const body = (await request.json()) as { llm?: { consent?: { granted?: boolean } } };
        mockDb.user = {
          ...mockDb.user,
          version: mockDb.user.version + 1,
          llm: { consent: { granted: body.llm?.consent?.granted === true, at: '2026-11-12T09:30:00.000Z', provider: 'deepseek' } },
        };
        return HttpResponse.json(mockDb.user as unknown as Record<string, unknown>, {
          headers: { ETag: `W/"${mockDb.user.version}"` },
        });
      }),
    );
    const seen = recordRequests();
    const pinia = await signedIn(deepseek());
    useLlmConsentStore(pinia).closed();
    const host = mountWithPlugins(ConsentHost, { pinia });
    const wrapper = await mountInbox(pinia);
    await wrapper.get('#task-note').setValue(TWO);
    await wrapper.get('form.task-parse-form').trigger('submit');
    await vi.waitFor(() => expect(document.body.textContent).toContain('AI 계획 도움을 쓸까요?'));
    expect(parseRequests(seen)).toHaveLength(0);
    const allow = [...document.body.querySelectorAll('button')].find((item) => item.textContent?.includes('AI 계획 도움 허용'));
    allow?.click();
    await vi.waitFor(() => expect(parseRequests(seen)).toHaveLength(1));
    await vi.waitFor(() => expect(rows(wrapper)).toHaveLength(2));
    wrapper.unmount();
    host.unmount();
  });

  it('AI turned off: no request, one line with the way to AI 설정, the quick add right there (negative)', async () => {
    const seen = recordRequests();
    const pinia = await signedIn(deepseek({ granted: false }));
    const wrapper = await mountInbox(pinia);
    await read(wrapper, TWO);
    await vi.waitFor(() => expect(wrapper.find('[data-testid="task-parse"] .nl-failure').exists()).toBe(true));
    expect(wrapper.get('[data-testid="task-parse"] .nl-failure').text()).toContain('AI를 쓰지 않도록 설정되어 있어요.');
    expect(wrapper.get('[data-testid="task-parse"] .nl-failure a').attributes('href')).toBe('/settings/ai');
    expect(parseRequests(seen)).toHaveLength(0);
    expect((wrapper.get('#task-note').element as HTMLTextAreaElement).value).toBe(TWO);
    expect(wrapper.get('#quick-add-title').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="task-parse"] .nl-entry-disclosure').text()).toContain('인박스');
    wrapper.unmount();
  });
});

// ── 약속 추가's draft rows (the planner's dialog): the same switch (CAL-05 addendum) ──────────

describe('약속 추가 말로 적기: guessed AM/PM (CAL-05 addendum)', () => {
  async function mountCommitments(): Promise<VueWrapper> {
    const wrapper = mountWithPlugins(CommitmentAddDialog, {
      pinia: createPinia(),
      router: router(),
      props: { timeZone: 'Asia/Seoul', date: '2026-11-14' },
    });
    await settle();
    await vi.waitFor(() => expect(wrapper.find('#commitment-note').exists()).toBe(true));
    return wrapper;
  }

  function commitmentRows(wrapper: VueWrapper) {
    return wrapper.findAll('[data-testid="nl-draft"]');
  }

  it('a bare 7시 says AM was a guess; 오후로 바꾸기 moves start and end, and the switched time is what gets added', async () => {
    const wrapper = await mountCommitments();
    await wrapper.get('#commitment-note').setValue('내일 7시 스터디');
    await wrapper.get('form.nl-entry-form').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(commitmentRows(wrapper)).toHaveLength(1));
    const draft = commitmentRows(wrapper)[0] as DOMWrapper<Element>;
    expect(draft.get('[data-testid="nl-meridiem"]').text()).toContain('오전으로 잡았어요.');
    expect(draft.get('.nl-draft-when').text()).toContain('오전 7:00~8:00');
    await buttonIn(draft.get('[data-testid="nl-meridiem"]'), '오후로 바꾸기').trigger('click');
    await settle();
    expect(commitmentRows(wrapper)[0]?.get('.nl-draft-when').text()).toContain('오후 7:00~8:00');
    // The 약속 screen's one filled button is still its own add.
    expect(filledButtons(wrapper)).toEqual(['스터디 추가']);
    await buttonIn(commitmentRows(wrapper)[0] as DOMWrapper<Element>, '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect([...mockDb.commitments.values()].some((item) => item.title === '스터디')).toBe(true));
    const created = [...mockDb.commitments.values()].find((item) => item.title === '스터디');
    expect(localParts(created?.startAt as string, ZONE)).toMatchObject({ hour: 19, minute: 0 });
    expect(localParts(created?.endAt as string, ZONE)).toMatchObject({ hour: 20, minute: 0 });
    wrapper.unmount();
  });

  it('a draft that crosses midnight after the switch keeps its end after its start', async () => {
    const wrapper = await mountCommitments();
    await wrapper.get('#commitment-note').setValue('내일 11시부터 1시까지 회의');
    await wrapper.get('form.nl-entry-form').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(commitmentRows(wrapper)).toHaveLength(1));
    await buttonIn(commitmentRows(wrapper)[0] as DOMWrapper<Element>, '오후로 바꾸기').trigger('click');
    await settle();
    const when = commitmentRows(wrapper)[0]?.get('.nl-draft-when').text() ?? '';
    expect(when).toMatch(/오후 11:00~.*오전 1:00$/);
    await buttonIn(commitmentRows(wrapper)[0] as DOMWrapper<Element>, '추가').trigger('click');
    await settle();
    await vi.waitFor(() => expect([...mockDb.commitments.values()].some((item) => item.title === '회의')).toBe(true));
    const created = [...mockDb.commitments.values()].find((item) => item.title === '회의');
    expect(Date.parse(created?.endAt as string) - Date.parse(created?.startAt as string)).toBe(2 * 60 * 60 * 1000);
    expect(localParts(created?.startAt as string, ZONE).hour).toBe(23);
    wrapper.unmount();
  });

  it('an explicit 오후 3시 or 저녁 7시 offers no switch (negative)', async () => {
    const wrapper = await mountCommitments();
    await wrapper.get('#commitment-note').setValue('내일 오후 3시에 치과, 모레 저녁 7시 동창 모임');
    await wrapper.get('form.nl-entry-form').trigger('submit');
    await settle();
    await vi.waitFor(() => expect(commitmentRows(wrapper)).toHaveLength(2));
    expect(wrapper.find('[data-testid="nl-meridiem"]').exists()).toBe(false);
    wrapper.unmount();
  });
});

// ── The inbox row's 마감 line ───────────────────────────────────────────────

describe('TaskItem 마감 line', () => {
  const base: Task = {
    id: '01900000-0000-7000-8000-00000000c501',
    ownerId: '01900000-0000-7000-8000-0000000000a0',
    projectId: '01900000-0000-7000-8000-000000000001',
    title: '보고서 초안',
    status: 'todo',
    splittable: true,
    priority: 2,
    dependsOn: [],
    version: 1,
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    external: [],
  };

  it('shows the deadline in the date-time format when the task has one', () => {
    const wrapper = mount(TaskItem, { props: { task: { ...base, dueAt: '2099-11-13T14:59:00.000Z' } } });
    expect(wrapper.get('[data-testid="task-due"]').text()).toMatch(/^마감 11월 13일 \(.\) 오후 11:59$/);
    expect(wrapper.find('.task-due-overdue').exists()).toBe(false);
  });

  it('has no line without a deadline, and says 지났어요 only for an open task past it (negative)', () => {
    expect(mount(TaskItem, { props: { task: base } }).find('[data-testid="task-due"]').exists()).toBe(false);
    const past = { ...base, dueAt: '2020-01-01T00:00:00.000Z' };
    expect(mount(TaskItem, { props: { task: past } }).get('.task-due-overdue').text()).toBe('지났어요');
    expect(mount(TaskItem, { props: { task: { ...past, status: 'done' } } }).find('.task-due-overdue').exists()).toBe(false);
  });
});
