import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BarWeekChart from '../src/components/charts/BarWeekChart.vue';
import RingChart from '../src/components/charts/RingChart.vue';
import RatioBar from '../src/components/charts/RatioBar.vue';
import TrendChart from '../src/components/charts/TrendChart.vue';
import {
  ratioSpan,
  areaPath,
  barGeometry,
  linePath,
  referenceY,
  ringArcs,
  ringStrokes,
  slotCenter,
  trendPoints,
} from '../src/components/charts/geometry';

/**
 * HOLO-01 charts: plain numbers in, hand-written SVG out, with a text
 * alternative. Zero, one and missing values never become invented marks.
 */
describe('bar geometry', () => {
  it('scales every bar to the tallest value of the set', () => {
    const bars = barGeometry([30, 60, 120], 120, 8);
    expect(bars.map((bar) => bar.height)).toEqual([30, 60, 120]);
    expect(bars.map((bar) => bar.y)).toEqual([90, 60, 0]);
    expect(bars.every((bar) => !bar.missing)).toBe(true);
  });

  it('keeps a small value visible, and draws nothing for zero or missing data (negative)', () => {
    const bars = barGeometry([1, 0, null, undefined, Number.NaN, 200], 100, 8);
    expect(bars[0]).toEqual({ height: 8, y: 92, missing: false });
    expect(bars[1]).toEqual({ height: 0, y: 100, missing: false });
    expect(bars.slice(2, 5).map((bar) => bar.missing)).toEqual([true, true, true]);
    expect(bars.slice(2, 5).every((bar) => bar.height === 0)).toBe(true);
    expect(bars[5]?.height).toBe(100);
    // Nothing at all: no bar is drawn, and no division by zero.
    expect(barGeometry([0, 0, 0], 100).every((bar) => bar.height === 0 && !bar.missing)).toBe(true);
    expect(barGeometry([], 100)).toEqual([]);
  });

  it('centres each slot', () => {
    expect([0, 1, 6].map((index) => slotCenter(index, 7))).toEqual([(0.5 / 7) * 100, (1.5 / 7) * 100, (6.5 / 7) * 100]);
    expect(slotCenter(0, 0)).toBe(50);
  });
});

describe('ring geometry', () => {
  it('shares the circle between the parts, clockwise, with a gap between neighbours', () => {
    const arcs = ringArcs([130, 70, 100], 10);
    expect(arcs.map((arc) => arc.index)).toEqual([0, 1, 2]);
    expect(arcs.reduce((sum, arc) => sum + arc.sweep, 0)).toBeCloseTo(360 - 30, 8);
    expect(arcs[0]?.start).toBeCloseTo(5, 8);
    expect(arcs[0]?.sweep).toBeCloseTo((130 / 300) * 330, 8);
    expect(arcs[1]?.start).toBeCloseTo(5 + (130 / 300) * 330 + 10, 8);
  });

  it('closes the ring for one part and draws nothing for none (zero / missing, negative)', () => {
    expect(ringArcs([0, 45, 0])).toEqual([{ index: 1, start: 0, sweep: 360 }]);
    expect(ringArcs([0, 0, 0])).toEqual([]);
    expect(ringArcs([null, undefined, Number.NaN, -3])).toEqual([]);
    expect(ringArcs([])).toEqual([]);
  });

  it('turns arcs into round-capped dashes that stay inside their arc', () => {
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    const [full] = ringStrokes([{ index: 0, start: 0, sweep: 360 }], radius, 12);
    expect(full).toEqual({ index: 0, dash: circumference, rest: 0, rotate: -90 });
    const [quarter] = ringStrokes([{ index: 2, start: 90, sweep: 90 }], radius, 12);
    // A quarter of the circle minus the two round caps.
    expect(quarter?.dash).toBeCloseTo(circumference / 4 - 12, 8);
    expect(quarter?.dash ?? 0).toBeGreaterThan(0);
    expect((quarter?.dash ?? 0) + (quarter?.rest ?? 0)).toBeCloseTo(circumference, 8);
    expect(quarter?.rotate).toBeCloseTo(90 - 90 + 6 / (circumference / 360), 8);
    // A sliver shorter than the stroke is still a dot, never a negative dash.
    const [sliver] = ringStrokes([{ index: 0, start: 0, sweep: 2 }], radius, 12);
    expect(sliver?.dash).toBeCloseTo(0.01, 8);
  });
});

