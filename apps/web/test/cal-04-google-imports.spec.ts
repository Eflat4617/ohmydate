import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query';
import { createPinia } from 'pinia';
import { HttpResponse, http } from 'msw';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { defineComponent, type Component } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createPlannerClient, newActionId } from '../src/api';
import { buildMonthGrid, dayEventDates, type MonthDay } from '../src/domain/monthGrid';
import { t } from '../src/i18n';
import { setLayoutClock } from '../src/layout/clock';
import { SEED_COMMITMENT_ID, TODAY_TASK_ONE_TITLE, mockDb, seedMonth } from '../src/mocks/db';
import { GOOGLE_COMMITMENT_CLUB_ID, GOOGLE_COMMITMENT_DENTIST_ID, seedGoogle } from '../src/mocks/google';
import { server } from '../src/mocks/server';
import { resetFocusClientIdForTests } from '../src/session/clientId';
import { sessionJournal } from '../src/session/journal';
import { useSessionStore } from '../src/stores/session';
import MonthView from '../src/views/MonthView.vue';
import PlannerView from '../src/views/PlannerView.vue';
import TodayView from '../src/components/today/TodayBoard.vue';

const Stub = defineComponent({ template: '<div />' });
const ZONE = 'Asia/Seoul';
/** 2026-11-14 18:40 in Seoul, the mock's day. */
const NOW = Date.parse('2026-11-14T09:40:00.000Z');
const mounted: VueWrapper[] = [];

function seoul(date: string, time: string): string {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function testRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/month', name: 'month', component: Stub },
      { path: '/overview', name: 'overview', component: Stub },
      { path: '/planner', name: 'planner', component: Stub },
      { path: '/settings/calendar', name: 'calendar-settings', component: Stub },
      { path: '/plans/new', name: 'plans-new', component: Stub },
      { path: '/tasks/:id', name: 'task', component: Stub },
      { path: '/focus/:sessionId', name: 'focus', component: Stub },
      { path: '/inbox', name: 'inbox', component: Stub },
      { path: '/settings/ai', name: 'ai-settings', component: Stub },
    ],
  });
}

