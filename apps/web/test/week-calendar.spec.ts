import { mount } from '@vue/test-utils';
import WeekCalendar from '../src/components/WeekCalendar.vue';

const TASK_ID = '01900000-0000-7000-8000-000000000099';

function topFor(wrapper: ReturnType<typeof mount>, date: string, label: string): string {
  const day = wrapper.get(`.calendar-day[data-date="${date}"]`);
  const block = day
    .findAll('.calendar-block')
    .find((item) => item.attributes('aria-label')?.includes(label));
  if (block === undefined) throw new Error(`block not found on ${date}: ${label}`);
  return (block.element as HTMLElement).style.top;
}

describe('week calendar in a DST fall-back week', () => {
  it('places blocks by local wall clock across America/New_York 2026-11-01', () => {
    const wrapper = mount(WeekCalendar, {
      props: {
        timeZone: 'America/New_York',
        weekStart: '2026-11-01',
        taskNames: { [TASK_ID]: 'DST task' },
        blocks: [
          {
            taskId: TASK_ID,
            startAt: '2026-11-01T04:30:00.000Z',
            endAt: '2026-11-01T05:30:00.000Z',
          },
          {
            taskId: TASK_ID,
            startAt: '2026-11-01T06:30:00.000Z',
            endAt: '2026-11-01T07:30:00.000Z',
          },
          {
            taskId: TASK_ID,
            startAt: '2026-11-02T05:30:00.000Z',
            endAt: '2026-11-02T06:30:00.000Z',
          },
        ],
      },
    });

    const days = wrapper.findAll('.calendar-day');
    expect(days).toHaveLength(7);
    expect(days[0]?.attributes('data-date')).toBe('2026-11-01');
    expect(days[1]?.attributes('data-date')).toBe('2026-11-02');

    expect(topFor(wrapper, '2026-11-01', '00:30 to 01:30')).toBe('30px');
    expect(topFor(wrapper, '2026-11-01', '01:30 to 02:30')).toBe('90px');
    expect(topFor(wrapper, '2026-11-02', '00:30 to 01:30')).toBe('30px');

    const secondDayBlock = wrapper
      .get('.calendar-day[data-date="2026-11-02"]')
      .findAll('.calendar-block')[0];
    expect(secondDayBlock?.attributes('aria-label')).toContain('2026-11-02 00:30');
  });
});

describe('week calendar across the repeated fall-back hour', () => {
  it('sizes blocks and commitments from instants and labels offsets', () => {
    const wrapper = mount(WeekCalendar, {
      props: {
        timeZone: 'America/New_York',
        weekStart: '2026-11-01',
        taskNames: { [TASK_ID]: 'Crossing block' },
        commitmentNames: { 'commitment-1': 'Crossing commitment' },
        blocks: [
          {
            taskId: TASK_ID,
            startAt: '2026-11-01T05:30:00.000Z',
            endAt: '2026-11-01T06:30:00.000Z',
          },
        ],
        commitmentOccurrences: [
          {
            commitmentId: 'commitment-1',
            startAt: '2026-11-01T05:30:00.000Z',
            endAt: '2026-11-01T06:30:00.000Z',
          },
        ],
      },
    });

    const day = wrapper.get('.calendar-day[data-date="2026-11-01"]');
    const block = day.get('.calendar-block');
    const blockElement = block.element as HTMLElement;
    expect(blockElement.style.top).toBe('90px');
    expect(blockElement.style.height).toBe('60px');
    expect(block.attributes('aria-label')).toContain('01:30 to 01:30');
    expect(block.attributes('aria-label')).toContain('[GMT-4→GMT-5]');

    const commitment = day.get('.calendar-commitment');
    const commitmentElement = commitment.element as HTMLElement;
    expect(commitmentElement.style.top).toBe('90px');
    expect(commitmentElement.style.height).toBe('60px');
    expect(commitment.attributes('aria-label')).toContain('[GMT-4→GMT-5]');
    expect(commitment.attributes('aria-label')).toContain('Crossing commitment');
  });
});
