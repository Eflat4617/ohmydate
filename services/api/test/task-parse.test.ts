/**
 * CAL-05 — POST /tasks:parse, the use-case without HTTP or a database: model
 * output -> task drafts (deadline instants in the zone, the date-only default,
 * notes, a deadline that fails validation dropped while the task stays), the
 * shared agent_run lifecycle and failure mapping, and the fake-provider
 * reader. FakeLlm and in-memory ports only; HTTP/DB is task-parse-api.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Id } from '@ohmydate/domain';
import { ValidationFailedError } from '@ohmydate/domain';
import {
  BudgetExceeded,
  BudgetGuard,
  FakeLlm,
  LlmUnavailable,
  buildTaskParseInput,
  commitmentCalendar,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
  type TaskParseItem,
  type TaskParseOutput,
} from '@ohmydate/llm';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import { DailyProblemError } from '../src/application/daily-errors.js';
import {
  TASK_DUE_DEFAULT_TIME,
  TaskParseService,
  taskDraftsFromOutput,
} from '../src/application/task-parse/task-parse-service.js';
import type { AgentRunCompletion, AgentRunInput } from '../src/application/intake/ports.js';
import { fakeTaskParseOutput } from '../src/adapters/fake-task-parse.js';
import { scriptedFakeOutput } from '../src/adapters/scripted-fake-llm.js';
import { E2eGroundedFakeLlm } from '../src/adapters/fake-llm-scenarios.js';

interface RecordedCase {
  readonly id: string;
  readonly text: string;
  readonly output: TaskParseOutput;
}

const recorded = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'llm', 'test', 'fixtures', 'task-parse', 'cases.json'),
    'utf8',
  ),
) as { readonly cases: readonly RecordedCase[] };

const OWNER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0a01' as Id;
/** Friday 2026-11-13 14:05 in Seoul (the recorded fixtures' "now"). */
const SEOUL_NOW = '2026-11-13T05:05:00.000Z';
const SEOUL = { timeZone: 'Asia/Seoul', nowMs: Date.parse(SEOUL_NOW) };

function item(overrides: Partial<TaskParseItem> = {}): TaskParseItem {
  return {
    title: '보고서 초안',
    dueDate: '2026-11-20',
    dueTime: null,
    dateWasGuessed: false,
    meridiemWasGuessed: false,
    ...overrides,
  };
}

function convert(items: readonly TaskParseItem[], leftover = '', context = SEOUL) {
  return taskDraftsFromOutput({ items, leftover }, context);
}