async function mountView(view: Component, path: string): Promise<VueWrapper> {
  const router = testRouter();
  await router.push(path);
  const pinia = createPinia();
  useSessionStore(pinia).reset();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  const wrapper = mount(view, {
    global: { plugins: [pinia, [VueQueryPlugin, { queryClient }], router] as never },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setLayoutClock({ now: () => NOW });
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.unmount();
  setLayoutClock(null);
});

// HOLO-04: the 약속 screen is the planner's list view (`/planner?view=list`);
// the mock's week is 2026-11-09..11-15.
describe('플래너 · 약속: rows imported from Google are read-only', () => {
  async function mountCommitments(): Promise<VueWrapper> {
    const wrapper = await mountView(PlannerView, '/planner?view=list');
    await vi.waitFor(() => expect(wrapper.find(`[data-source="google"]`).exists() || wrapper.text().includes('팀 회의')).toBe(true));
    return wrapper;
  }

  function row(wrapper: VueWrapper, title: string) {
    const found = wrapper.findAll('.commitment-item').find((item) => item.get('.commitment-title').text() === title);
    if (found === undefined) throw new Error(`row not found: ${title}`);
    return found;
  }

  it('says 구글 캘린더 in words and offers no 고치기; manual rows are as before', async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'connected');
    const wrapper = await mountCommitments();
    await vi.waitFor(() => expect(wrapper.text()).toContain('치과 예약'));

    const dentist = row(wrapper, '치과 예약');
    expect(dentist.attributes('data-source')).toBe('google');
    expect(dentist.get('[data-commitment-source]').text()).toBe('구글 캘린더');
    expect(dentist.text()).toContain(t('commitments.google.readOnly'));
    expect(dentist.findAll('button')).toHaveLength(0);

    const manual = row(wrapper, '팀 회의');
    expect(manual.attributes('data-source')).toBe('manual');
    expect(manual.find('[data-commitment-source]').exists()).toBe(false);
    // One way in for a manual row: 고치기 opens the planner's dialog on it (change or delete).
    expect(manual.findAll('button').map((button) => button.text().replace(/\s+/g, ' '))).toEqual(['팀 회의 고치기']);

    // One line under the list says where they come from and links to 캘린더 연동.
    const note = wrapper.get('[data-google-note]');
    expect(note.text()).toContain(t('commitments.google.note'));
    expect(note.get('a').attributes('href')).toBe('/settings/calendar');
    expect(note.get('a').text()).toBe('캘린더 연동');
    expect(wrapper.find('[data-google-stale]').exists()).toBe(false);
  });

  it('without Google there is no note and every row keeps 고치기 (negative)', async () => {
    const wrapper = await mountCommitments();
    await vi.waitFor(() => expect(wrapper.text()).toContain('팀 회의'));
    await flushPromises();
    expect(wrapper.find('[data-google-note]').exists()).toBe(false);
    expect(wrapper.find('[data-google-stale]').exists()).toBe(false);
    for (const item of wrapper.findAll('.commitment-item')) expect(item.findAll('button')).toHaveLength(1);
    // The manual edit path: the row's 고치기 opens the dialog on that 약속, with 삭제 in it.
    await row(wrapper, '팀 회의').get('[data-commitment-edit]').trigger('click');
    await flushPromises();
    expect((wrapper.get('#planner-commitment-title').element as HTMLInputElement).value).toBe('팀 회의');
    expect(wrapper.find('[data-planner-delete]').exists()).toBe(true);
  });

  it('when sign-in expired, one line says imported 약속 may be out of date', async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'needs_reauth');
    const wrapper = await mountCommitments();
    const stale = await vi.waitFor(() => wrapper.get('[data-google-stale]'));
    expect(stale.text()).toContain(t('commitments.google.stale'));
    expect(stale.get('a').attributes('href')).toBe('/settings/calendar');
    expect(wrapper.findAll('[data-google-stale]')).toHaveLength(1);
  });

  it('the mock API refuses to edit or delete an imported 약속 (409), and a manual one still works', async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'connected');
    const client = createPlannerClient();
    const imported = mockDb.commitments.get(GOOGLE_COMMITMENT_DENTIST_ID);
    expect(imported?.source).toBe('google');
    const patch = client.updateCommitment(GOOGLE_COMMITMENT_DENTIST_ID, { title: 'x' }, newActionId('patch'), 1);
    await expect(patch).rejects.toMatchObject({ status: 409, code: 'illegal_transition' });
    const remove = client.deleteCommitment(GOOGLE_COMMITMENT_DENTIST_ID, newActionId('delete'), 1);
    await expect(remove).rejects.toBeInstanceOf(ApiError);
    expect(mockDb.commitments.has(GOOGLE_COMMITMENT_DENTIST_ID)).toBe(true);
    const updated = await client.updateCommitment(SEED_COMMITMENT_ID, { title: '팀 회의 (변경)' }, newActionId('patch'), 1);
    expect(updated.title).toBe('팀 회의 (변경)');
  });
});