describe('trend geometry', () => {
  it('spreads the values left to right over the box, highest at the top', () => {
    const points = trendPoints([1, 3, 2], 200, 60, { pad: 5 });
    expect(points.map((point) => point.x)).toEqual([0, 100, 200]);
    expect(points.map((point) => point.y)).toEqual([55, 5, 30]);
    expect(linePath(points)).toBe('M0 55 L100 5 L200 30');
    expect(areaPath(points, 60)).toBe('M0 55 L100 5 L200 30 L200 60 L0 60 Z');
  });

  it('handles none, one, equal and missing values (negative)', () => {
    expect(trendPoints([], 200, 60)).toEqual([]);
    expect(trendPoints([null, undefined, Number.NaN], 200, 60)).toEqual([]);
    expect(trendPoints([1.2], 200, 60)).toEqual([{ x: 100, y: 30 }]);
    expect(trendPoints([2, 2, 2], 200, 60).map((point) => point.y)).toEqual([30, 30, 30]);
    // A missing value is dropped, not drawn as zero.
    expect(trendPoints([1, null, 3], 200, 60, { pad: 0 })).toEqual([
      { x: 0, y: 60 },
      { x: 200, y: 0 },
    ]);
    expect(areaPath([{ x: 100, y: 30 }], 60)).toBe('');
    expect(linePath([])).toBe('');
  });

  it('puts a reference value on the same scale as the line', () => {
    // 1 ("as estimated") is below every value: it becomes the floor of the scale.
    expect(trendPoints([1.2, 1.4], 200, 60, { pad: 0, reference: 1 }).map((point) => point.y)).toEqual([30, 0]);
    expect(referenceY([1.2, 1.4], 1, 60, 0)).toBe(60);
    expect(referenceY([], 1, 60)).toBeNull();
    expect(referenceY([1, 1], 1, 60)).toBe(30);
  });
});

const WEEK_SLOTS = ['월', '화', '수', '목', '금', '토', '일'].map((label, index) => ({
  label,
  name: `11월 ${9 + index}일 (${label})`,
}));

function mountBars(values: (number | null)[], extra: Record<string, unknown> = {}) {
  return mount(BarWeekChart, {
    props: {
      title: '이번 주 요일별 집중 시간',
      slots: WEEK_SLOTS,
      values,
      format: (value: number) => `${value}분`,
      slotHeader: '날짜',
      valueHeader: '집중 시간',
      missingText: '아직 오지 않은 날',
      ...extra,
    },
  });
}

describe('BarWeekChart', () => {
  it('draws one column per day, highlights today and says its value and comparison', () => {
    const wrapper = mountBars([52, 78, 22, 85, 58, 103, null], {
      highlight: 5,
      callout: { value: '1시간 43분', note: '11월 14일 (토)' },
      chip: '계획보다 −27분',
    });
    expect(wrapper.findAll('[data-bar]')).toHaveLength(7);
    expect(wrapper.findAll('.bar-set-bar')).toHaveLength(6);
    expect(wrapper.get('[data-bar="5"]').classes()).toContain('bar-set-col--highlight');
    expect(wrapper.findAll('.bar-set-col--highlight')).toHaveLength(1);
    expect(wrapper.get('[data-bar="6"]').classes()).toContain('bar-set-col--missing');
    expect(wrapper.get('[data-callout]').text()).toContain('1시간 43분');
    expect(wrapper.get('[data-chip]').text()).toBe('계획보다 −27분');
    // The tallest value fills the plot; the others keep their proportion.
    const heights = wrapper.findAll('.bar-set-bar').map((bar) => Number(bar.attributes('height')));
    expect(Math.max(...heights)).toBe(heights[5]);
    expect(heights[0]! / heights[5]!).toBeCloseTo(52 / 103, 5);
  });

  it('gives the same numbers as a table and hides the picture from assistive tech', () => {
    const wrapper = mountBars([52, 0, null, 85, 58, 103, null], { highlight: 5, chip: '계획한 만큼' });
    expect(wrapper.get('.bar-set-plot').attributes('aria-hidden')).toBe('true');
    const table = wrapper.get('[data-chart-table]');
    expect(table.get('caption').text()).toBe('이번 주 요일별 집중 시간');
    expect(table.findAll('thead th').map((cell) => cell.text())).toEqual(['날짜', '집중 시간']);
    const rows = table.findAll('tbody tr').map((row) => [row.get('th').text(), row.get('td').text()]);
    expect(rows[0]).toEqual(['11월 9일 (월)', '52분']);
    expect(rows[1]).toEqual(['11월 10일 (화)', '0분']);
    expect(rows[2]).toEqual(['11월 11일 (수)', '아직 오지 않은 날']);
    expect(rows[5]).toEqual(['11월 14일 (토)', '103분 (계획한 만큼)']);
  });

  it('draws no bar and no callout without data or a highlight (negative)', () => {
    const empty = mountBars([0, 0, 0, 0, 0, 0, 0]);
    expect(empty.findAll('.bar-set-bar')).toHaveLength(0);
    expect(empty.find('[data-callout]').exists()).toBe(false);
    // A highlight outside the set is ignored instead of pointing at nothing.
    const outside = mountBars([10, 20, 30, 40, 50, 60, 70], { highlight: 9, callout: { value: 'x' } });
    expect(outside.find('[data-callout]').exists()).toBe(false);
    expect(outside.findAll('.bar-set-col--highlight')).toHaveLength(0);
  });
});

