/**
 * CAL-02 — POST /commitments:parse, the use-case without HTTP or a database:
 * model output -> drafts (instants in the zone, defaults, notes, validation
 * into leftover), the agent_run lifecycle and the failure mapping. FakeLlm
 * and in-memory ports only. The HTTP/DB behaviour is commitment-parse-api.test.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitmentParseResponse } from '@ohmydate/contracts';
import { DailyProblemError } from '../src/application/daily-errors.js';
import type { Id } from '@ohmydate/domain';
import { ValidationFailedError } from '@ohmydate/domain';
import {
  BudgetExceeded,
  BudgetGuard,
  FakeLlm,
  LlmUnavailable,
  commitmentCalendar,
  type CommitmentParseItem,
  type CommitmentParseOutput,
  type LlmCompleteRequest,
  type LlmCompleteResponse,
  type LlmPort,
} from '@ohmydate/llm';
import { FakeClock, createSeededIdGenerator } from '@ohmydate/testkit';
import {
  CommitmentParseService,
  draftsFromOutput,
  localNowOf,
} from '../src/application/commitment-parse/commitment-parse-service.js';
import type { AgentRunCompletion, AgentRunInput } from '../src/application/intake/ports.js';
import { fakeCommitmentParseOutput } from '../src/adapters/fake-commitment-parse.js';
import { scriptedFakeOutput } from '../src/adapters/scripted-fake-llm.js';
import { E2eGroundedFakeLlm } from '../src/adapters/fake-llm-scenarios.js';
import { buildCommitmentParseInput } from '@ohmydate/llm';

interface RecordedCase {
  readonly id: string;
  readonly text: string;
  readonly output: CommitmentParseOutput;
}

const recorded = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '..', '..', '..', 'packages', 'llm', 'test', 'fixtures', 'commitment-parse', 'cases.json'),
    'utf8',
  ),
) as { readonly cases: readonly RecordedCase[] };

const OWNER = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0a01' as Id;
/** Friday 2026-11-13 14:05 in Seoul (the recorded fixtures' "now"). */
const SEOUL_NOW = '2026-11-13T05:05:00.000Z';
const SEOUL = { timeZone: 'Asia/Seoul', nowMs: Date.parse(SEOUL_NOW) };

function item(overrides: Partial<CommitmentParseItem> = {}): CommitmentParseItem {
  return {
    title: '치과',
    date: '2026-11-17',
    startTime: '15:00',
    endTime: null,
    endDate: null,
    weeklyDays: null,
    untilDate: null,
    dateWasGuessed: false,
    ...overrides,
  };
}

function convert(items: readonly CommitmentParseItem[], leftover = '', context = SEOUL) {
  return draftsFromOutput({ items, leftover }, context);
}

