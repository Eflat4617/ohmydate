import { HOLD_MS, POLICY_VERSION } from '@ohmydate/ui-policy';
import { newActionId, plannerClient } from '../src/api';
import { setLayoutClock } from '../src/layout/clock';
import { layoutPrefsKey } from '../src/layout/prefs';
import { mockDb, seedTodayRisk } from '../src/mocks/db';
import { sessionJournal } from '../src/session/journal';
import { useLayoutStore } from '../src/stores/layout';
import { useSessionStore } from '../src/stores/session';
import { useToastStore } from '../src/stores/toast';
import {
  IN_REVIEW_WINDOW,
  announcement,
  bodyButton,
  button,
  modeOf,
  mountApp,
  regionsOf,
  settle,
  startedSession,
  useTestClock,
  type MountedApp,
} from './m6-layout-utils';

let mounted: MountedApp | null = null;

beforeEach(async () => {
  localStorage.clear();
  await sessionJournal.clear();
});

afterEach(() => {
  mounted?.wrapper.unmount();
  mounted = null;
  setLayoutClock(null);
});

async function openToday(): Promise<MountedApp> {
  mounted = await mountApp('/today');
  await vi.waitFor(() => expect(mounted?.wrapper.findAll('.today-card').length).toBeGreaterThan(0));
  await settle();
  return mounted;
}

async function startFromToday(app: MountedApp): Promise<string> {
  await button(app.wrapper.findAll('.today-card')[0]!, '집중 시작').trigger('click');
  await vi.waitFor(() => expect(app.router.currentRoute.value.name).toBe('focus'));
  await vi.waitFor(() => expect(app.wrapper.find('.focus-timer').exists()).toBe(true));
  await settle();
  return String(app.router.currentRoute.value.params['sessionId']);
}

