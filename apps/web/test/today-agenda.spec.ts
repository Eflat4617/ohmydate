import { mount, type VueWrapper } from '@vue/test-utils';
import { VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commitment, Task } from '../src/api';
import DayTimetable from '../src/components/DayTimetable.vue';
import { dayTimetable } from '../src/domain/dayTimetable';
import { setLayoutClock } from '../src/layout/clock';
import {
  MONTH_TASK_SCHOLARSHIP_ID,
  TODAY_TASK_ONE_TITLE,
  USER_ID,
  mockDb,
  seedMonth,
} from '../src/mocks/db';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import { sessionJournal } from '../src/session/journal';
import { useSessionStore } from '../src/stores/session';
import TodayView from '../src/components/today/TodayBoard.vue';

const Stub = defineComponent({ template: '<div />' });
const ZONE = 'Asia/Seoul';
const DATE = '2026-11-14';
const NOW = Date.parse('2026-11-14T09:40:00.000Z');

/** An instant from a Seoul wall-clock time (UTC+9, no DST). */
function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/commitments', name: 'commitments', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
    ],
  });
}

const mounted: VueWrapper[] = [];

async function mountToday(): Promise<VueWrapper> {
  const pinia = createPinia();
  useSessionStore(pinia).reset();
  const router = testRouter();
  await router.push('/overview');
  const wrapper = mount(TodayView, {
    global: { plugins: [pinia, VueQueryPlugin, router] },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await vi.waitFor(() => expect(wrapper.text()).toContain(TODAY_TASK_ONE_TITLE));
  return wrapper;
}

function task(id: string, title: string, dueAt: string, status: Task['status'] = 'todo'): Task {
  return {
    id,
    ownerId: USER_ID,
    projectId: mockDb.inboxProjectId,
    title,
    status,
    dueAt,
    splittable: true,
    priority: 2,
    dependsOn: [],
    version: 1,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
    external: [],
  };
}

function commitment(id: string, title: string, startAt: string, endAt: string): Commitment {
  return {
    id,
    ownerId: USER_ID,
    title,
    startAt,
    endAt,
    timeZone: ZONE,
    source: 'manual',
    version: 1,
    createdAt: '2026-11-02T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
  };
}

describe('Today: what else is on today (CAL-01)', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetFocusClientIdForTests();
    await sessionJournal.clear();
    setLayoutClock({ now: () => NOW });
  });

  afterEach(() => {
    while (mounted.length > 0) mounted.pop()?.unmount();
    setLayoutClock(null);
  });

  it("lists today's 약속 and what is due today under the block list, and draws the 약속 on the time table", async () => {
    seedMonth(mockDb);
    const wrapper = await mountToday();

    const commitments = await vi.waitFor(() => wrapper.get('[data-today-commitments]'));
    expect(commitments.get('h2').text()).toBe('오늘 약속');
    const rows = commitments.findAll('.today-agenda-item').map((row) => row.text());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('오후 3:00~3:40');
    expect(rows[0]).toContain('치과 예약');
    expect(rows[1]).toContain('오후 10:00~10:30');
    expect(rows[1]).toContain('가족 통화');

    const due = wrapper.get('[data-today-due]');
    expect(due.get('h2').text()).toBe('오늘 마감');
    expect(due.text()).toContain('오후 11:00까지');
    expect(due.get('a').text()).toBe('장학금 신청서 제출');
    expect(due.get('a').attributes('href')).toBe(`/tasks/${MONTH_TASK_SCHOLARSHIP_ID}`);

    // Under the block list, not in it.
    const list = wrapper.get('.today-blocks');
    expect(list.find('[data-today-commitments]').exists()).toBe(false);
    expect(wrapper.findAll('.today-card')).toHaveLength(2);

    const table = wrapper.get('.day-timetable');
    expect(table.findAll('[data-timetable-commitment]')).toHaveLength(2);
    expect(table.get('.tt').attributes('aria-label')).toBe('오늘 블록 2개를 10분 칸에 칠하고 약속 2개를 빗금으로 그린 표');
    expect(table.get('.tt-legend').text()).toContain('약속 · 치과 예약');
  });

  it('shows neither section when today has no 약속 and nothing due (negative)', async () => {
    const wrapper = await mountToday();
    // Give the agenda read time to answer.
    await vi.waitFor(() => expect(wrapper.find('.day-timetable').exists()).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wrapper.find('[data-today-commitments]').exists()).toBe(false);
    expect(wrapper.find('[data-today-due]').exists()).toBe(false);
    expect(wrapper.find('[data-timetable-commitment]').exists()).toBe(false);
    expect(wrapper.get('.tt').attributes('aria-label')).toBe('오늘 블록 2개를 10분 칸에 칠한 표');
  });

  it('leaves out a finished task, one due another day and a 약속 of another day (negative)', async () => {
    for (const item of [
      task('01900000-0000-7000-8000-0000000005a1', '이미 끝낸 일', seoul(DATE, '20:00'), 'done'),
      task('01900000-0000-7000-8000-0000000005a2', '내일 마감', seoul('2026-11-15', '00:00')),
      task('01900000-0000-7000-8000-0000000005a3', '오늘 자정 직전', seoul(DATE, '23:59')),
    ]) {
      mockDb.tasks.set(item.id, item);
    }
    const tomorrow = commitment(
      '01900000-0000-7000-8000-0000000005c1',
      '내일 약속',
      seoul('2026-11-15', '09:00'),
      seoul('2026-11-15', '10:00'),
    );
    mockDb.commitments.set(tomorrow.id, tomorrow);
    const wrapper = await mountToday();
    const due = await vi.waitFor(() => wrapper.get('[data-today-due]'));
    expect(due.findAll('.today-agenda-item').map((row) => row.get('a').text())).toEqual(['오늘 자정 직전']);
    expect(wrapper.find('[data-today-commitments]').exists()).toBe(false);
  });
});

