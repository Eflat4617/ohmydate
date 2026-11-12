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

    expect(topFor(wrapper, '2026-11-01', '오전 12:30~1:30')).toBe('30px');
    expect(topFor(wrapper, '2026-11-01', '오전 1:30~2:30')).toBe('90px');
    expect(topFor(wrapper, '2026-11-02', '오전 12:30~1:30')).toBe('30px');

    const secondDayBlock = wrapper
      .get('.calendar-day[data-date="2026-11-02"]')
      .findAll('.calendar-block')[0];
    expect(secondDayBlock?.attributes('aria-label')).toContain('11월 2일 (월) 오전 12:30');
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
    expect(block.attributes('aria-label')).toContain('오전 1:30~1:30');
    expect(block.attributes('aria-label')).toContain('(GMT-4→GMT-5)');

    const commitment = day.get('.calendar-commitment');
    const commitmentElement = commitment.element as HTMLElement;
    expect(commitmentElement.style.top).toBe('90px');
    expect(commitmentElement.style.height).toBe('60px');
    expect(commitment.attributes('aria-label')).toContain('(GMT-4→GMT-5)');
    expect(commitment.attributes('aria-label')).toContain('Crossing commitment');
  });
});

describe('week calendar scroll region keyboard access', () => {
  it('stays focusable and labelled when the week has no blocks', () => {
    const wrapper = mount(WeekCalendar, {
      attachTo: document.body,
      props: { timeZone: 'UTC', weekStart: '2026-11-09', blocks: [] },
    });

    expect(wrapper.findAll('.calendar-block')).toHaveLength(0);
    const region = wrapper.get('.week-calendar');
    expect(region.attributes('role')).toBe('region');
    expect(region.attributes('aria-label')).toBe('주간 달력');
    expect(region.attributes('tabindex')).toBe('0');
    (region.element as HTMLElement).focus();
    expect(document.activeElement).toBe(region.element);
    wrapper.unmount();
  });

  it('does not edit blocks when arrow keys reach the region itself', async () => {
    const wrapper = mount(WeekCalendar, {
      attachTo: document.body,
      props: {
        timeZone: 'UTC',
        weekStart: '2026-11-09',
        editable: true,
        blocks: [
          { taskId: TASK_ID, startAt: '2026-11-11T09:00:00.000Z', endAt: '2026-11-11T10:00:00.000Z' },
        ],
      },
    });

    const region = wrapper.get('.week-calendar');
    await region.trigger('keydown', { key: 'ArrowDown' });
    await region.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.emitted('update:blocks')).toBeUndefined();
    expect(wrapper.get('.calendar-block').attributes('tabindex')).toBeUndefined();
    wrapper.unmount();
  });
});

describe('week calendar while editing is off (FU-86F)', () => {
  const blocks = [{ taskId: TASK_ID, startAt: '2026-11-10T01:00:00.000Z', endAt: '2026-11-10T02:00:00.000Z' }];

  function press(element: Element, clientY: number): void {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY }));
  }

  function move(clientY: number): void {
    window.dispatchEvent(new PointerEvent('pointermove', { clientY }));
  }

  function release(clientY: number): void {
    window.dispatchEvent(new PointerEvent('pointerup', { clientY }));
  }

  it('refuses a press-and-drag and the arrow keys, changes nothing and reports each try', async () => {
    const wrapper = mount(WeekCalendar, {
      attachTo: document.body,
      props: { timeZone: 'UTC', weekStart: '2026-11-09', blocks, editable: false },
    });
    expect(wrapper.find('.calendar-resize').exists()).toBe(false);
    const block = wrapper.get('.calendar-block');
    press(block.element, 0);
    move(30);
    release(30);
    await block.trigger('keydown', { key: 'ArrowDown' });
    await block.trigger('keydown', { key: 'ArrowUp', shiftKey: true });
    expect(wrapper.emitted('update:blocks')).toBeUndefined();
    expect(wrapper.emitted('edit-blocked')).toEqual([[0], [0], [0]]);
    // Other keys are no edit: nothing to report (negative).
    await block.trigger('keydown', { key: 'Enter' });
    await block.trigger('keydown', { key: 'Tab' });
    expect(wrapper.emitted('edit-blocked')).toHaveLength(3);
    wrapper.unmount();
  });

  it('a drag under way stops changing blocks while editing is off and moves again once it is back', async () => {
    const wrapper = mount(WeekCalendar, {
      attachTo: document.body,
      props: { timeZone: 'UTC', weekStart: '2026-11-09', blocks, editable: true },
    });
    press(wrapper.get('.calendar-block').element, 0);
    // Editable: the press itself is no blocked edit (negative).
    expect(wrapper.emitted('edit-blocked')).toBeUndefined();
    await wrapper.setProps({ editable: false });
    move(30);
    expect(wrapper.emitted('update:blocks')).toBeUndefined();
    expect(wrapper.emitted('edit-blocked')).toEqual([[0]]);
    await wrapper.setProps({ editable: true });
    move(30);
    const updates = wrapper.emitted('update:blocks') as Array<[Array<{ startAt: string; endAt: string }>]> | undefined;
    expect(updates).toHaveLength(1);
    expect(updates?.[0]?.[0][0]).toMatchObject({
      startAt: '2026-11-10T01:30:00.000Z',
      endAt: '2026-11-10T02:30:00.000Z',
    });
    release(30);
    wrapper.unmount();
  });
});