describe('adaptive layout — modes (07 §2.2)', () => {
  it('overview: Today with next up and related notes; nav pinned and always rendered', async () => {
    useTestClock();
    const app = await openToday();
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(regionsOf(app.wrapper)).toEqual({
      primary: ['TodayPlan'],
      secondary: ['NextUp'],
      tertiary: ['RelatedNotes'],
    });
    const frameEl = app.wrapper.get('.adaptive-frame');
    expect(frameEl.attributes('data-layout-pinned')).toBe('NavRail BottomNav');
    expect(frameEl.attributes('data-policy-version')).toBe(POLICY_VERSION);
    expect(app.wrapper.find('.nav-rail').exists()).toBe(true);
    expect(app.wrapper.find('.bottom-nav').exists()).toBe(true);
    // The notes region is a placeholder until M6-03.
    expect(app.wrapper.get('[data-panel="related-notes"]').text()).toContain('아직 연결된 노트가 없어요');
    expect(app.wrapper.get('[data-panel="next-up"]').text()).toContain('다음 일정');
    // Exactly one page heading.
    expect(app.wrapper.findAll('h1').map((h) => h.text())).toEqual(['오늘']);
  });

  it('focus: starting a session from Today switches to the focus layout with an undo toast', async () => {
    useTestClock();
    const app = await openToday();
    const sessionId = await startFromToday(app);
    expect(app.router.currentRoute.value.path).toBe(`/focus/${sessionId}`);
    expect(modeOf(app.wrapper)).toBe('focus');
    expect(regionsOf(app.wrapper)).toEqual({
      primary: ['FocusTimer'],
      secondary: ['CurrentTaskCard', 'RelatedNotes'],
      tertiary: ['NextUp'],
    });
    expect(app.wrapper.get('[data-panel="current-task"]').text()).toContain('연구 노트 요약');
    const toast = useToastStore(app.pinia).toasts.find((item) => item.message === '레이아웃이 바뀌었어요');
    expect(toast?.action?.label).toBe('되돌리기');
    expect(toast?.secondaryAction?.label).toBe('자동 전환 끄기');
    await vi.waitFor(() => expect(announcement(app.wrapper)).toBe('화면 배치를 바꿨어요: 집중'));
    // Focus was on the (now gone) start button: it lands on the primary region.
    expect((document.activeElement as HTMLElement | null)?.dataset['layoutRegion']).toBe('primary');
    // NavRail / BottomNav stay rendered in every mode.
    expect(app.wrapper.find('.nav-rail').exists()).toBe(true);
    expect(app.wrapper.find('.bottom-nav').exists()).toBe(true);
  });

  it('planning: the planning page stays primary, context goes below it', async () => {
    useTestClock();
    mounted = await mountApp('/plan/new');
    await vi.waitFor(() => expect(mounted?.wrapper.find('#wizard-title').exists()).toBe(true));
    expect(modeOf(mounted.wrapper)).toBe('planning');
    expect(regionsOf(mounted.wrapper)).toEqual({
      primary: ['PlanningWorkspace'],
      secondary: ['RelatedNotes'],
      tertiary: ['NextUp'],
    });
    expect(mounted.wrapper.get('.adaptive-frame').classes()).toContain('adaptive-frame--stacked');
  });

  it('deadline risk: the risk panel goes above Today until the user acknowledges it', async () => {
    useTestClock();
    seedTodayRisk(mockDb);
    const app = await openToday();
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('deadline_risk'));
    expect(regionsOf(app.wrapper).primary).toEqual(['DeadlineRiskPanel', 'TodayPlan']);
    const panel = app.wrapper.get('[data-panel="deadline-risk"]');
    expect(panel.text()).toContain('마감 위험이 있어요');
    expect(panel.text()).toContain('마감까지 시간이 45분 모자라요');
    expect(panel.find('a[href="/replan"]').exists()).toBe(true);

    await button(panel, '확인했어요').trigger('click');
    await settle();
    // An explicit answer applies at once (no hold, no toast).
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(app.wrapper.find('[data-panel="deadline-risk"]').exists()).toBe(false);
    expect(useToastStore(app.pinia).toasts.some((item) => item.message === '레이아웃이 바뀌었어요')).toBe(false);
    await vi.waitFor(() => expect(announcement(app.wrapper)).toBe('화면 배치가 바뀌었어요: 기본'));
    expect(localStorage.getItem(`ohmydate.layout.riskAck:${mockDb.user.id}`)).toBe('2026-11-14');
  });

  it('review: after 20:00 an unreviewed session puts the review prompt above Today', async () => {
    useTestClock(IN_REVIEW_WINDOW);
    mounted = await mountApp('/today', async (pinia) => {
      const session = await startedSession(pinia);
      const done = await plannerClient.completeSession(
        session.id,
        new Date(IN_REVIEW_WINDOW - 60_000).toISOString(),
        newActionId('complete'),
        session.version,
      );
      useSessionStore(pinia).remember({ ...done, endedAt: new Date(IN_REVIEW_WINDOW - 60_000).toISOString() });
    });
    await vi.waitFor(() => expect(modeOf(mounted?.wrapper as never)).toBe('review'));
    expect(regionsOf(mounted.wrapper).primary).toEqual(['ReviewPrompt', 'TodayPlan']);
    const panel = mounted.wrapper.get('[data-panel="review-prompt"]');
    expect(panel.text()).toContain('아직 회고하지 않은 세션이 1개 있어요.');
    expect(panel.find('a').attributes('href')).toMatch(/^\/focus\//);

    await button(panel, '오늘은 건너뛰기').trigger('click');
    await settle();
    expect(modeOf(mounted.wrapper)).toBe('overview');
  });

  it('notes: the notes page with five related notes beside it', async () => {
    useTestClock();
    mounted = await mountApp('/notes');
    await vi.waitFor(() => expect(modeOf(mounted?.wrapper as never)).toBe('notes'));
    expect(regionsOf(mounted.wrapper)).toEqual({
      primary: ['NotesWorkspace'],
      secondary: ['RelatedNotes'],
      tertiary: ['NextUp'],
    });
    expect(mounted.wrapper.get('[data-panel="related-notes"]').text()).toContain('최대 5개');
    expect(mounted.wrapper.get('h1').text()).toBe('노트');
  });

  it('screens outside the adaptive layout render without the frame (negative)', async () => {
    useTestClock();
    mounted = await mountApp('/inbox');
    await vi.waitFor(() => expect(mounted?.wrapper.find('.nav-rail').exists()).toBe(true));
    expect(mounted.wrapper.find('.adaptive-frame').exists()).toBe(false);
  });
});

