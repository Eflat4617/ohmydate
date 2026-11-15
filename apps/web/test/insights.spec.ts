import { flushPromises } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { isUuidV7Key, plannerClient, type ScheduleBlock } from '../src/api';
import { setLayoutClock } from '../src/layout/clock';
import { REPORT_TEMPLATE_ID, TODAY_TASK_ONE_ID, TODAY_TASK_ONE_TITLE, mockDb } from '../src/mocks/db';
import { seedOverviewSessions } from '../src/mocks/overview-seed';
import { MOCK_PLAN_VERSION_ID, seedColdEstimation } from '../src/mocks/replan';
import { FEEDBACK_IDS } from '../src/mocks/replan-seed';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';
import InsightsView from '../src/views/InsightsView.vue';
import { bodyText, buttonWith, mountView, waitForText, type Mounted } from './m5-test-utils';

/**
 * AI 분석 (HOLO-03A; was 내 패턴, M5-03): charts of the owner's own records —
 * reviews (the estimation profile), work sessions and confirmed blocks — with
 * honest empty states, the controls to take a record out or reset, and what
 * the AI does with it. The mock's day is 2026-11-14 (Sat) 18:40 in Asia/Seoul.
 */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');

async function mountInsights(): Promise<Mounted> {
  const mounted = await mountView(InsightsView, { path: '/insights' });
  await waitForText(mounted.wrapper, '예상과 실제');
  return mounted;
}

function itemRow(mounted: Mounted, feedbackId: string) {
  return mounted.wrapper.get(`[data-feedback-id="${feedbackId}"]`);
}

/** The text alternative of a bar chart: one row per slot, `[name, value]`. */
function chartRows(mounted: Mounted, insight: string): string[][] {
  return mounted.wrapper
    .get(`[data-insight="${insight}"] [data-chart-table]`)
    .findAll('tbody tr')
    .map((row) => row.findAll('th, td').map((cell) => cell.text()));
}

function pastBlock(index: number, status: ScheduleBlock['status'], day = '2026-11-12'): ScheduleBlock {
  return {
    id: `01900000-0000-7000-8000-0000000007${(0x10 + index).toString(16)}`,
    planVersionId: MOCK_PLAN_VERSION_ID,
    taskId: TODAY_TASK_ONE_ID,
    startAt: `${day}T0${index}:00:00.000Z`,
    endAt: `${day}T0${index}:30:00.000Z`,
    locked: false,
    status,
    version: 1,
  };
}

beforeEach(() => {
  localStorage.clear();
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  setLayoutClock(null);
});