describe('한달: all-day events are plain day labels (domain)', () => {
  const base = { month: '2026-11', timeZone: ZONE, today: '2026-11-14', blocks: [], tasks: [] };

  function dayOf(days: readonly (readonly MonthDay[])[], date: string): MonthDay {
    const found = days.flat().find((day) => day.date === date);
    if (found === undefined) throw new Error(`no day ${date}`);
    return found;
  }

  it('puts a multi-day event on each of its days (end exclusive) and never counts it', () => {
    const grid = buildMonthGrid({
      ...base,
      commitments: [],
      dayEvents: [
        { id: 'trip', title: '가족 여행', startDate: '2026-11-27', endDate: '2026-11-30', calendarName: '가족' },
        { id: 'xmas', title: '크리스마스', startDate: '2026-12-25', endDate: '2026-12-26', calendarName: '대한민국의 휴일' },
      ],
    });
    const covered = grid.weeks.flat().filter((day) => day.labels.length > 0).map((day) => day.date);
    expect(covered).toEqual(['2026-11-27', '2026-11-28', '2026-11-29']);
    expect(dayOf(grid.weeks, '2026-11-28').labels[0]).toMatchObject({
      title: '가족 여행',
      calendarName: '가족',
      firstDate: '2026-11-27',
      lastDate: '2026-11-29',
      multiDay: true,
    });
    // Labels are not items: no counts, no busy day, the month is still "nothing planned".
    expect(dayOf(grid.weeks, '2026-11-28').items).toEqual([]);
    expect(dayOf(grid.weeks, '2026-11-28').counts).toEqual({ block: 0, commitment: 0, deadline: 0 });
    expect(grid.empty).toBe(true);
  });

  it('clips an event to the grid and ignores an empty or malformed span (negative)', () => {
    expect(dayEventDates({ startDate: '2026-10-20', endDate: '2026-10-28' }, '2026-10-26', '2026-12-06')).toEqual([
      '2026-10-26',
      '2026-10-27',
    ]);
    expect(dayEventDates({ startDate: '2026-11-03', endDate: '2026-11-03' }, '2026-10-26', '2026-12-06')).toEqual([]);
    expect(dayEventDates({ startDate: '2026-11-05', endDate: '2026-11-04' }, '2026-10-26', '2026-12-06')).toEqual([]);
    expect(dayEventDates({ startDate: '11/03', endDate: '2026-11-04' }, '2026-10-26', '2026-12-06')).toEqual([]);
  });

  it('marks a 약속 from Google so the day list can say so; other sources are not marked', () => {
    const grid = buildMonthGrid({
      ...base,
      commitments: [
        {
          id: 'g',
          title: '치과 예약',
          source: 'google',
          occurrences: [{ commitmentId: 'g', startAt: seoul('2026-11-14', '15:00'), endAt: seoul('2026-11-14', '15:40') }],
        },
        {
          id: 'm',
          title: '가족 통화',
          source: 'manual',
          occurrences: [{ commitmentId: 'm', startAt: seoul('2026-11-14', '22:00'), endAt: seoul('2026-11-14', '22:30') }],
        },
      ],
    });
    expect(dayOf(grid.weeks, '2026-11-14').items.map((item) => [item.title, item.fromGoogle])).toEqual([
      ['치과 예약', true],
      ['가족 통화', false],
    ]);
  });
});