describe('adaptive layout — undo, hold and auto switch', () => {
  it('undo restores Today, keeps the session running and does not switch straight back', async () => {
    const clock = useTestClock();
    const app = await openToday();
    const sessionId = await startFromToday(app);

    bodyButton('되돌리기').click();
    await vi.waitFor(() => expect(app.router.currentRoute.value.path).toBe('/today'));
    await settle();
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(regionsOf(app.wrapper).primary).toEqual(['TodayPlan']);
    expect(useSessionStore(app.pinia).active?.id).toBe(sessionId);
    await vi.waitFor(() => expect(announcement(app.wrapper)).toBe('화면 배치를 되돌렸어요: 기본'));
    expect((document.activeElement as HTMLElement | null)?.dataset['layoutRegion']).toBe('primary');

    // Long after the hold the same session still does not pull the layout back.
    clock.advance(HOLD_MS + 60_000);
    useLayoutStore(app.pinia).step();
    await settle();
    expect(modeOf(app.wrapper)).toBe('overview');
  });

  it('holds an automatic switch for 10 minutes: 9:59 waits, 10:00 switches', async () => {
    const clock = useTestClock();
    const app = await openToday();
    const layout = useLayoutStore(app.pinia);
    const original = mockDb.today;

    // A deadline risk appears: automatic switch (with the undo toast).
    seedTodayRisk(mockDb);
    await app.queryClient.invalidateQueries({ queryKey: ['today'] });
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('deadline_risk'));
    expect(useToastStore(app.pinia).toasts.some((item) => item.message === '레이아웃이 바뀌었어요')).toBe(true);

    // One minute later the risk is gone; the risk layout is held.
    clock.advance(60_000);
    mockDb.today = original;
    await app.queryClient.invalidateQueries({ queryKey: ['today'] });
    await vi.waitFor(() => expect(layout.lastOutcome).toMatchObject({ kind: 'deferred', because: 'hold' }));
    expect(modeOf(app.wrapper)).toBe('deadline_risk');

    clock.advance(HOLD_MS - 60_000 - 1000); // 9:59 after the switch
    layout.step();
    await settle();
    expect(modeOf(app.wrapper)).toBe('deadline_risk');

    clock.advance(1000); // 10:00
    layout.step();
    await settle();
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(app.router.currentRoute.value.path).toBe('/today');
  });

  it('keeps the Focus screen (and its review sheet) after the session ends, even past the hold', async () => {
    const clock = useTestClock();
    const app = await openToday();
    const sessionId = await startFromToday(app);
    const layout = useLayoutStore(app.pinia);

    await button(app.wrapper, '완료').trigger('click');
    await vi.waitFor(() => expect(app.wrapper.text()).toContain('이번 세션은 어땠나요?'));
    clock.advance(HOLD_MS + 60_000);
    layout.step();
    await settle();
    expect(layout.lastOutcome).toMatchObject({ kind: 'deferred', because: 'page' });
    expect(app.router.currentRoute.value.path).toBe(`/focus/${sessionId}`);
    expect(modeOf(app.wrapper)).toBe('focus');
    expect(app.wrapper.text()).toContain('이번 세션은 어땠나요?');
  });

  it('returning to Today after completing a session stays on Today (no stale session revived)', async () => {
    useTestClock();
    const app = await openToday();
    const sessionId = await startFromToday(app);
    // Undo while the session runs: Today caches the running session…
    bodyButton('되돌리기').click();
    await vi.waitFor(() => expect(app.router.currentRoute.value.path).toBe('/today'));
    await vi.waitFor(() => expect(app.wrapper.text()).toContain('세션 이어가기'));
    await button(app.wrapper, '세션 이어가기').trigger('click');
    await vi.waitFor(() => expect(app.wrapper.find('.focus-timer').exists()).toBe(true));
    await vi.waitFor(() => expect(button(app.wrapper, '완료').attributes('disabled')).toBeUndefined());
    await button(app.wrapper, '완료').trigger('click');
    await vi.waitFor(() => expect(useSessionStore(app.pinia).get(sessionId)?.state).toBe('completed'));

    // …and coming back must not resurrect it as active (which would switch to Focus).
    await app.router.push('/today');
    await settle();
    await vi.waitFor(() => expect(app.wrapper.findAll('.today-card').length).toBeGreaterThan(0));
    await settle();
    expect(useSessionStore(app.pinia).get(sessionId)?.state).toBe('completed');
    expect(app.router.currentRoute.value.path).toBe('/today');
    expect(modeOf(app.wrapper)).toBe('overview');
  });

  it('does not switch while the user is typing, and switches once they stop', async () => {
    useTestClock();
    const app = await openToday();
    const layout = useLayoutStore(app.pinia);
    await button(app.wrapper.findAll('.today-card')[0]!, '축소').trigger('click');
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('shrink-minutes'));

    // A session starts elsewhere (another device) while the user types.
    await startedSession(app.pinia);
    await settle();
    expect(layout.lastOutcome).toMatchObject({ kind: 'deferred', because: 'typing' });
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(app.router.currentRoute.value.path).toBe('/today');
    expect(app.wrapper.find('#shrink-minutes').exists()).toBe(true);

    await button(app.wrapper, '취소').trigger('click');
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('focus'), { timeout: 3000 });
    expect(app.router.currentRoute.value.name).toBe('focus');
  });

  it('"자동 전환 끄기" in the toast turns auto switching off and it persists across a reload', async () => {
    useTestClock();
    const app = await openToday();
    await startFromToday(app);
    bodyButton('자동 전환 끄기').click();
    await settle();
    expect(useLayoutStore(app.pinia).prefs.autoSwitch).toBe(false);
    expect(JSON.parse(localStorage.getItem(layoutPrefsKey(mockDb.user.id)) ?? '{}')).toEqual({
      autoSwitch: false,
      locked: null,
    });
    // The layout itself stays as it is.
    expect(modeOf(app.wrapper)).toBe('focus');

    // "Reload": a fresh app reads the stored preference.
    app.wrapper.unmount();
    mounted = await mountApp('/settings/layout');
    const toggle = mounted.wrapper.get<HTMLInputElement>('input[data-layout-auto]');
    expect(toggle.element.checked).toBe(false);
    expect(useLayoutStore(mounted.pinia).prefs.autoSwitch).toBe(false);
  });

  it('with auto switching off, Today does not change by itself', async () => {
    useTestClock();
    localStorage.setItem(layoutPrefsKey(mockDb.user.id), JSON.stringify({ autoSwitch: false, locked: null }));
    const app = await openToday();
    await startedSession(app.pinia);
    await settle();
    expect(useLayoutStore(app.pinia).lastOutcome).toEqual({ kind: 'blocked', because: 'auto_off' });
    expect(modeOf(app.wrapper)).toBe('overview');
    expect(app.router.currentRoute.value.path).toBe('/today');
  });

  it('with auto switching off, starting from Today still opens Focus — directly, without a toast', async () => {
    useTestClock();
    localStorage.setItem(layoutPrefsKey(mockDb.user.id), JSON.stringify({ autoSwitch: false, locked: null }));
    const app = await openToday();
    await startFromToday(app);
    expect(modeOf(app.wrapper)).toBe('focus');
    expect(useToastStore(app.pinia).toasts.some((item) => item.message === '레이아웃이 바뀌었어요')).toBe(false);
  });
});