describe('AI 분석 — 예상과 실제 (what reviews taught)', () => {
  it('shows the one number, which way it leans, and the records behind it as a trend', async () => {
    const mounted = await mountInsights();
    const { wrapper } = mounted;
    await vi.waitFor(() => expect(wrapper.find('[data-estimate-ratio]').exists()).toBe(true));
    // (85 + 35 + 60 + 75) ÷ (60 + 30 + 45 + 60): the four records that count.
    expect(wrapper.get('[data-estimate-ratio]').text()).toBe('1.31배');
    expect(wrapper.get('[data-lean]').attributes('data-lean')).toBe('over');
    expect(wrapper.get('[data-lean]').text()).toBe('예상보다 31% 더 걸려요');
    expect(wrapper.get('[data-insight="estimate"]').text()).toContain('회고 4개의 실제 시간을 예상 시간으로 나눈 값이에요.');
    expect(wrapper.get('[data-summary="samples"]').text()).toBe('4개');
    expect(wrapper.get('[data-summary="confidence"]').text()).toBe('보통 (44%)');

    // The trend draws exactly the counted records (the outlier and the one taken out are not points).
    const trend = wrapper.get('[data-estimate-trend] [data-chart="trend"]');
    expect(trend.attributes('data-points')).toBe('4');
    expect(trend.get('svg').attributes('role')).toBe('img');
    expect(trend.get('svg').attributes('aria-label')).toBe(
      '기록별 실제 ÷ 예상, 11월 8일 (일)부터 11월 13일 (금)까지. 처음 1.25배, 가장 최근 1.42배.',
    );
    expect(wrapper.get('[data-estimate-trend]').text()).toContain('점선은 예상대로(1배)');
    expect(wrapper.find('[data-insights-empty="estimate"]').exists()).toBe(false);
  });

  it('says what the AI does with the records in plain words, with the share it really uses', async () => {
    const { wrapper } = await mountInsights();
    const uses = wrapper.get('[data-insight="uses"]');
    expect(uses.get('h2').text()).toBe('AI가 이 기록으로 하는 일');
    // 4 records against the estimator's 5: 4 ÷ 9.
    await vi.waitFor(() => expect(uses.get('[data-uses-weight]').text()).toContain('지금은 내 기록을 44% 반영하고 있어요.'));
    expect(uses.text()).toContain('평소와 크게 다른 기록은 자동으로 빼요.');
    expect(uses.text()).toContain('회고 메모의 내용은 쓰지 않아요. 걸린 시간만 봐요.');
    // No statistics jargon and no internal names anywhere on the page.
    expect(wrapper.text()).not.toMatch(/P50|P90|\|z\||shrinkage|estimator@|prior\b|이상치/);
    expect(wrapper.text()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('with fewer than three counted records it draws no number and no trend, and says how many there are (negative)', async () => {
    server.use(
      http.get(/\/api\/v1\/estimation\/profile$/, () =>
        HttpResponse.json({
          ...mockDb.estimation,
          sampleCount: 2,
          items: mockDb.estimation.items.filter((item) => item.feedbackId === FEEDBACK_IDS.one || item.feedbackId === FEEDBACK_IDS.two),
        }),
      ),
    );
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.find('[data-insights-empty="estimate"]').exists()).toBe(true));
    const empty = wrapper.get('[data-insights-empty="estimate"]');
    expect(empty.text()).toContain('아직 기록이 부족해요');
    expect(empty.text()).toContain('회고가 3개 쌓이면 예상과 실제를 비교해 드려요. 지금은 2개예요.');
    // No record yet leads back a stage: to 집중, where records are made (FLOW §5).
    expect(empty.get('a').attributes('href')).toBe('/focus');
    expect(empty.get('a').text()).toBe('집중하러 가기');
    // There are records, so this is not the cold start.
    expect(empty.attributes('data-cold-start')).toBeUndefined();
    expect(wrapper.find('[data-estimate-ratio]').exists()).toBe(false);
    expect(wrapper.find('[data-estimate-trend]').exists()).toBe(false);
    expect(wrapper.findAll('[data-feedback-id]')).toHaveLength(2);
  });

  it('explains the cold start: nothing learned yet, the defaults in use, and no record to reset', async () => {
    seedColdEstimation(mockDb);
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.find('[data-cold-start]').exists()).toBe(true));
    const cold = wrapper.get('[data-cold-start]');
    expect(cold.text()).toContain('아직 기록이 부족해요');
    expect(cold.text()).toContain('지금은 0개예요.');
    expect(cold.text()).toContain('집중 세션을 마치고 회고를 남기면 실제로 걸린 시간을 보고 조금씩 배워요.');
    expect(wrapper.get('[data-summary="confidence"]').text()).toBe('낮음 (0%)');
    const uses = wrapper.get('[data-insight="uses"]');
    expect(uses.get('[data-uses-weight]').text()).toBe('기록이 쌓이기 전에는 내 속도를 반영하지 않아요.');
    expect(uses.text()).toContain('템플릿도 없으면 AI 예상에 1.3배 여유를 더해요.');
    expect(wrapper.get('[data-insights-empty="groups"]').text()).toBe('아직 종류별로 모인 기록이 없어요.');
    expect(wrapper.get('[data-insights-empty="records"]').text()).toBe('아직 기록이 없어요.');
    expect(wrapper.get('[data-reset-all]').attributes('disabled')).toBeDefined();
    // An empty state is never the filled button.
    expect(wrapper.find('.btn--primary').exists()).toBe(false);
  });
});