describe('DayTimetable: 약속 as taken time', () => {
  it('draws a 약속 as its own mark beside the block runs, and starts early for it', () => {
    const rows = dayTimetable(
      [{ id: 'block', startAt: seoul(DATE, '19:00'), endAt: seoul(DATE, '20:00') }],
      DATE,
      ZONE,
      'block',
      [{ id: 'dawn', startAt: seoul(DATE, '05:30'), endAt: seoul(DATE, '06:20') }],
    );
    expect(rows[0]?.hour).toBe(5);
    expect(rows.find((row) => row.hour === 5)?.taken).toEqual([{ id: 'dawn', from: 0.5, to: 1 }]);
    expect(rows.find((row) => row.hour === 6)?.taken[0]?.to).toBeCloseTo(1 / 3);
    expect(rows.find((row) => row.hour === 19)?.runs).toEqual([{ blockId: 'block', series: 0, from: 0, to: 1 }]);
    expect(rows.find((row) => row.hour === 19)?.taken).toEqual([]);
  });

  it('has no taken marks without 약속, and never turns a 약속 into a block run (negative)', () => {
    const plain = dayTimetable([], DATE, ZONE, null);
    expect(plain.every((row) => row.taken.length === 0 && row.runs.length === 0)).toBe(true);
    const onlyTaken = dayTimetable([], DATE, ZONE, null, [
      { id: 'c', startAt: seoul(DATE, '15:00'), endAt: seoul(DATE, '15:40') },
      { id: 'other-day', startAt: seoul('2026-11-15', '15:00'), endAt: seoul('2026-11-15', '16:00') },
    ]);
    expect(onlyTaken.flatMap((row) => row.runs)).toEqual([]);
    expect(onlyTaken.flatMap((row) => row.taken.map((mark) => mark.id))).toEqual(['c']);
  });

  it('gives each 약속 on the page a legend entry and says so in the table name', () => {
    const wrapper = mount(DayTimetable, {
      props: {
        blocks: [{ id: 'b', title: '연구 노트 요약', startAt: seoul(DATE, '19:00'), endAt: seoul(DATE, '20:00') }],
        date: DATE,
        timeZone: ZONE,
        nextBlockId: 'b',
        nowMs: NOW,
        commitments: [
          { id: 'c1', title: '치과 예약', startAt: seoul(DATE, '15:00'), endAt: seoul(DATE, '15:40') },
          { id: 'c2', title: '다른 날', startAt: seoul('2026-11-16', '15:00'), endAt: seoul('2026-11-16', '16:00') },
        ],
      },
    });
    expect(wrapper.findAll('.tt-taken')).toHaveLength(1);
    expect(wrapper.findAll('.tt-legend-taken').map((item) => item.text())).toEqual(['약속 · 치과 예약']);
    expect(wrapper.get('.tt').attributes('aria-label')).toBe('오늘 블록 1개를 10분 칸에 칠하고 약속 1개를 빗금으로 그린 표');
    wrapper.unmount();
  });
});