describe('adaptive layout — settings toggle (auto on/off, lock current)', () => {
  it('turns auto switching on and off and locks / unlocks the current layout', async () => {
    useTestClock();
    const app = await openToday();
    const layout = useLayoutStore(app.pinia);
    await app.router.push('/settings/layout');
    await settle();
    expect(app.wrapper.find('.adaptive-frame').exists()).toBe(false);
    expect(app.wrapper.get('h1').text()).toBe('레이아웃');

    const toggle = app.wrapper.get<HTMLInputElement>('input[data-layout-auto]');
    expect(toggle.element.checked).toBe(true);
    await toggle.setValue(false);
    expect(layout.prefs.autoSwitch).toBe(false);
    await toggle.setValue(true);
    expect(layout.prefs.autoSwitch).toBe(true);

    const lock = app.wrapper.get('button[data-layout-lock]');
    expect(lock.text()).toContain('지금 배치 고정하기 (기본)');
    await lock.trigger('click');
    expect(layout.prefs.locked).toBe('overview');
    expect(app.wrapper.get('[data-layout-lock-status]').text()).toBe('고정한 배치: 기본');

    // Locked: a new deadline risk does not change Today.
    seedTodayRisk(mockDb);
    await app.router.push('/today');
    await vi.waitFor(() => expect(modeOf(app.wrapper)).toBe('overview'));
    expect(app.wrapper.find('[data-panel="deadline-risk"]').exists()).toBe(false);
    expect(app.wrapper.get('.adaptive-frame').attributes('data-layout-reason')).toBe('locked');

    await app.router.push('/settings/layout');
    await settle();
    await app.wrapper.get('button[data-layout-unlock]').trigger('click');
    expect(layout.prefs.locked).toBeNull();
    expect(app.wrapper.get('[data-layout-lock-status]').text()).toBe('고정하지 않았어요.');
  });

  it('offers no lock before any layout was shown (negative)', async () => {
    useTestClock();
    mounted = await mountApp('/settings/layout');
    expect(mounted.wrapper.find('button[data-layout-lock]').exists()).toBe(false);
    expect(mounted.wrapper.text()).toContain('오늘이나 집중 화면을 한 번 연 뒤에 고정할 수 있어요.');
  });
});