describe('AI 분석 — 종류별', () => {
  it('lists each template and kind with what is applied, the owner’s own mean and a bar against “as estimated”', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.text()).toContain('템플릿 · 보고서 작성'));
    const template = wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`);
    expect(template.text()).toContain('기록 3개 · 신뢰도 보통 (38%)');
    // The applied correction is pulled toward "as estimated", so it is below the owner's raw mean.
    const personal = template.get('[data-ratio="personal"]').text();
    const applied = template.get('[data-ratio="applied"]').text();
    expect(personal).toMatch(/^1\.\d{1,2}배$/);
    expect(applied).toMatch(/^1\.\d{1,2}배$/);
    expect(Number.parseFloat(applied)).toBeLessThan(Number.parseFloat(personal));
    expect(template.get('[data-ratio="roomy"]').text()).toMatch(/^1\.\d{1,2}배$/);
    expect(template.text()).toContain('넉넉히 잡을 때');

    const bar = template.get('[data-chart="ratio"]');
    expect(bar.attributes('aria-hidden')).toBe('true');
    expect(bar.attributes('data-side')).toBe('over');
    expect(bar.find('.ratio-bar-fill').exists()).toBe(true);
    expect(bar.find('.ratio-bar-tick').exists()).toBe(true);

    expect(wrapper.get('[data-group="kind:review"]').text()).toContain('종류 · 검토');
    // Only a template's records can be reset on their own.
    expect(template.findAll('button').map((item) => item.text())).toEqual(['이 템플릿 기록 지우기']);
    expect(wrapper.get('[data-group="kind:review"]').find('button').exists()).toBe(false);
  });
});

describe('AI 분석 — when the owner works (sessions of the last eight weeks)', () => {
  it('draws focus time by week, weekday and time of day, and names the peaks', async () => {
    seedOverviewSessions(mockDb);
    const mounted = await mountInsights();
    const { wrapper } = mounted;
    await vi.waitFor(() => expect(wrapper.find('[data-insight="weeks"] [data-chart="bars"]').exists()).toBe(true));

    // Eight weeks, oldest first; a week without a session is zero, not missing.
    const weeks = chartRows(mounted, 'weeks');
    expect(weeks).toHaveLength(8);
    expect(weeks[0]).toEqual(['9월 21일 주', '0분']);
    expect(weeks[6]).toEqual(['11월 2일 주', '5시간 15분']);
    expect(weeks[7]).toEqual(['11월 9일 주', '6시간 38분']);
    const callout = wrapper.get('[data-insight="weeks"] [data-callout]');
    expect(callout.text()).toContain('6시간 38분');
    expect(callout.text()).toContain('이번 주');
    expect(wrapper.get('[data-insight="weeks"]').text()).toContain('최근 8주');

    expect(chartRows(mounted, 'weekday')).toEqual([
      ['월요일', '2시간 12분'],
      ['화요일', '1시간 18분'],
      ['수요일', '1시간 37분'],
      ['목요일', '2시간 15분'],
      ['금요일', '58분'],
      ['토요일', '3시간 33분'],
      ['일요일', '0분'],
    ]);
    expect(wrapper.get('[data-insights-peak="weekday"]').text()).toBe('토요일에 가장 많이 집중했어요');

    const hours = chartRows(mounted, 'hours');
    expect(hours).toHaveLength(8);
    expect(hours[3]).toEqual(['오전 9시~오후 12시', '2시간 52분']);
    expect(hours[5]).toEqual(['오후 3시~오후 6시', '41분']);
    expect(hours[6]).toEqual(['오후 6시~오후 9시', '7시간 58분']);
    expect(hours[0]).toEqual(['오전 12시~오전 3시', '0분']);
    expect(wrapper.get('[data-insights-peak="hours"]').text()).toBe('오후 6시~오후 9시에 가장 많이 집중했어요');
    expect(wrapper.find('[data-insights-partial]').exists()).toBe(false);
  });

  it('without sessions nothing is drawn and no peak is named; the card leads back to 집중 (negative)', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.find('[data-insights-empty="weeks"]').exists()).toBe(true));
    const empty = wrapper.get('[data-insights-empty="weeks"]');
    expect(empty.text()).toContain('아직 기록이 부족해요');
    expect(empty.text()).toContain('최근 8주 동안 집중 기록이 없어요.');
    // No record yet leads back a stage: to 집중, where records are made (FLOW §5).
    expect(empty.get('a').attributes('href')).toBe('/focus');
    expect(empty.get('a').text()).toBe('집중하러 가기');
    expect(wrapper.get('[data-insights-empty="weekday"]').text()).toBe('기록이 생기면 어느 요일에 잘 집중하는지 보여 드려요.');
    expect(wrapper.get('[data-insights-empty="hours"]').text()).toBe('기록이 생기면 하루 중 언제 잘 집중하는지 보여 드려요.');
    expect(wrapper.find('[data-insights-peak]').exists()).toBe(false);
    expect(wrapper.find('[data-insight="weeks"] [data-chart]').exists()).toBe(false);
    expect(wrapper.find('[data-insight="weekday"] [data-chart]').exists()).toBe(false);
    expect(wrapper.find('[data-insight="hours"] [data-chart]').exists()).toBe(false);
  });

  it('a failed session read says so on its card and can be retried; the rest of the page stays (negative)', async () => {
    seedOverviewSessions(mockDb);
    let failing = true;
    server.use(
      http.get(/\/api\/v1\/sessions$/, () =>
        failing ? HttpResponse.json({ title: 'x', status: 400, code: 'validation_failed' }, { status: 400 }) : undefined,
      ),
    );
    const mounted = await mountInsights();
    const { wrapper } = mounted;
    await vi.waitFor(() => expect(wrapper.find('[data-insights-error="sessions"]').exists()).toBe(true));
    expect(wrapper.get('[data-insights-error="sessions"]').text()).toContain('이 부분을 불러오지 못했어요.');
    expect(wrapper.find('[data-insight="weeks"] [data-chart]').exists()).toBe(false);
    // What reviews taught is another read: it is there.
    expect(wrapper.get('[data-estimate-ratio]').text()).toBe('1.31배');

    failing = false;
    await buttonWith(wrapper.get('[data-insights-error="sessions"]'), '다시 시도').trigger('click');
    await vi.waitFor(() => expect(wrapper.find('[data-insight="weeks"] [data-chart="bars"]').exists()).toBe(true));
    expect(chartRows(mounted, 'weeks')[7]).toEqual(['11월 9일 주', '6시간 38분']);
  });
});

describe('AI 분석 — 지킨 계획 (confirmed blocks whose time has come)', () => {
  it('counts done, moved, skipped and passed blocks of the last four weeks; a replaced block is not one of them', async () => {
    mockDb.extraScheduleBlocks = [
      ...mockDb.extraScheduleBlocks,
      pastBlock(1, 'done'),
      pastBlock(2, 'done'),
      pastBlock(3, 'done'),
      pastBlock(4, 'moved'),
      pastBlock(5, 'skipped'),
      pastBlock(6, 'planned'),
      pastBlock(7, 'superseded'),
      // Older than four weeks: outside what is counted.
      pastBlock(8, 'done', '2026-10-01'),
    ];
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.find('[data-insight="kept"] [data-chart="ring"]').exists()).toBe(true));
    const kept = wrapper.get('[data-insight="kept"]');
    expect(kept.get('.ring-total-value').text()).toBe('50%');
    expect(kept.get('.ring-total-label').text()).toBe('끝낸 블록');
    const legend = kept.get('[data-chart-legend]');
    expect(legend.attributes('aria-label')).toBe('지나간 블록 내역');
    expect(
      legend
        .findAll('.legend-row')
        .map((row) => [row.get('.legend-label').text(), row.get('.legend-value').text().replace(/\s+/g, ' ')]),
    ).toEqual([
      ['끝냄', '3개 · 50%'],
      ['옮김', '1개 · 17%'],
      ['건너뜀', '1개 · 17%'],
      ['기록 없이 지나감', '1개 · 17%'],
    ]);
    expect(kept.text()).toContain('최근 28일');
  });

  it('with no block whose time has come it draws no ring and leads back to 계획 세우기 (negative)', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.find('[data-insights-empty="kept"]').exists()).toBe(true));
    const empty = wrapper.get('[data-insights-empty="kept"]');
    expect(empty.text()).toContain('아직 지나간 계획이 없어요.');
    expect(empty.get('a').text()).toBe('계획 세우기');
    expect(empty.get('a').attributes('href')).toBe('/plan');
    expect(wrapper.find('[data-insight="kept"] [data-chart]').exists()).toBe(false);
  });
});

describe('AI 분석 — 기록: take one out, put it back, reset', () => {
  it('lists every review record with its minutes, ratio and whether it counts', async () => {
    const mounted = await mountInsights();
    await vi.waitFor(() => expect(mounted.wrapper.findAll('.insights-record').length).toBe(6));
    const first = itemRow(mounted, FEEDBACK_IDS.one);
    await vi.waitFor(() => expect(first.text()).toContain(TODAY_TASK_ONE_TITLE));
    expect(first.text()).toContain('예상 1시간 → 실제 1시간 25분');
    expect(first.text()).toContain('1.42배');
    expect(first.get('[data-quality]').text()).toBe('반영 중');
    expect(itemRow(mounted, FEEDBACK_IDS.outlier).get('[data-quality]').text()).toBe('평소와 달라 자동으로 빠짐');
    expect(itemRow(mounted, FEEDBACK_IDS.excluded).get('[data-quality]').text()).toBe('직접 뺌');
    expect((itemRow(mounted, FEEDBACK_IDS.excluded).get('[data-include]').element as HTMLInputElement).checked).toBe(false);
    // Unknown (finished) tasks get a neutral label, never an id.
    expect(itemRow(mounted, FEEDBACK_IDS.three).text()).toContain('지난 작업 · 준비 단계');
    const toggle = first.get('[data-include]');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-label')).toBe(`${TODAY_TASK_ONE_TITLE} · 11월 13일 (금) 기록을 통계에 포함`);
  });

  it('excludes and re-includes a record with If-Match + Idempotency-Key, and the charts follow', async () => {
    const mounted = await mountInsights();
    await vi.waitFor(() => expect(mounted.wrapper.text()).toContain('템플릿 · 보고서 작성'));
    const patch = vi.spyOn(plannerClient, 'patchEstimationFeedback');
    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');

    await vi.waitFor(() => expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-quality]').text()).toBe('직접 뺌'));
    expect(patch).toHaveBeenCalledWith(FEEDBACK_IDS.one, true, expect.any(String), 1, expect.any(AbortSignal));
    expect(isUuidV7Key(String(patch.mock.calls[0]?.[2]))).toBe(true);
    expect(mounted.wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`).text()).toContain('기록 2개');
    expect(mounted.wrapper.get('[data-summary="samples"]').text()).toBe('3개');
    // The record is no longer a point of the trend, and the one number is counted without it.
    expect(mounted.wrapper.get('[data-estimate-trend] [data-chart="trend"]').attributes('data-points')).toBe('3');
    expect(mounted.wrapper.get('[data-estimate-ratio]').text()).toBe('1.26배');
    await waitForText(mounted.wrapper, '기록을 통계에서 뺐어요.');
    expect(mounted.wrapper.get('.status-region').attributes('aria-live')).toBe('polite');

    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');
    await vi.waitFor(() => expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-quality]').text()).toBe('반영 중'));
    expect(patch).toHaveBeenLastCalledWith(FEEDBACK_IDS.one, false, expect.any(String), 2, expect.any(AbortSignal));
    await waitForText(mounted.wrapper, '기록을 다시 통계에 넣었어요.');
    expect(mounted.wrapper.get('[data-estimate-ratio]').text()).toBe('1.31배');
  });

  it('refreshes and explains a 412 when the record changed elsewhere (negative)', async () => {
    const mounted = await mountInsights();
    await vi.waitFor(() => expect(mounted.wrapper.findAll('.insights-record').length).toBe(6));
    mockDb.estimation = {
      ...mockDb.estimation,
      items: mockDb.estimation.items.map((item) =>
        item.feedbackId === FEEDBACK_IDS.two ? { ...item, version: 5 } : item,
      ),
    };
    const reads = vi.spyOn(plannerClient, 'getEstimationProfile');
    await itemRow(mounted, FEEDBACK_IDS.two).get('[data-include]').trigger('change');
    await waitForText(mounted.wrapper, '다른 곳에서 이 기록이 바뀌어서 새로 불러왔어요.');
    expect(reads).toHaveBeenCalled();
    expect(mockDb.estimation.items.find((item) => item.feedbackId === FEEDBACK_IDS.two)?.excluded).toBe(false);
    expect(itemRow(mounted, FEEDBACK_IDS.two).get('[data-quality]').text()).toBe('반영 중');
  });

  it('asks for a clear confirmation before resetting everything, and cancel sends nothing (negative)', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.findAll('.insights-record').length).toBe(6));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await wrapper.get('[data-reset-all]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('.insights-reset-dialog')).not.toBeNull());
    const dialog = document.querySelector('.insights-reset-dialog') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('모든 학습 기록을 지울까요?');
    expect(dialog.textContent).toContain('기록 6개가 지워지고');
    expect(dialog.textContent).toContain('지운 기록은 되돌릴 수 없어요.');
    // Focus starts on the safe choice.
    expect(document.activeElement?.textContent?.trim()).toBe('취소');
    (Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('취소')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.insights-reset-dialog')).toBeNull());
    expect(reset).not.toHaveBeenCalled();
    expect(mockDb.estimation.items).toHaveLength(6);
  });

  it('resets everything after confirming and falls back to the cold start', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.findAll('.insights-record').length).toBe(6));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await wrapper.get('[data-reset-all]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-reset-confirm]')).not.toBeNull());
    (document.querySelector('[data-reset-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(wrapper.find('[data-cold-start]').exists()).toBe(true));
    expect(reset).toHaveBeenCalledWith({ scope: 'all' }, expect.any(String), expect.any(AbortSignal));
    expect(mockDb.estimation.items).toHaveLength(0);
    await waitForText(wrapper, '학습 기록을 지웠어요. 예상은 기본값으로 돌아갔어요.');
    expect(bodyText()).not.toContain('모든 학습 기록을 지울까요?');
    // Focus lands on the card that changed most.
    expect(document.activeElement?.id).toBe('insights-estimate-title');
    expect(wrapper.find('[data-estimate-ratio]').exists()).toBe(false);
  });

  it('resets one template with scope=template and keeps the other records', async () => {
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.text()).toContain('템플릿 · 보고서 작성'));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await buttonWith(wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`), '이 템플릿 기록 지우기').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('.insights-reset-dialog')).not.toBeNull());
    expect(document.querySelector('.insights-reset-dialog')?.textContent).toContain('“보고서 작성” 기록을 지울까요?');
    expect(document.querySelector('.insights-reset-dialog')?.textContent).toContain('이 템플릿의 기록 4개가 지워지고');
    (document.querySelector('[data-reset-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(reset).toHaveBeenCalled());
    expect(reset).toHaveBeenCalledWith(
      { scope: 'template', templateId: REPORT_TEMPLATE_ID },
      expect.any(String),
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(wrapper.findAll('.insights-record')).toHaveLength(2));
    expect(wrapper.find(`[data-group="template:${REPORT_TEMPLATE_ID}"]`).exists()).toBe(false);
  });

  it('never renders note text even if the API sent one (negative)', async () => {
    server.use(
      http.get(/\/api\/v1\/estimation\/profile$/, () =>
        HttpResponse.json({
          ...mockDb.estimation,
          items: mockDb.estimation.items.map((item) => ({ ...item, note: '비밀 회고 메모' })),
        }),
      ),
    );
    const { wrapper } = await mountInsights();
    await vi.waitFor(() => expect(wrapper.findAll('.insights-record').length).toBe(6));
    expect(wrapper.text()).not.toContain('비밀 회고 메모');
    expect(wrapper.html()).not.toContain('비밀 회고 메모');
  });

  it('is read-only offline (negative)', async () => {
    const mounted = await mountInsights();
    await vi.waitFor(() => expect(mounted.wrapper.findAll('.insights-record').length).toBe(6));
    useOfflineStore(mounted.pinia).setOnline(false);
    await flushPromises();
    expect(mounted.wrapper.text()).toContain('오프라인 · 읽기 전용이에요.');
    expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').attributes('disabled')).toBeDefined();
    expect(mounted.wrapper.get('[data-reset-all]').attributes('disabled')).toBeDefined();
    const patch = vi.spyOn(plannerClient, 'patchEstimationFeedback');
    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');
    expect(patch).not.toHaveBeenCalled();
  });
});
