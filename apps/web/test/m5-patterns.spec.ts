import { flushPromises } from '@vue/test-utils';
import { HttpResponse, http } from 'msw';
import { isUuidV7Key, plannerClient } from '../src/api';
import { REPORT_TEMPLATE_ID, TODAY_TASK_ONE_TITLE, mockDb } from '../src/mocks/db';
import { seedColdEstimation } from '../src/mocks/replan';
import { FEEDBACK_IDS } from '../src/mocks/replan-seed';
import { server } from '../src/mocks/server';
import { useOfflineStore } from '../src/stores/offline';
import PatternsView from '../src/views/PatternsView.vue';
import { bodyText, buttonWith, mountView, waitForText, type Mounted } from './m5-test-utils';

async function mountPatterns(): Promise<Mounted> {
  const mounted = await mountView(PatternsView, { path: '/patterns' });
  await waitForText(mounted.wrapper, '한눈에 보기');
  return mounted;
}

function itemRow(mounted: Mounted, feedbackId: string) {
  return mounted.wrapper.get(`[data-feedback-id="${feedbackId}"]`);
}

describe('내 패턴 (M5-03 estimation profile)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows per task-type prior vs personal ratios with sample count and confidence', async () => {
    const mounted = await mountPatterns();
    const { wrapper } = mounted;
    await vi.waitFor(() => expect(wrapper.text()).toContain('템플릿 · 보고서 작성'));
    expect(wrapper.get('[data-summary="samples"]').text()).toBe('4개');
    expect(wrapper.get('[data-summary="confidence"]').text()).toBe('보통 (44%)');

    const template = wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`);
    expect(template.text()).toContain('기록 3개');
    expect(template.text()).toContain('보통 (38%)');
    expect(template.text()).toContain('기본 추정');
    expect(template.text()).toContain('1배');
    // Raw personal mean vs the applied correction shrunk toward the prior with k = 5.
    const personal = template.get('[data-ratio="personal"]').text();
    const applied = template.get('[data-ratio="applied"]').text();
    expect(personal).toMatch(/^1\.\d{1,2}배$/);
    expect(applied).toMatch(/^1\.\d{1,2}배$/);
    expect(Number.parseFloat(applied)).toBeLessThan(Number.parseFloat(personal));
    expect(template.text()).toContain('템플릿 기본값 쪽으로 기록 5개만큼 당겨요.');

    expect(wrapper.get('[data-group="kind:review"]').text()).toContain('단계 종류 · 검토');
    expect(wrapper.text()).toContain('평소와 너무 다른 기록(|z| > 2.5)은 이상치로 보고 자동으로 빼요.');
    expect(wrapper.find('[data-cold-start]').exists()).toBe(false);

    const first = itemRow(mounted, FEEDBACK_IDS.one);
    expect(first.text()).toContain(TODAY_TASK_ONE_TITLE);
    expect(first.text()).toContain('예상 1시간 → 실제 1시간 25분');
    expect(first.text()).toContain('1.42배');
    expect(first.get('[data-quality]').text()).toBe('반영 중');
    expect(itemRow(mounted, FEEDBACK_IDS.outlier).get('[data-quality]').text()).toBe('이상치라 자동으로 빠짐');
    expect(itemRow(mounted, FEEDBACK_IDS.excluded).get('[data-quality]').text()).toBe('직접 뺌');
    expect((itemRow(mounted, FEEDBACK_IDS.excluded).get('[data-include]').element as HTMLInputElement).checked).toBe(false);
    // Unknown (finished) tasks get a neutral label, never an id.
    expect(itemRow(mounted, FEEDBACK_IDS.three).text()).toContain('지난 작업 · 준비 단계');
    expect(wrapper.text()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(wrapper.text()).not.toMatch(/shrinkage|estimator@|prior\b/);
    wrapper.unmount();
  });

  it('explains the cold start (template, else AI ×1.3, low confidence)', async () => {
    seedColdEstimation(mockDb);
    const { wrapper } = await mountPatterns();
    await vi.waitFor(() => expect(wrapper.find('[data-cold-start]').exists()).toBe(true));
    const cold = wrapper.get('[data-cold-start]');
    expect(cold.text()).toContain('아직 배운 내 패턴이 없어요');
    expect(cold.text()).toContain('템플릿이 없으면 AI 추정에 1.3배 여유를 더해요');
    expect(cold.text()).toContain('신뢰도는 낮음(30% 이하)');
    expect(wrapper.get('[data-summary="confidence"]').text()).toBe('낮음 (0%)');
    expect(wrapper.text()).toContain('아직 유형별로 모인 기록이 없어요.');
    expect(wrapper.get('[data-reset-all]').attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });

  it('excludes and re-includes a feedback item with If-Match + Idempotency-Key and updates the stats', async () => {
    const mounted = await mountPatterns();
    await vi.waitFor(() => expect(mounted.wrapper.text()).toContain('템플릿 · 보고서 작성'));
    const patch = vi.spyOn(plannerClient, 'patchEstimationFeedback');
    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');

    await vi.waitFor(() => expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-quality]').text()).toBe('직접 뺌'));
    expect(patch).toHaveBeenCalledWith(FEEDBACK_IDS.one, true, expect.any(String), 1, expect.any(AbortSignal));
    expect(isUuidV7Key(String(patch.mock.calls[0]?.[2]))).toBe(true);
    expect(mounted.wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`).text()).toContain('기록 2개');
    expect(mounted.wrapper.get('[data-summary="samples"]').text()).toBe('3개');
    await waitForText(mounted.wrapper, '기록을 통계에서 뺐어요.');
    expect(mounted.wrapper.get('.status-region').attributes('aria-live')).toBe('polite');

    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');
    await vi.waitFor(() => expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-quality]').text()).toBe('반영 중'));
    expect(patch).toHaveBeenLastCalledWith(FEEDBACK_IDS.one, false, expect.any(String), 2, expect.any(AbortSignal));
    await waitForText(mounted.wrapper, '기록을 다시 통계에 넣었어요.');
    mounted.wrapper.unmount();
  });

  it('refreshes and explains a 412 when the item changed elsewhere (negative)', async () => {
    const mounted = await mountPatterns();
    await vi.waitFor(() => expect(mounted.wrapper.findAll('.patterns-item').length).toBe(6));
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
    mounted.wrapper.unmount();
  });

  it('asks for a clear confirmation before resetting everything, and cancel sends nothing (negative)', async () => {
    const { wrapper } = await mountPatterns();
    await vi.waitFor(() => expect(wrapper.findAll('.patterns-item').length).toBe(6));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await wrapper.get('[data-reset-all]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('.patterns-reset-dialog')).not.toBeNull());
    const dialog = document.querySelector('.patterns-reset-dialog') as HTMLElement;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.textContent).toContain('모든 학습 기록을 지울까요?');
    expect(dialog.textContent).toContain('기록 6개가 지워지고');
    expect(dialog.textContent).toContain('지운 기록은 되돌릴 수 없어요.');
    // Focus starts on the safe choice.
    expect(document.activeElement?.textContent?.trim()).toBe('취소');
    (Array.from(dialog.querySelectorAll('button')).find((button) => button.textContent?.includes('취소')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector('.patterns-reset-dialog')).toBeNull());
    expect(reset).not.toHaveBeenCalled();
    expect(mockDb.estimation.items).toHaveLength(6);
    wrapper.unmount();
  });

  it('resets everything after confirming and falls back to the cold start', async () => {
    const { wrapper } = await mountPatterns();
    await vi.waitFor(() => expect(wrapper.findAll('.patterns-item').length).toBe(6));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await wrapper.get('[data-reset-all]').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('[data-reset-confirm]')).not.toBeNull());
    (document.querySelector('[data-reset-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(wrapper.find('[data-cold-start]').exists()).toBe(true));
    expect(reset).toHaveBeenCalledWith({ scope: 'all' }, expect.any(String), expect.any(AbortSignal));
    expect(mockDb.estimation.items).toHaveLength(0);
    await waitForText(wrapper, '학습 기록을 지웠어요. 추정은 기본값으로 돌아갔어요.');
    expect(bodyText()).not.toContain('모든 학습 기록을 지울까요?');
    wrapper.unmount();
  });

  it('resets one template with scope=template and keeps the other records', async () => {
    const { wrapper } = await mountPatterns();
    await vi.waitFor(() => expect(wrapper.text()).toContain('템플릿 · 보고서 작성'));
    const reset = vi.spyOn(plannerClient, 'resetEstimation');
    await buttonWith(wrapper.get(`[data-group="template:${REPORT_TEMPLATE_ID}"]`), '이 템플릿 기록 지우기').trigger('click');
    await vi.waitFor(() => expect(document.querySelector('.patterns-reset-dialog')).not.toBeNull());
    expect(document.querySelector('.patterns-reset-dialog')?.textContent).toContain('“보고서 작성” 기록을 지울까요?');
    expect(document.querySelector('.patterns-reset-dialog')?.textContent).toContain('이 템플릿의 기록 4개가 지워지고');
    (document.querySelector('[data-reset-confirm]') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(reset).toHaveBeenCalled());
    expect(reset).toHaveBeenCalledWith(
      { scope: 'template', templateId: REPORT_TEMPLATE_ID },
      expect.any(String),
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(wrapper.findAll('.patterns-item')).toHaveLength(2));
    expect(wrapper.find(`[data-group="template:${REPORT_TEMPLATE_ID}"]`).exists()).toBe(false);
    wrapper.unmount();
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
    const { wrapper } = await mountPatterns();
    await vi.waitFor(() => expect(wrapper.findAll('.patterns-item').length).toBe(6));
    expect(wrapper.text()).not.toContain('비밀 회고 메모');
    wrapper.unmount();
  });

  it('is read-only offline (negative)', async () => {
    const mounted = await mountPatterns();
    await vi.waitFor(() => expect(mounted.wrapper.findAll('.patterns-item').length).toBe(6));
    useOfflineStore(mounted.pinia).setOnline(false);
    await flushPromises();
    expect(mounted.wrapper.text()).toContain('오프라인 · 읽기 전용이에요.');
    expect(itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').attributes('disabled')).toBeDefined();
    expect(mounted.wrapper.get('[data-reset-all]').attributes('disabled')).toBeDefined();
    const patch = vi.spyOn(plannerClient, 'patchEstimationFeedback');
    await itemRow(mounted, FEEDBACK_IDS.one).get('[data-include]').trigger('change');
    expect(patch).not.toHaveBeenCalled();
    mounted.wrapper.unmount();
  });
});