describe('adaptive layout — invalid spec fallback (07 §2.1)', () => {
  it('rejects an invalid proposed spec and keeps the previous layout', async () => {
    useTestClock();
    const app = await openToday();
    const layout = useLayoutStore(app.pinia);
    const before = regionsOf(app.wrapper);
    const current = layout.current;
    if (current === null) throw new Error('no layout');
    const invalid = {
      ...current,
      regions: { ...current.regions, secondary: [{ component: 'HtmlBlock', props: { html: '<img src=x onerror=alert(1)>' } }] },
    };
    expect(layout.propose(invalid)).toBe(false);
    await settle();
    expect(regionsOf(app.wrapper)).toEqual(before);
    expect(document.body.innerHTML).not.toContain('onerror');
  });

  it('never renders an invalid spec even if one reaches the store', async () => {
    useTestClock();
    const app = await openToday();
    const layout = useLayoutStore(app.pinia);
    const state = layout.machine;
    if (state === null) throw new Error('no layout');
    const before = regionsOf(app.wrapper);
    layout.machine = {
      ...state,
      current: { ...state.current, mode: 'overview', pinned: ['NavRail'] as never },
    };
    await settle();
    expect(regionsOf(app.wrapper)).toEqual(before);
    expect(app.wrapper.find('.nav-rail').exists()).toBe(true);
    layout.machine = {
      ...state,
      current: {
        ...state.current,
        regions: { ...state.current.regions, primary: [{ component: 'Script' } as never] },
      },
    };
    await settle();
    expect(regionsOf(app.wrapper)).toEqual(before);
    expect(app.wrapper.findAll('.today-card').length).toBeGreaterThan(0);
  });
});