describe('한달: day labels on the page', () => {
  async function mountMonth(): Promise<VueWrapper> {
    const wrapper = await mountView(MonthView, '/month');
    await vi.waitFor(() => expect(wrapper.find('[data-month-title]').exists()).toBe(true));
    await vi.waitFor(() => expect(wrapper.find('.month-grid').attributes('aria-busy')).toBeUndefined());
    return wrapper;
  }

  function cell(wrapper: VueWrapper, date: string) {
    return wrapper.get(`[role="gridcell"][data-date="${date}"]`);
  }

  it('shows the labels at the top of each day, in the cell name and in the day detail; Google 약속 are named so', async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'connected');
    const wrapper = await mountMonth();
    await vi.waitFor(() => expect(cell(wrapper, '2026-11-28').find('[data-month-day-labels]').exists()).toBe(true));

    for (const date of ['2026-11-27', '2026-11-28', '2026-11-29']) {
      expect(cell(wrapper, date).get('.month-day-label').text()).toBe('가족 여행');
      expect(cell(wrapper, date).attributes('aria-label')).toContain('종일 일정 가족 여행');
    }
    expect(cell(wrapper, '2026-11-30').find('[data-month-day-labels]').exists()).toBe(false);
    expect(cell(wrapper, '2026-11-22').attributes('aria-label')).toBe('11월 22일 일요일, 종일 일정 엄마 생신');
    // A label is not an item: it is outside the item list and adds no count.
    expect(cell(wrapper, '2026-11-28').find('.month-items .month-day-label').exists()).toBe(false);
    expect(wrapper.get('.month-summary').text()).toBe('이 달 · 블록 30개 · 약속 19개 · 마감 4개');
    // The legend's sample is the mark itself: the first labelled date, underlined.
    const legend = wrapper.get('[data-month-legend-day-event]');
    expect(legend.get('.month-legend-daylabel').text()).toBe('22');
    expect(legend.text()).toBe(`22${t('month.legendDayEvent')}`);
    expect(cell(wrapper, '2026-11-22').get('.month-day').classes()).toContain('month-day--labelled');
    expect(cell(wrapper, '2026-11-21').get('.month-day').classes()).not.toContain('month-day--labelled');

    await cell(wrapper, '2026-11-28').trigger('click');
    const labels = wrapper.get('[data-month-detail-labels]');
    expect(labels.text()).toContain('가족 여행');
    expect(labels.text()).toContain('종일 · 가족');
    expect(labels.text()).toContain('11월 27일 (금) ~ 11월 29일 (일)');

    // Today's dentist came from Google; the family call was written here.
    await cell(wrapper, '2026-11-14').trigger('click');
    const agenda = wrapper.findAll('[data-month-detail] .month-agenda-item[data-kind="commitment"]');
    const kinds = agenda.map((item) => [item.get('.month-agenda-title').text(), item.get('.month-agenda-kind').text()]);
    expect(kinds).toEqual([
      ['치과 예약', '약속 · 구글 캘린더'],
      ['가족 통화', '약속'],
    ]);
  });

  it('a failed day-event read leaves the month as it was, with one quiet line (negative)', async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'connected');
    server.use(
      http.get('*/api/v1/calendar-day-events', () =>
        HttpResponse.json(
          { type: 'about:blank', title: 'x', status: 422, code: 'validation_failed', detail: 'x' },
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
      ),
    );
    const wrapper = await mountMonth();
    await vi.waitFor(() => expect(wrapper.find('[data-month-day-events-error]').exists()).toBe(true));
    expect(wrapper.get('[data-month-day-events-error]').text()).toBe(t('month.dayEventsError'));
    expect(wrapper.findAll('[data-month-day-labels]')).toHaveLength(0);
    expect(wrapper.find('[data-month-legend-day-event]').exists()).toBe(false);
    // Everything else is there and the grid is not an error.
    expect(wrapper.get('.month-summary').text()).toBe('이 달 · 블록 30개 · 약속 19개 · 마감 4개');
    expect(wrapper.find('[data-month-retry]').exists()).toBe(false);
    expect(cell(wrapper, '2026-11-14').text()).toContain('치과 예약');
  });

  it('without Google nothing changes: no labels, no legend entry, no error line (negative)', async () => {
    seedMonth(mockDb);
    const wrapper = await mountMonth();
    await flushPromises();
    expect(wrapper.findAll('[data-month-day-labels]')).toHaveLength(0);
    expect(wrapper.find('[data-month-legend-day-event]').exists()).toBe(false);
    expect(wrapper.find('[data-month-day-events-error]').exists()).toBe(false);
    expect(wrapper.get('.month-summary').text()).toBe('이 달 · 블록 30개 · 약속 17개 · 마감 4개');
  });
});

describe('오늘: a 약속 imported from Google for today shows like any other', () => {
  beforeEach(async () => {
    localStorage.clear();
    resetFocusClientIdForTests();
    await sessionJournal.clear();
  });

  it("lists it under today's 약속 and draws it on the time table", async () => {
    seedMonth(mockDb);
    seedGoogle(mockDb, 'connected');
    expect(mockDb.commitments.get(GOOGLE_COMMITMENT_DENTIST_ID)?.source).toBe('google');
    const wrapper = await mountView(TodayView, '/overview');
    await vi.waitFor(() => expect(wrapper.text()).toContain(TODAY_TASK_ONE_TITLE));
    const commitments = await vi.waitFor(() => wrapper.get('[data-today-commitments]'));
    const rows = commitments.findAll('.today-agenda-item').map((item) => item.text());
    expect(rows.some((text) => text.includes('치과 예약') && text.includes('오후 3:00~3:40'))).toBe(true);
    expect(wrapper.get('.day-timetable .tt-legend').text()).toContain('약속 · 치과 예약');
    // Not today's: the club meeting on the 18th stays off Today (negative).
    expect(mockDb.commitments.get(GOOGLE_COMMITMENT_CLUB_ID)?.source).toBe('google');
    expect(commitments.text()).not.toContain('동아리 회의');
  });
});