function segment(label: string, value: number, series: 1 | 2 | 3 | 4) {
  return { label, value, display: `${value}분`, series };
}

describe('RingChart', () => {
  const formatShare = (share: number): string => `${Math.round(share * 100)}%`;

  it('draws an arc per part in its series colour and lists each part with its share', () => {
    const wrapper = mount(RingChart, {
      props: {
        title: '오늘 시간의 종류',
        segments: [segment('집중 블록', 130, 1), segment('약속', 70, 2), segment('끝낸 집중', 100, 3)],
        total: '5시간',
        totalLabel: '오늘',
        formatShare,
      },
    });
    const arcs = wrapper.findAll('.ring-arc');
    expect(arcs).toHaveLength(3);
    expect(arcs.map((arc) => arc.classes().find((name) => name.startsWith('ring-arc--')))).toEqual([
      'ring-arc--1',
      'ring-arc--2',
      'ring-arc--3',
    ]);
    expect(wrapper.get('.ring-svg').attributes('aria-hidden')).toBe('true');
    const legend = wrapper.get('[data-chart-legend]');
    expect(legend.attributes('aria-label')).toBe('오늘 시간의 종류');
    expect(
      legend.findAll('.legend-row').map((row) => [row.get('.legend-label').text(), row.get('.legend-value').text()]),
    ).toEqual([
      ['집중 블록', '130분 · 43%'],
      ['약속', '70분 · 23%'],
      ['끝낸 집중', '100분 · 33%'],
    ]);
    expect(wrapper.get('.ring-total').text()).toContain('5시간');
  });

  it('shows only the track when nothing has time, and at most four parts (negative)', () => {
    const empty = mount(RingChart, { props: { title: '빈 날', segments: [], formatShare } });
    expect(empty.findAll('.ring-arc')).toHaveLength(0);
    expect(empty.find('.ring-track').exists()).toBe(true);
    expect(empty.find('.ring-total').exists()).toBe(false);

    const zero = mount(RingChart, {
      props: { title: '빈 날', segments: [segment('약속', 0, 2)], formatShare },
    });
    expect(zero.findAll('.ring-arc')).toHaveLength(0);
    expect(zero.get('.legend-row').text()).toContain('0%');

    const many = mount(RingChart, {
      props: {
        title: '많은 날',
        segments: [1, 2, 3, 4, 1].map((value, index) => segment(`종류 ${index}`, value, ((index % 4) + 1) as 1 | 2 | 3 | 4)),
        formatShare,
      },
    });
    expect(many.findAll('.ring-arc')).toHaveLength(4);
    expect(many.findAll('.legend-row')).toHaveLength(4);
  });

  it('closes the ring for a single part', () => {
    const one = mount(RingChart, {
      props: { title: '약속만', segments: [segment('약속', 45, 2)], formatShare },
    });
    const arc = one.get('.ring-arc');
    expect(arc.attributes('stroke-dasharray')?.endsWith(' 0')).toBe(true);
    expect(one.get('.legend-row').text()).toContain('100%');
  });
});

