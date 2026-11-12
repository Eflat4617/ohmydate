import { mount } from '@vue/test-utils';
import { createPlannerClient, newActionId, type Availability } from '../src/api';
import WeekCalendar from '../src/components/WeekCalendar.vue';
import { mockDb } from '../src/mocks/db';
import PlanComparisonView from '../src/views/PlanComparisonView.vue';
import { mountWithPlugins, settle, testRouter } from './planning-test-utils';

// 2026-11-09 is a Monday; 11-14 / 11-15 are the rule-less weekend.
const WEEK_START = '2026-11-09';

function availability(exceptions: Availability['exceptions']): Availability {
  return {
    version: 4,
    timeZone: 'Asia/Seoul',
    rules: [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startLocal: '09:00',
      endLocal: '18:00',
      kind: 'work' as const,
    })),
    exceptions,
    prefs: {
      maxDailyFocusMin: 300,
      breakAfterMin: 60,
      breakMin: 15,
      dayStartLocal: '08:00',
      dayEndLocal: '22:00',
      riskLevel: 'p50',
    },
  };
}

function mountCalendar(value: Availability) {
  return mount(WeekCalendar, {
    props: { blocks: [], timeZone: 'Asia/Seoul', weekStart: WEEK_START, availability: value },
  });
}

function day(wrapper: ReturnType<typeof mountCalendar>, date: string) {
  return wrapper.get(`.calendar-day[data-date="${date}"]`);
}

describe('week calendar: 쉼 exceptions are visible', () => {
  it('draws a labelled 쉼 band on a day without any weekly rule', () => {
    const wrapper = mountCalendar(
      availability([{ date: '2026-11-14', kind: 'off', startLocal: '10:00', endLocal: '18:00' }]),
    );
    const saturday = day(wrapper, '2026-11-14');
    expect(saturday.findAll('.calendar-availability')).toHaveLength(0);
    const band = saturday.get('[data-off-band]');
    expect((band.element as HTMLElement).style.top).toBe('600px');
    expect((band.element as HTMLElement).style.height).toBe('480px');
    expect(band.text()).toBe('쉼 10:00~18:00');
    expect(wrapper.get('.calendar-day-head[data-date="2026-11-14"] [data-day-off]').text()).toBe('쉼');
    wrapper.unmount();
  });

  it('covers the whole day when the 쉼 has no times', () => {
    const wrapper = mountCalendar(availability([{ date: '2026-11-15', kind: 'off' }]));
    const band = day(wrapper, '2026-11-15').get('[data-off-band]');
    expect((band.element as HTMLElement).style.top).toBe('0px');
    expect((band.element as HTMLElement).style.height).toBe('1440px');
    expect(band.text()).toBe('쉼 하루 종일');
    wrapper.unmount();
  });

  it('still cuts availability on a rule day and marks the cut', () => {
    const wrapper = mountCalendar(
      availability([{ date: '2026-11-11', kind: 'off', startLocal: '12:00', endLocal: '13:00' }]),
    );
    const wednesday = day(wrapper, '2026-11-11');
    const windows = wednesday
      .findAll('.calendar-availability')
      .map((band) => [(band.element as HTMLElement).style.top, (band.element as HTMLElement).style.height]);
    expect(windows).toEqual([
      ['540px', '180px'],
      ['780px', '300px'],
    ]);
    expect(wednesday.get('[data-off-band]').text()).toBe('쉼 12:00~13:00');
    wrapper.unmount();
  });

  it('draws no 쉼 band without an off exception, and keeps 추가 as availability (negative)', () => {
    const none = mountCalendar(availability([]));
    expect(none.findAll('[data-off-band]')).toHaveLength(0);
    expect(none.findAll('[data-day-off]')).toHaveLength(0);
    none.unmount();

    const extra = mountCalendar(
      availability([
        { date: '2026-11-14', kind: 'extra', startLocal: '10:00', endLocal: '12:00' },
        { date: '2026-11-21', kind: 'off' },
      ]),
    );
    const saturday = day(extra, '2026-11-14');
    expect(saturday.findAll('[data-off-band]')).toHaveLength(0);
    expect(saturday.findAll('.calendar-availability--extra')).toHaveLength(1);
    // An exception outside the shown week draws nothing.
    expect(extra.findAll('[data-off-band]')).toHaveLength(0);
    extra.unmount();
  });

  it('draws nothing when the calendar has no availability (negative)', () => {
    const wrapper = mount(WeekCalendar, {
      props: { blocks: [], timeZone: 'Asia/Seoul', weekStart: WEEK_START },
    });
    expect(wrapper.findAll('[data-off-band]')).toHaveLength(0);
    wrapper.unmount();
  });
});

describe('plan comparison legend', () => {
  it('lists 쉼 next to the other calendar marks', async () => {
    const task = [...mockDb.tasks.values()][0];
    if (task === undefined) throw new Error('seed task missing');
    const plan = await createPlannerClient().createPlan(
      {
        scope: { taskIds: [task.id] },
        horizon: { start: '2026-11-11T00:00:00.000Z', end: '2026-11-25T00:00:00.000Z' },
        policies: ['front_loaded', 'balanced', 'focus_blocked'],
      },
      newActionId('plan-create'),
    );
    const router = testRouter();
    await router.push(`/plans/${plan.id}`);
    await router.isReady();
    const wrapper = mountWithPlugins(PlanComparisonView, { router });
    await settle();
    await vi.waitFor(() => {
      expect(wrapper.find('.calendar-legend').exists()).toBe(true);
    });
    const items = wrapper.findAll('.calendar-legend li').map((item) => item.text());
    expect(items).toContain('쉼 (예외)');
    expect(wrapper.find('.calendar-legend .legend-swatch--off').exists()).toBe(true);
    wrapper.unmount();
  });
});