function recordedOutput(id: string): TaskParseOutput {
  const entry = recorded.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no recorded case ${id}`);
  return entry.output;
}

describe('taskDraftsFromOutput: recorded phrase classes in Asia/Seoul', () => {
  test('a date without a time is due at 23:59 local that day (due_time_defaulted)', () => {
    expect(TASK_DUE_DEFAULT_TIME).toBe('23:59');
    expect(taskDraftsFromOutput(recordedOutput('until-weekday'), SEOUL)).toEqual({
      drafts: [{ title: '보고서 초안', dueAt: '2026-11-13T14:59:00.000Z', notes: ['due_time_defaulted'] }],
      leftover: '',
    });
  });

  test('several to-dos keep their order and their own deadlines', () => {
    expect(taskDraftsFromOutput(recordedOutput('several'), SEOUL).drafts).toEqual([
      { title: '발표 자료 만들기', dueAt: '2026-11-18T14:59:00.000Z', notes: ['due_time_defaulted'] },
      { title: '교수님께 메일', dueAt: '2026-11-14T14:59:00.000Z', notes: ['due_time_defaulted'] },
    ]);
  });

  test('a to-do with no date is a draft without a deadline, never leftover', () => {
    expect(taskDraftsFromOutput(recordedOutput('no-deadline'), SEOUL)).toEqual({
      drafts: [{ title: '장보기', notes: [] }],
      leftover: '',
    });
  });

  test('a time becomes the deadline instant; a guessed day and a guessed half-day say so', () => {
    expect(taskDraftsFromOutput(recordedOutput('appointment-like'), SEOUL).drafts).toEqual([
      { title: '치과', dueAt: '2026-11-13T06:00:00.000Z', notes: ['date_assumed'] },
    ]);
    expect(taskDraftsFromOutput(recordedOutput('bare-nine'), SEOUL).drafts).toEqual([
      { title: '회의록 정리', dueAt: '2026-11-14T00:00:00.000Z', notes: ['meridiem_assumed'] },
    ]);
    expect(taskDraftsFromOutput(recordedOutput('this-week-vague'), SEOUL).drafts).toEqual([
      { title: '책 반납', dueAt: '2026-11-15T14:59:00.000Z', notes: ['due_time_defaulted', 'date_assumed'] },
    ]);
  });

  test('AM/PM addendum: 저녁 7시, 오후 3시 and 15시 carry no meridiem note (negative)', () => {
    for (const id of ['evening', 'pm-word', 'twenty-four-hour', 'appointment-like']) {
      const notes = taskDraftsFromOutput(recordedOutput(id), SEOUL).drafts[0]?.notes ?? [];
      expect({ id, guessed: notes.includes('meridiem_assumed') }).toEqual({ id, guessed: false });
    }
    // A flag without a time has nothing to switch (no note).
    expect(convert([item({ meridiemWasGuessed: true })]).drafts[0]?.notes).toEqual(['due_time_defaulted']);
  });

  test('a remark is leftover; an injected instruction stays leftover and never becomes a title', () => {
    expect(taskDraftsFromOutput(recordedOutput('not-a-task'), SEOUL)).toEqual({ drafts: [], leftover: '요즘 너무 피곤하다' });
    const injected = taskDraftsFromOutput(recordedOutput('injection'), SEOUL);
    expect(injected.drafts.map((draft) => draft.title)).toEqual(['보고서 초안']);
    expect(injected.leftover).toContain('CANARY-TASK-01');
  });

  test('every recorded case converts without throwing and keeps every to-do', () => {
    for (const entry of recorded.cases) {
      const result = taskDraftsFromOutput(entry.output, SEOUL);
      expect({ id: entry.id, count: result.drafts.length }).toEqual({ id: entry.id, count: entry.output.items.length });
    }
  });
});

describe('taskDraftsFromOutput: a DST zone (America/New_York)', () => {
  const beforeFallBack = { timeZone: 'America/New_York', nowMs: Date.parse('2026-10-30T16:00:00.000Z') };
  const beforeSpringForward = { timeZone: 'America/New_York', nowMs: Date.parse('2027-03-12T16:00:00.000Z') };

  test('the end of a local day follows the offset of that day', () => {
    const [edt, est] = convert([item({ dueDate: '2026-10-31' }), item({ dueDate: '2026-11-01' })], '', beforeFallBack).drafts;
    expect(edt?.dueAt).toBe('2026-11-01T03:59:00.000Z');
    expect(est?.dueAt).toBe('2026-11-02T04:59:00.000Z');
  });

  test('a time in the autumn fold takes the first (EDT) instant; one in the spring gap moves forward', () => {
    expect(convert([item({ dueDate: '2026-11-01', dueTime: '01:30' })], '', beforeFallBack).drafts[0]?.dueAt).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    expect(convert([item({ dueDate: '2027-03-14', dueTime: '02:30' })], '', beforeSpringForward).drafts[0]?.dueAt).toBe(
      '2027-03-14T07:30:00.000Z',
    );
  });
});

describe('taskDraftsFromOutput: a deadline the server cannot accept is dropped, the task stays (negative)', () => {
  test.each([
    ['an impossible calendar date', item({ dueDate: '2026-02-30' })],
    ['an hour past 23', item({ dueDate: '2026-11-20', dueTime: '24:30' })],
    ['a date-only deadline more than a day ago', item({ dueDate: '2026-11-11' })],
    ['a timed deadline more than a day ago', item({ dueDate: '2026-11-12', dueTime: '04:00' })],
    ['a date more than two years ahead', item({ dueDate: '2028-11-14' })],
    ['a time more than two years ahead', item({ dueDate: '2028-11-13', dueTime: '15:00' })],
    ['a time without a day (the prompt rule was broken)', item({ dueDate: null, dueTime: '15:00' })],
    ['a guessed day and half-day on a bad date', item({ dueDate: '2026-13-01', dateWasGuessed: true, meridiemWasGuessed: true })],
  ])('%s', (_label, bad) => {
    const result = convert([bad, item({ title: '장보기', dueDate: null })], '요즘 너무 피곤하다');
    expect(result.drafts).toEqual([
      { title: '보고서 초안', notes: ['due_dropped'] },
      { title: '장보기', notes: [] },
    ]);
    expect(result.drafts[0]).not.toHaveProperty('dueAt');
    expect(result.leftover).toBe('요즘 너무 피곤하다');
  });

  test('up to one day ago and up to two years ahead (that day, by date) is still accepted', () => {
    const result = convert([
      item({ dueDate: '2026-11-12' }),
      item({ dueDate: '2026-11-12', dueTime: '15:00' }),
      item({ dueDate: '2028-11-13' }),
      item({ dueDate: '2028-11-13', dueTime: '14:00' }),
    ]);
    expect(result.drafts.map((draft) => draft.notes.includes('due_dropped'))).toEqual([false, false, false, false]);
  });

  test('only a blank title cannot become a task: its date goes to the leftover', () => {
    const result = convert([item({ title: '   ', dueDate: '2026-11-14', dueTime: '09:00' }), item({ title: '장보기', dueDate: null })]);
    expect(result.drafts).toEqual([{ title: '장보기', notes: [] }]);
    expect(result.leftover).toBe('(2026-11-14 09:00)');
  });

  test('the leftover is bounded', () => {
    const cut = convert([], 'x'.repeat(4_000)).leftover;
    expect(Array.from(cut)).toHaveLength(3_000);
    expect(cut.endsWith('…')).toBe(true);
  });
});

// ── The use-case: run lifecycle and failure mapping (shared NoteDraftReader) ──

interface RunLog {
  readonly recorded: AgentRunInput[];
  readonly completed: { readonly id: Id; readonly completion: AgentRunCompletion }[];
}

function harness(options: {
  readonly llm: LlmPort | null;
  readonly limits?: { readonly maxOutputTokens: number; readonly timeoutMs: number };
  readonly zone?: string;
}) {
  const clock = new FakeClock(SEOUL_NOW as never);
  const runs: RunLog = { recorded: [], completed: [] };
  const service = new TaskParseService({
    clock,
    ids: createSeededIdGenerator(11, clock),
    agentRuns: {
      recordRun: async (input) => {
        runs.recorded.push(input);
      },
      completeRun: async (_owner, id, completion) => {
        runs.completed.push({ id, completion });
      },
    },
    llm: options.llm,
    llmProvider: 'deepseek',
    budgetGuard: new BudgetGuard({ dailyUsd: 1, monthlyUsd: 1 }, { allowUnpricedModels: ['fake-llm'] }),
    ...(options.limits === undefined ? {} : { promptLimits: { task_parse: options.limits } }),
    ownerLocales: { localeOf: async () => 'ko-KR' },
    ownerZone: async () => options.zone ?? 'Asia/Seoul',
  });
  return { service, runs };
}

class HangingLlm implements LlmPort {
  started = 0;
  async complete(request: LlmCompleteRequest): Promise<LlmCompleteResponse> {
    this.started += 1;
    return new Promise((_resolve, reject) => {
      const abort = (): void => reject(new LlmUnavailable('llm call aborted by caller', 'aborted', false));
      if (request.signal?.aborted === true) abort();
      request.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

async function problemOf(promise: Promise<unknown>): Promise<DailyProblemError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DailyProblemError);
  return error as DailyProblemError;
}

describe('TaskParseService', () => {
  test('happy path: a task_parse run, the fenced note in its own block and the local now go to the model', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('task_parse', { output: recordedOutput('several') });
    const { service, runs } = harness({ llm });
    const result = await service.parse(OWNER, { text: '  다음 주 수요일 발표 자료 만들기, 내일까지 교수님께 메일  ' });
    expect(result.drafts.map((draft) => draft.title)).toEqual(['발표 자료 만들기', '교수님께 메일']);
    expect(runs.recorded).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        purpose: 'task_parse',
        promptIdVersion: 'task_parse@v1',
        provider: 'deepseek',
        status: 'pending',
        redactionReport: {},
      }),
    ]);
    expect(runs.completed).toEqual([
      { id: runs.recorded[0]?.id, completion: expect.objectContaining({ status: 'succeeded', model: 'fake-llm' }) },
    ]);
    expect(llm.calls[0]).toMatchObject({ promptId: 'task_parse', version: 'v1', schemaId: 'llm.task_parse.v1' });
    const input = llm.calls[0]?.input as Record<string, unknown>;
    expect(input['configVersion']).toBe('task-parse@1');
    expect(input['now']).toEqual({ date: '2026-11-13', weekday: 'FR', time: '14:05' });
    expect(input['calendar']).toEqual(commitmentCalendar('2026-11-13'));
    expect(input['text']).toBe(
      '<untrusted_document id="task-text">\n다음 주 수요일 발표 자료 만들기, 내일까지 교수님께 메일\n</untrusted_document>',
    );
  });

  test('the request zone wins over the owner zone', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('task_parse', { output: { items: [item({ dueDate: '2026-11-13', dueTime: '09:00' })], leftover: '' } });
    const { service } = harness({ llm, zone: 'Asia/Seoul' });
    const result = await service.parse(OWNER, { text: 'report by 9am', timeZone: 'America/New_York' });
    expect(result.drafts[0]?.dueAt).toBe('2026-11-13T14:00:00.000Z');
    expect((llm.calls[0]?.input as Record<string, unknown>)['now']).toEqual({ date: '2026-11-13', weekday: 'FR', time: '00:05' });
  });

  test('ten items are the cap; an eleven-item answer is a schema failure -> 503, never 11 drafts (negative)', async () => {
    const ten = new FakeLlm();
    ten.addPromptFallback('task_parse', {
      output: { items: Array.from({ length: 10 }, (_, index) => item({ title: `할 일 ${index}` })), leftover: '' },
    });
    expect((await harness({ llm: ten }).service.parse(OWNER, { text: '열 개' })).drafts).toHaveLength(10);
    const eleven = new FakeLlm();
    eleven.addPromptFallback('task_parse', { output: { items: Array.from({ length: 11 }, () => item()), leftover: '' } });
    const { service, runs } = harness({ llm: eleven });
    expect(await problemOf(service.parse(OWNER, { text: '열한 개' }))).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(eleven.calls).toHaveLength(2);
    expect(runs.completed[0]?.completion.status).toBe('failed');
  });

  test('no provider -> 503 llm_unavailable and no run; a blank note is a 422 before any call (negative)', async () => {
    const none = harness({ llm: null });
    const problem = await problemOf(none.service.parse(OWNER, { text: '장보기' }));
    expect(problem).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(problem.detail).toContain('task');
    expect(none.runs.recorded).toEqual([]);
    const llm = new FakeLlm();
    const blank = harness({ llm });
    await expect(blank.service.parse(OWNER, { text: ' \n ' })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(llm.calls).toHaveLength(0);
    expect(blank.runs.recorded).toEqual([]);
  });

  test('budget exhausted -> 503 budget_exceeded; unavailable (incl. consent) -> 503 llm_unavailable', async () => {
    const budget = new FakeLlm();
    budget.addPromptFallback('task_parse', { error: new BudgetExceeded('daily', 0.2, 0.2) });
    const spent = harness({ llm: budget });
    expect(await problemOf(spent.service.parse(OWNER, { text: '장보기' }))).toMatchObject({ code: 'budget_exceeded' });
    expect(spent.runs.completed[0]?.completion.status).toBe('budget_exceeded');

    const down = new FakeLlm();
    down.addPromptFallback('task_parse', { error: new LlmUnavailable('LLM consent is missing or revoked', 'provider', false) });
    const off = harness({ llm: down });
    const problem = await problemOf(off.service.parse(OWNER, { text: '장보기' }));
    expect(problem).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(problem.detail).not.toContain('장보기');
    expect(off.runs.completed[0]?.completion.status).toBe('failed');
  });

  test('timeout within the small bound and an aborted read (cancelled) -> 503', async () => {
    const slow = new HangingLlm();
    const timed = harness({ llm: slow, limits: { maxOutputTokens: 500, timeoutMs: 40 } });
    expect((await problemOf(timed.service.parse(OWNER, { text: '장보기' }))).detail).toContain('in time');
    expect(timed.runs.completed[0]?.completion.status).toBe('failed');
    expect(harness({ llm: new FakeLlm() }).service.totalTimeoutMs).toBe(50_000);

    const hanging = new HangingLlm();
    const { service, runs } = harness({ llm: hanging });
    const controller = new AbortController();
    const pending = service.parse(OWNER, { text: '장보기' }, controller.signal);
    await vi.waitFor(() => expect(hanging.started).toBe(1));
    controller.abort();
    expect(await problemOf(pending)).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(runs.completed[0]?.completion.status).toBe('cancelled');
  });
});

// ── The fake-provider reader used by the E2E scenarios ─────────────────────

describe('fakeTaskParseOutput (LLM_PROVIDER=fake E2E stand-in)', () => {
  const now = { date: '2026-11-13', weekday: 'FR' as const, time: '14:05' };
  function inputOf(text: string) {
    return buildTaskParseInput({
      text,
      now,
      calendar: commitmentCalendar(now.date),
      timeZone: 'Asia/Seoul',
      outputLanguage: 'ko-KR',
    }).input;
  }
  const read = (text: string): TaskParseOutput => fakeTaskParseOutput(inputOf(text));

  test('every part is a task; a named day or time is its deadline', () => {
    expect(read('내일까지 교수님께 메일, 장보기')).toEqual({
      items: [item({ title: '교수님께 메일', dueDate: '2026-11-14' }), item({ title: '장보기', dueDate: null })],
      leftover: '',
    });
    expect(read('다음 주 수요일 발표 자료 만들기').items[0]).toMatchObject({ title: '발표 자료 만들기', dueDate: '2026-11-18' });
    expect(read('월요일 전에 과제 제출').items[0]).toMatchObject({ title: '과제 제출', dueDate: '2026-11-15' });
    expect(read('내일 9시까지 회의록 정리').items[0]).toMatchObject({
      title: '회의록 정리',
      dueDate: '2026-11-14',
      dueTime: '09:00',
      meridiemWasGuessed: true,
    });
    expect(read('3시에 치과').items[0]).toMatchObject({ title: '치과', dueDate: '2026-11-13', dueTime: '15:00', dateWasGuessed: true });
  });

  test('a remark is leftover and a broken input is an empty answer (negative)', () => {
    expect(read('요즘 너무 피곤하다')).toEqual({ items: [], leftover: '요즘 너무 피곤하다' });
    expect(fakeTaskParseOutput({ text: 'no fence' })).toEqual({ items: [], leftover: '' });
    // The commitment fence is not the task fence.
    expect(fakeTaskParseOutput({ ...inputOf('장보기'), text: '<untrusted_document id="commitment-text">\n장보기\n</untrusted_document>' })).toEqual({
      items: [],
      leftover: '',
    });
  });

  test('the scripted (slow) and grounded fake owners answer it; others keep the plain fake', async () => {
    const input = inputOf('내일까지 교수님께 메일');
    expect(scriptedFakeOutput('llm.task_parse.v1', input)).toEqual(read('내일까지 교수님께 메일'));
    const scenario = new E2eGroundedFakeLlm({ owners: [OWNER] });
    const request = { promptId: 'task_parse', version: 'v1', schemaId: 'llm.task_parse.v1', input };
    expect((await scenario.complete({ ...request, ownerId: OWNER })).output).toEqual(read('내일까지 교수님께 메일'));
    await expect(scenario.complete({ ...request, ownerId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0a02' })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
  });
});