function recordedOutput(id: string): CommitmentParseOutput {
  const entry = recorded.cases.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no recorded case ${id}`);
  return entry.output;
}

describe('draftsFromOutput: recorded phrase classes in Asia/Seoul', () => {
  test('local dates and times become UTC instants; no end -> +60 min', () => {
    const tomorrow = draftsFromOutput(recordedOutput('relative-tomorrow'), SEOUL);
    expect(tomorrow).toEqual({
      drafts: [
        {
          title: '회의',
          timeZone: 'Asia/Seoul',
          date: '2026-11-14',
          startAt: '2026-11-14T01:00:00.000Z',
          endAt: '2026-11-14T02:00:00.000Z',
          notes: ['duration_defaulted'],
        },
      ],
      leftover: '',
    });
    expect(draftsFromOutput(recordedOutput('next-week-weekday'), SEOUL).drafts[0]).toMatchObject({
      date: '2026-11-17',
      startAt: '2026-11-17T06:00:00.000Z',
      endAt: '2026-11-17T07:00:00.000Z',
    });
  });

  test('ranges, lengths and an overnight end on the next date', () => {
    expect(draftsFromOutput(recordedOutput('day-of-month-range'), SEOUL).drafts[0]).toEqual({
      title: '동창 모임',
      timeZone: 'Asia/Seoul',
      date: '2026-11-14',
      startAt: '2026-11-14T10:00:00.000Z',
      endAt: '2026-11-14T12:00:00.000Z',
      notes: [],
    });
    expect(draftsFromOutput(recordedOutput('duration'), SEOUL).drafts[0]).toMatchObject({
      startAt: '2026-11-14T00:00:00.000Z',
      endAt: '2026-11-14T02:00:00.000Z',
      notes: [],
    });
    expect(draftsFromOutput(recordedOutput('overnight'), SEOUL).drafts[0]).toMatchObject({
      date: '2026-11-13',
      startAt: '2026-11-13T14:00:00.000Z',
      endAt: '2026-11-13T17:00:00.000Z',
    });
  });

  test('a guessed date says so; a note with no time gives a draft without instants', () => {
    expect(draftsFromOutput(recordedOutput('no-day-range'), SEOUL).drafts[0]).toMatchObject({
      date: '2026-11-13',
      startAt: '2026-11-13T06:00:00.000Z',
      endAt: '2026-11-13T08:00:00.000Z',
      notes: ['date_assumed'],
    });
    const weekend = draftsFromOutput(recordedOutput('this-weekend'), SEOUL).drafts[0];
    expect(weekend).toEqual({ title: '영화 보기', timeZone: 'Asia/Seoul', date: '2026-11-14', notes: ['date_assumed'] });
    expect(weekend).not.toHaveProperty('startAt');
    expect(weekend).not.toHaveProperty('endAt');
  });

  test('weekly repeats become an RRULE the expander accepts, with UNTIL when given', () => {
    expect(draftsFromOutput(recordedOutput('weekly-ambiguous-hour'), SEOUL).drafts[0]).toEqual({
      title: '스터디',
      timeZone: 'Asia/Seoul',
      date: '2026-11-19',
      startAt: '2026-11-18T22:00:00.000Z',
      endAt: '2026-11-18T23:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      notes: ['duration_defaulted', 'repeats_weekly'],
    });
    expect(draftsFromOutput(recordedOutput('weekly-evening-until'), SEOUL).drafts[0]).toMatchObject({
      startAt: '2026-11-19T10:00:00.000Z',
      rrule: 'FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231',
    });
  });

  test('several events keep their order; the leftover and a non-event pass through', () => {
    const several = draftsFromOutput(recordedOutput('several'), SEOUL);
    expect(several.drafts.map((draft) => draft.title)).toEqual(['회의', '점심 약속']);
    expect(several.leftover).toBe('보고서 쓰기');
    expect(draftsFromOutput(recordedOutput('not-an-event'), SEOUL)).toEqual({ drafts: [], leftover: '요즘 너무 피곤하다' });
    const injected = draftsFromOutput(recordedOutput('injection'), SEOUL);
    expect(injected.drafts.map((draft) => draft.title)).toEqual(['치과']);
    expect(injected.leftover).toContain('CANARY-NL-01');
  });

  test('every recorded case converts without throwing and every timed draft ends after it starts', () => {
    for (const entry of recorded.cases) {
      const { drafts } = draftsFromOutput(entry.output, SEOUL);
      for (const draft of drafts) {
        expect((draft.startAt === undefined) === (draft.endAt === undefined)).toBe(true);
        if (draft.startAt !== undefined && draft.endAt !== undefined) {
          expect(Date.parse(draft.endAt)).toBeGreaterThan(Date.parse(draft.startAt));
        }
      }
    }
  });
});

describe('draftsFromOutput: a DST zone (America/New_York)', () => {
  const beforeFallBack = { timeZone: 'America/New_York', nowMs: Date.parse('2026-10-30T16:00:00.000Z') };
  const beforeSpringForward = { timeZone: 'America/New_York', nowMs: Date.parse('2027-03-12T16:00:00.000Z') };

  test('a wall time in the autumn fold takes the first (EDT) instant; the end is in EST', () => {
    const [draft] = convert([item({ date: '2026-11-01', startTime: '01:30', endTime: '02:30' })], '', beforeFallBack).drafts;
    expect(draft).toMatchObject({ startAt: '2026-11-01T05:30:00.000Z', endAt: '2026-11-01T07:30:00.000Z' });
  });

  test('a wall time in the spring gap moves forward to the next valid instant', () => {
    const [draft] = convert([item({ date: '2027-03-14', startTime: '02:30', endTime: '04:00' })], '', beforeSpringForward).drafts;
    expect(draft).toMatchObject({ startAt: '2027-03-14T07:30:00.000Z', endAt: '2027-03-14T08:00:00.000Z' });
  });

  test('the same local 09:00 maps to different UTC hours across the change', () => {
    const before = convert([item({ date: '2026-10-31', startTime: '09:00' })], '', beforeFallBack).drafts[0];
    const after = convert([item({ date: '2026-11-02', startTime: '09:00' })], '', beforeFallBack).drafts[0];
    expect(before?.startAt).toBe('2026-10-31T13:00:00.000Z');
    expect(after?.startAt).toBe('2026-11-02T14:00:00.000Z');
  });
});

describe('draftsFromOutput: items the server cannot accept go to leftover (negative)', () => {
  test.each([
    ['an impossible calendar date', item({ date: '2026-02-30', startTime: '10:00' }), '치과 (2026-02-30 10:00)'],
    ['an end before the start', item({ startTime: '10:00', endTime: '09:00' }), '치과 (2026-11-17 10:00)'],
    ['an end on an earlier date', item({ startTime: '23:00', endTime: '01:00', endDate: '2026-11-16' }), '치과 (2026-11-17 23:00)'],
    ['a start more than a day ago', item({ date: '2026-11-12', startTime: '13:00' }), '치과 (2026-11-12 13:00)'],
    ['a date more than a day ago without a time', item({ date: '2026-11-11', startTime: null }), '치과 (2026-11-11)'],
    ['a start more than two years ahead', item({ date: '2028-11-13', startTime: '15:00' }), '치과 (2028-11-13 15:00)'],
    ['an hour past 23', item({ startTime: '24:30' }), '치과 (2026-11-17 24:30)'],
    ['an until date before the start', item({ weeklyDays: ['TH'], untilDate: '2026-11-18' }), '치과 (2026-11-17 15:00)'],
    ['a blank title', item({ title: '   ' }), '(2026-11-17 15:00)'],
  ])('%s', (_label, bad, text) => {
    const result = convert([bad, item({ title: '회의', date: '2026-11-20' })], '보고서 쓰기');
    expect(result.drafts.map((draft) => draft.title)).toEqual(['회의']);
    expect(result.leftover).toBe(`보고서 쓰기 / ${text}`);
  });

  test('a start up to one day ago and up to two years ahead is still accepted', () => {
    const result = convert([
      item({ date: '2026-11-12', startTime: '15:00' }),
      item({ date: '2028-11-13', startTime: '14:00' }),
    ]);
    expect(result.drafts).toHaveLength(2);
    expect(result.leftover).toBe('');
  });

  test('a weekly draft starts on its first listed weekday; days are ordered and deduplicated', () => {
    const [draft] = convert([item({ date: '2026-11-17', weeklyDays: ['FR', 'TH', 'TH'] })]).drafts;
    expect(draft).toMatchObject({ date: '2026-11-19', rrule: 'FREQ=WEEKLY;BYDAY=TH,FR', startAt: '2026-11-19T06:00:00.000Z' });
  });

  test('the leftover is bounded', () => {
    // Ten dropped 200-character items plus a full model leftover stay under the bound…
    const many = Array.from({ length: 10 }, (_, index) => item({ title: `${'긴'.repeat(195)}${index}`, date: '2026-02-30' }));
    const result = convert(many, 'x'.repeat(500));
    expect(result.drafts).toEqual([]);
    expect(Array.from(result.leftover).length).toBeLessThanOrEqual(3_000);
    expect(result.leftover).toContain(`${'긴'.repeat(195)}9 (2026-02-30 15:00)`);
    // …and anything longer is cut, never passed on unbounded.
    const cut = convert([], 'x'.repeat(4_000)).leftover;
    expect(Array.from(cut)).toHaveLength(3_000);
    expect(cut.endsWith('…')).toBe(true);
  });
});

test('localNowOf gives the local date, weekday and time in the zone', () => {
  expect(localNowOf(Date.parse(SEOUL_NOW), 'Asia/Seoul')).toEqual({ date: '2026-11-13', weekday: 'FR', time: '14:05' });
  expect(localNowOf(Date.parse('2026-11-13T23:30:00.000Z'), 'Asia/Seoul')).toEqual({ date: '2026-11-14', weekday: 'SA', time: '08:30' });
  expect(localNowOf(Date.parse('2026-11-13T03:00:00.000Z'), 'America/New_York')).toEqual({ date: '2026-11-12', weekday: 'TH', time: '22:00' });
});

// ── The use-case: run lifecycle and failure mapping ────────────────────────

interface RunLog {
  readonly recorded: AgentRunInput[];
  readonly completed: { readonly id: Id; readonly completion: AgentRunCompletion }[];
}

function harness(options: {
  readonly llm: LlmPort | null;
  readonly now?: string;
  readonly limits?: { readonly maxOutputTokens: number; readonly timeoutMs: number };
  readonly locale?: string | null;
  readonly zone?: string;
}) {
  const clock = new FakeClock(SEOUL_NOW as never);
  if (options.now !== undefined) clock.set(options.now as never);
  const runs: RunLog = { recorded: [], completed: [] };
  const service = new CommitmentParseService({
    clock,
    ids: createSeededIdGenerator(7, clock),
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
    ...(options.limits === undefined ? {} : { promptLimits: { commitment_parse: options.limits } }),
    ownerLocales: { localeOf: async () => options.locale ?? 'ko-KR' },
    ownerZone: async () => options.zone ?? 'Asia/Seoul',
  });
  return { service, runs };
}

/** Waits until aborted (an attempt that never answers by itself). */
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

describe('CommitmentParseService', () => {
  test('happy path: one pending run settled succeeded, the fenced note and local now go to the model', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('commitment_parse', { output: recordedOutput('next-week-weekday') });
    const { service, runs } = harness({ llm });
    const result: CommitmentParseResponse = await service.parse(OWNER, { text: '  다음 주 화요일 오후 3시에 치과  ' });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({ title: '치과', timeZone: 'Asia/Seoul', startAt: '2026-11-17T06:00:00.000Z' });
    expect(runs.recorded).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        purpose: 'commitment_parse',
        promptIdVersion: 'commitment_parse@v1',
        provider: 'deepseek',
        status: 'pending',
        redactionReport: {},
      }),
    ]);
    expect(runs.completed).toEqual([
      { id: runs.recorded[0]?.id, completion: expect.objectContaining({ status: 'succeeded', model: 'fake-llm' }) },
    ]);
    const input = llm.calls[0]?.input as Record<string, unknown>;
    expect(llm.calls[0]).toMatchObject({ promptId: 'commitment_parse', version: 'v1', schemaId: 'llm.commitment_parse.v1' });
    expect(input['now']).toEqual({ date: '2026-11-13', weekday: 'FR', time: '14:05' });
    expect(input['calendar']).toEqual(commitmentCalendar('2026-11-13'));
    expect(input['timeZone']).toBe('Asia/Seoul');
    expect(input['outputLanguage']).toBe('ko-KR');
    expect(input['text']).toBe('<untrusted_document id="commitment-text">\n다음 주 화요일 오후 3시에 치과\n</untrusted_document>');
  });

  test('the request zone wins over the owner zone; a broken locale falls back to ko-KR', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('commitment_parse', { output: { items: [item({ date: '2026-11-17', startTime: '09:00' })], leftover: '' } });
    const { service } = harness({ llm, locale: 'x-not-a-language', zone: 'Asia/Seoul' });
    const result = await service.parse(OWNER, { text: 'Tuesday 9am dentist', timeZone: 'America/New_York' });
    expect(result.drafts[0]).toMatchObject({ timeZone: 'America/New_York', startAt: '2026-11-17T14:00:00.000Z' });
    const input = llm.calls[0]?.input as Record<string, unknown>;
    expect(input['timeZone']).toBe('America/New_York');
    expect(input['now']).toEqual({ date: '2026-11-13', weekday: 'FR', time: '00:05' });
    expect(input['outputLanguage']).toBe('ko-KR');
  });

  test('masked values are counted on the run, never stored as text', async () => {
    const llm = new FakeLlm([], { recordInputs: true });
    llm.addPromptFallback('commitment_parse', { output: { items: [], leftover: '' } });
    const { service, runs } = harness({ llm });
    await service.parse(OWNER, { text: '내일 3시 상담 010-1234-5678' });
    expect(runs.recorded[0]?.redactionReport).toEqual({ phone: 1 });
    expect(JSON.stringify(llm.calls[0]?.input)).not.toContain('010-1234-5678');
  });

  test('ten items are the cap; an eleven-item answer is a schema failure -> 503, never 11 drafts (negative)', async () => {
    const ten = new FakeLlm();
    ten.addPromptFallback('commitment_parse', {
      output: { items: Array.from({ length: 10 }, (_, index) => item({ title: `약속 ${index}` })), leftover: '' },
    });
    expect((await harness({ llm: ten }).service.parse(OWNER, { text: '열 개' })).drafts).toHaveLength(10);

    const eleven = new FakeLlm();
    eleven.addPromptFallback('commitment_parse', {
      output: { items: Array.from({ length: 11 }, () => item()), leftover: '' },
    });
    const { service, runs } = harness({ llm: eleven });
    const problem = await problemOf(service.parse(OWNER, { text: '열한 개' }));
    expect(problem).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(eleven.calls).toHaveLength(2); // the single repair, then give up
    expect(runs.completed[0]?.completion.status).toBe('failed');
  });

  test('no provider -> 503 llm_unavailable and no run (negative)', async () => {
    const { service, runs } = harness({ llm: null });
    expect(await problemOf(service.parse(OWNER, { text: '내일 3시 치과' }))).toMatchObject({
      status: 503,
      code: 'llm_unavailable',
    });
    expect(runs.recorded).toEqual([]);
  });

  test('a note of spaces only is a 422 before any call (negative)', async () => {
    const llm = new FakeLlm();
    const { service, runs } = harness({ llm });
    await expect(service.parse(OWNER, { text: ' \n\t ' })).rejects.toBeInstanceOf(ValidationFailedError);
    expect(llm.calls).toHaveLength(0);
    expect(runs.recorded).toEqual([]);
  });

  test('budget exhausted -> 503 budget_exceeded, run budget_exceeded', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', { error: new BudgetExceeded('daily', 0.2, 0.2) });
    const { service, runs } = harness({ llm });
    expect(await problemOf(service.parse(OWNER, { text: '내일 3시 치과' }))).toMatchObject({
      status: 503,
      code: 'budget_exceeded',
    });
    expect(runs.completed[0]?.completion.status).toBe('budget_exceeded');
  });

  test('provider unavailable (incl. missing consent) -> 503 llm_unavailable, run failed', async () => {
    const llm = new FakeLlm();
    llm.addPromptFallback('commitment_parse', {
      error: new LlmUnavailable('LLM consent is missing or revoked; using manual mode', 'provider', false),
    });
    const { service, runs } = harness({ llm });
    const problem = await problemOf(service.parse(OWNER, { text: '내일 3시 치과' }));
    expect(problem).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(problem.detail).not.toContain('치과');
    expect(runs.completed[0]?.completion.status).toBe('failed');
  });

  test('a provider that never answers times out within the small bound -> 503, run failed', async () => {
    const llm = new HangingLlm();
    const { service, runs } = harness({ llm, limits: { maxOutputTokens: 500, timeoutMs: 40 } });
    const started = Date.now();
    const problem = await problemOf(service.parse(OWNER, { text: '내일 3시 치과' }));
    expect(problem).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(problem.detail).toContain('in time');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(llm.started).toBe(1); // timeouts are never retried
    expect(runs.completed[0]?.completion.status).toBe('failed');
  });

  test('the default bound is small: 20 s per attempt, 50 s for the whole read', () => {
    expect(harness({ llm: new FakeLlm() }).service.totalTimeoutMs).toBe(50_000);
  });

  test('an aborted read (client disconnect / shutdown) -> run cancelled, 503', async () => {
    const llm = new HangingLlm();
    const { service, runs } = harness({ llm });
    const controller = new AbortController();
    const pending = service.parse(OWNER, { text: '내일 3시 치과' }, controller.signal);
    await vi.waitFor(() => expect(llm.started).toBe(1));
    controller.abort();
    expect(await problemOf(pending)).toMatchObject({ status: 503, code: 'llm_unavailable' });
    expect(runs.completed[0]?.completion.status).toBe('cancelled');
  });
});

// ── The fake-provider reader used by the E2E scenarios ─────────────────────

describe('fakeCommitmentParseOutput (LLM_PROVIDER=fake E2E stand-in)', () => {
  const now = { date: '2026-11-13', weekday: 'FR' as const, time: '14:05' };
  function read(text: string) {
    const { input } = buildCommitmentParseInput({
      text,
      now,
      calendar: commitmentCalendar(now.date),
      timeZone: 'Asia/Seoul',
      outputLanguage: 'ko-KR',
    });
    return fakeCommitmentParseOutput(input);
  }

  test('reads a few fixed phrase shapes into schema-valid items', () => {
    expect(read('내일 오후 3시에 치과').items).toEqual([item({ date: '2026-11-14', startTime: '15:00' })]);
    expect(read('다음 주 화요일 3시 치과').items[0]).toMatchObject({ date: '2026-11-17', startTime: '15:00', title: '치과' });
    expect(read('14일 저녁 7시부터 9시까지 동창 모임').items[0]).toMatchObject({
      title: '동창 모임',
      date: '2026-11-14',
      startTime: '19:00',
      endTime: '21:00',
    });
    expect(read('매주 목요일 7시 스터디').items[0]).toMatchObject({ weeklyDays: ['TH'], date: '2026-11-19', startTime: '07:00' });
    expect(read('이번 주말 영화 보기').items[0]).toMatchObject({ date: '2026-11-14', startTime: null, dateWasGuessed: true });
  });

  test('anything else is leftover, and a broken input is an empty answer (negative)', () => {
    expect(read('요즘 너무 피곤하다')).toEqual({ items: [], leftover: '요즘 너무 피곤하다' });
    expect(read('내일 오전 10시 회의, 보고서 쓰기')).toMatchObject({ leftover: '보고서 쓰기' });
    expect(fakeCommitmentParseOutput({ text: 'no fence' })).toEqual({ items: [], leftover: '' });
  });

  test('the scripted (slow) and grounded fake owners answer it; others keep the plain fake', async () => {
    const { input } = buildCommitmentParseInput({
      text: '내일 오후 3시에 치과',
      now,
      calendar: commitmentCalendar(now.date),
      timeZone: 'Asia/Seoul',
      outputLanguage: 'ko-KR',
    });
    expect(scriptedFakeOutput('llm.commitment_parse.v1', input)).toEqual(read('내일 오후 3시에 치과'));
    const scenario = new E2eGroundedFakeLlm({ owners: [OWNER] });
    const request = { promptId: 'commitment_parse', version: 'v1', schemaId: 'llm.commitment_parse.v1', input };
    expect((await scenario.complete({ ...request, ownerId: OWNER })).output).toEqual(read('내일 오후 3시에 치과'));
    await expect(scenario.complete({ ...request, ownerId: '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b0a02' })).rejects.toBeInstanceOf(
      LlmUnavailable,
    );
  });
});
