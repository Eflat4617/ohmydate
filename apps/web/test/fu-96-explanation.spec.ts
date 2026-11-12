import { mount } from '@vue/test-utils';
import ExplanationList from '../src/components/ExplanationList.vue';
import { explanationItemText, renderExplanation, type ExplanationItem } from '../src/i18n/explanation';

/**
 * FU-96: the two new scheduler codes render as Korean sentences where every
 * other explanation item renders (ExplanationList, "계산 근거").
 */
const TASK = '0193a8f2-6c1e-7b41-9a2e-1f1d6a0b3c55';
const TZ = 'Asia/Seoul';
const NAMES: Readonly<Record<string, string>> = { [TASK]: '자료 조사' };
const context = { timeZone: TZ, taskName: (id: string) => NAMES[id] };

const autoSplit = (params: ExplanationItem['params']): ExplanationItem => ({ code: 'auto_split_long_task', params });
const blocked: ExplanationItem = { code: 'heuristic_blocked_by_predecessor', params: {} };

describe('FU-96 explanation codes in Korean', () => {
  it('explains an auto-split task with its name, reason and session cap', () => {
    expect(explanationItemText(autoSplit({ taskId: TASK, sessionMaxMin: 60, reason: 'break_after' }), context)).toBe(
      '“자료 조사” 작업은 한 번에 하기엔 길어서 쉬는 시간 규칙에 맞게 최대 1시간씩 나눠 배치했어요.',
    );
    expect(explanationItemText(autoSplit({ taskId: TASK, sessionMaxMin: 150, reason: 'daily_cap' }), context)).toBe(
      '“자료 조사” 작업은 한 번에 하기엔 길어서 하루 집중 한도에 맞게 최대 2시간 30분씩 나눠 배치했어요.',
    );
    expect(explanationItemText(autoSplit({ taskId: TASK, sessionMaxMin: 60, reason: 'break_after' }), { timeZone: TZ })).toBe(
      '한 작업은 한 번에 하기엔 길어서 쉬는 시간 규칙에 맞게 최대 1시간씩 나눠 배치했어요.',
    );
  });

  it('names the predecessor as the cause instead of missing available time', () => {
    expect(explanationItemText(blocked, context)).toBe('앞 단계가 배치되지 않아 뒤 단계도 배치하지 못했어요.');
  });

  it('falls back to the English line for an unknown reason or a missing cap (negative)', () => {
    expect(explanationItemText(autoSplit({ taskId: TASK, sessionMaxMin: 60, reason: 'mystery' }), context)).toBeNull();
    expect(explanationItemText(autoSplit({ taskId: TASK, reason: 'break_after' }), context)).toBeNull();
    const lines = ['Non-splittable task "x" is longer than the 60-minute limit before a break; scheduled in sessions of at most 60 min.'];
    const rendered = renderExplanation(lines, [autoSplit({ taskId: TASK, sessionMaxMin: 60, reason: 'mystery' })], context);
    expect(rendered.entries).toEqual([{ text: lines[0], translated: false }]);
  });

  it('renders both items in the plan explanation list without English text', () => {
    const lines = [
      'Non-splittable task "t" is longer than the 60-minute limit before a break; scheduled in sessions of at most 60 min.',
      'Heuristic reason: blocked_by_predecessor.',
    ];
    const wrapper = mount(ExplanationList, {
      props: {
        lines,
        items: [autoSplit({ taskId: TASK, sessionMaxMin: 60, reason: 'break_after' }), blocked],
        timeZone: TZ,
        taskNames: NAMES,
      },
    });
    expect(wrapper.get('details').attributes('data-explanation')).toBe('coded');
    expect(wrapper.findAll('li').map((entry) => entry.text())).toEqual([
      '“자료 조사” 작업은 한 번에 하기엔 길어서 쉬는 시간 규칙에 맞게 최대 1시간씩 나눠 배치했어요.',
      '앞 단계가 배치되지 않아 뒤 단계도 배치하지 못했어요.',
    ]);
    expect(wrapper.find('[lang="en"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Heuristic');
  });
});