describe('TrendChart', () => {
  it('draws a line, its area and the newest point, named by the summary', () => {
    const wrapper = mount(TrendChart, { props: { values: [1.2, 1.1, 1.4, 1.3], summary: '최근 기록 4건의 비율', reference: 1 } });
    const svg = wrapper.get('svg');
    expect(svg.attributes('role')).toBe('img');
    expect(svg.attributes('aria-label')).toBe('최근 기록 4건의 비율');
    expect(wrapper.get('.trend-line').attributes('d')).toMatch(/^M0 /);
    expect(wrapper.find('.trend-area').exists()).toBe(true);
    expect(wrapper.find('.trend-guide').exists()).toBe(true);
    expect(wrapper.get('.trend-dot').attributes('style')).toContain('left: 100%');
    expect(wrapper.get('[data-chart="trend"]').attributes('data-points')).toBe('4');
  });

  it('draws a single point for one value and nothing for none (negative)', () => {
    const one = mount(TrendChart, { props: { values: [1.2], summary: '기록 1건' } });
    expect(one.find('.trend-line').exists()).toBe(false);
    expect(one.find('.trend-area').exists()).toBe(false);
    expect(one.find('.trend-dot').exists()).toBe(true);
    expect(one.find('.trend-guide').exists()).toBe(false);

    const none = mount(TrendChart, { props: { values: [null, Number.NaN], summary: '기록 없음', reference: 1 } });
    expect(none.find('.trend-line').exists()).toBe(false);
    expect(none.find('.trend-dot').exists()).toBe(false);
    expect(none.find('.trend-guide').exists()).toBe(false);
    expect(none.get('svg').attributes('aria-label')).toBe('기록 없음');
  });
});

// HOLO-03A (AI 분석): a ratio against "as estimated".
describe('ratio geometry', () => {
  it('grows from the mark at 1 toward the ratio: to the right above 1, to the left below', () => {
    // Scale 0..2: the mark stands in the middle.
    expect(ratioSpan(1.5, 2)).toEqual({ tick: 50, left: 50, width: 25 });
    expect(ratioSpan(0.5, 2)).toEqual({ tick: 50, left: 25, width: 25 });
    expect(ratioSpan(1, 2)).toEqual({ tick: 50, left: 50, width: 0 });
    // Another scale moves the mark, never the meaning.
    expect(ratioSpan(3, 4)).toEqual({ tick: 25, left: 25, width: 50 });
  });

  it('stops at the edge of the scale, and draws nothing for no ratio (negative)', () => {
    expect(ratioSpan(9, 2)).toEqual({ tick: 50, left: 50, width: 50 });
    expect(ratioSpan(-1, 2)).toEqual({ tick: 50, left: 0, width: 50 });
    expect(ratioSpan(null, 2)).toBeNull();
    expect(ratioSpan(undefined, 2)).toBeNull();
    expect(ratioSpan(Number.NaN, 2)).toBeNull();
    // A scale that could not hold the mark falls back to 0..2.
    expect(ratioSpan(1.5, 0.5)).toEqual({ tick: 50, left: 50, width: 25 });
    expect(ratioSpan(1.5, Number.NaN)).toEqual({ tick: 50, left: 50, width: 25 });
  });
});

describe('RatioBar', () => {
  it('is a picture of a number written beside it: hidden from assistive technology, with the side as data', () => {
    const over = mount(RatioBar, { props: { ratio: 1.5, max: 2 } });
    expect(over.attributes('aria-hidden')).toBe('true');
    expect(over.attributes('data-chart')).toBe('ratio');
    expect(over.attributes('data-side')).toBe('over');
    expect(over.get('.ratio-bar-fill').attributes('style')).toContain('left: 50%');
    expect(over.get('.ratio-bar-fill').attributes('style')).toContain('width: 25%');
    expect(over.get('.ratio-bar-tick').attributes('style')).toContain('left: 50%');

    const under = mount(RatioBar, { props: { ratio: 0.8 } });
    expect(under.attributes('data-side')).toBe('under');
    expect(under.get('.ratio-bar-fill').attributes('style')).toContain('left: 40%');
  });

  it('draws only the mark at exactly 1, and nothing at all without a ratio (negative)', () => {
    const even = mount(RatioBar, { props: { ratio: 1 } });
    expect(even.find('.ratio-bar-fill').exists()).toBe(false);
    expect(even.find('.ratio-bar-tick').exists()).toBe(true);

    const none = mount(RatioBar, { props: { ratio: null } });
    expect(none.attributes('data-side')).toBe('none');
    expect(none.find('.ratio-bar-fill').exists()).toBe(false);
    expect(none.find('.ratio-bar-tick').exists()).toBe(false);
  });
});
