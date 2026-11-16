import { createRouter, createWebHistory, type RouteLocation, type RouteRecordRaw, type Router } from 'vue-router';
import FocusView from './views/FocusView.vue';
import LoginView from './views/LoginView.vue';
import OverviewView from './views/OverviewView.vue';
import PlanScheduleView from './views/PlanScheduleView.vue';
import PlanScopeView from './views/PlanScopeView.vue';
import PlannerView from './views/PlannerView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import PlanView from './views/PlanView.vue';
import InsightsView from './views/InsightsView.vue';
import ReplanView from './views/ReplanView.vue';
import SettingsView from './views/SettingsView.vue';
import TaskDetailView from './views/TaskDetailView.vue';
import TasksView from './views/TasksView.vue';
import TrackerView from './views/TrackerView.vue';
import { SETTINGS_SECTIONS } from './domain/settings';
import { currentOwnerId, isPageSealed } from './session/ownerEpoch';

const NotesView = () => import('./views/NotesView.vue');

/** An old address goes to its new home with whatever it carried in the query. */
function movedTo(name: string, query: Record<string, string> = {}, params: Record<string, string> = {}) {
  return (to: RouteLocation) => ({ name, params, query: { ...to.query, ...query } });
}

/**
 * The app's route table (exported so tests can mount it on a memory history).
 *
 * HOLO-04 (FLOW.md §4): the places are the loop — 개요, 할 일, 계획, 플래너,
 * 집중, 분석, 노트 — and 설정. Every address an earlier version had still
 * opens: it redirects to where that screen lives now.
 */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/overview' },
  { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },

  // 개요: what to do now, today's blocks, the week. (오늘 lives here.)
  { path: '/overview', name: 'overview', component: OverviewView },
  { path: '/today', redirect: movedTo('overview') },

  // 할 일 (HOLO-05): everything put down, as one place — a canvas of floating
  // to-dos with folders on it, or the same things as rows (`?view=list`).
  { path: '/tasks', name: 'tasks', component: TasksView },
  { path: '/tasks/:id', name: 'task', component: TaskDetailView, props: true },
  { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
  { path: '/inbox', redirect: movedTo('tasks') },
  // The project list is gone: a project is a folder on the canvas.
  { path: '/projects', redirect: movedTo('tasks') },

  // 계획: one flow — 목표 (`/plan`), 질문 and 단계 of a planning session, then
  // what goes into the schedules (`?goalId`, `?taskIds`; `?session` names the
  // planning session it came from), the three schedules and their confirmation.
  { path: '/plan', name: 'plan', component: PlanView },
  { path: '/plan/new', redirect: '/plan' },
  { path: '/plan/schedule', name: 'plan-scope', component: PlanScopeView },
  { path: '/plan/schedule/:id', name: 'plan-schedule', component: PlanScheduleView, props: true },
  { path: '/plan/:sessionId', name: 'plan-session', component: PlanView, props: true },
  { path: '/plans/new', redirect: (to) => ({ name: 'plan-scope', query: to.query }) },
  { path: '/plans/:id', redirect: (to) => ({ name: 'plan-schedule', params: { id: to.params['id'] }, query: to.query }) },
  // 다시 맞추기 belongs to 계획: the proposal on show beside the list of them all.
  { path: '/replan', name: 'replan', component: ReplanView },
  { path: '/replan/:id', name: 'replan-proposal', component: ReplanView, props: true },

  // 플래너: 일 · 주 · 월 · 약속 (`?view=day|week|month|list`, 주 by default; the
  // day, week or month is in the query too). `/month` is its 월 view (CAL-01).
  { path: '/planner', name: 'planner', component: PlannerView },
  { path: '/month', name: 'month', component: PlannerView },
  { path: '/commitments', redirect: movedTo('planner', { view: 'list' }) },

  // 집중: the timer and its record at `/focus`, one session at `/focus/:id`.
  { path: '/focus', name: 'focus-home', component: TrackerView },
  { path: '/focus/:sessionId', name: 'focus', component: FocusView, props: true },
  { path: '/tracker', redirect: movedTo('focus-home') },

  // 분석 (was 내 패턴 at /patterns).
  { path: '/insights', name: 'insights', component: InsightsView },
  { path: '/patterns', redirect: '/insights' },

  // 노트: one view for the list, a new note and an open note. Loaded on
  // demand, so the Markdown parser stays out of the main bundle.
  { path: '/notes', name: 'notes', component: NotesView },
  { path: '/notes/new', name: 'notes-new', component: NotesView },
  { path: '/notes/:id', name: 'notes-detail', component: NotesView },

  // 설정: one screen, four sections. The section is in the address, so the
  // addresses of 가용 시간, 캘린더 연동 (the Google sign-in comes back to it
  // with `?google=…`) and AI are the ones they always had.
  {
    path: `/settings/:section(${SETTINGS_SECTIONS.join('|')})?`,
    name: 'settings',
    component: SettingsView,
  },
  { path: '/settings/layout', redirect: movedTo('settings', {}, { section: 'display' }) },

  // An address the app does not know opens the dashboard.
  { path: '/:pathMatch(.*)*', redirect: '/overview' },
];

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

/**
 * ADR-023 guardrail: a page that is being hard-reset for another user does
 * not navigate any more. The reload itself picks the next location
 * (session/ownerEpoch.ts), so a late continuation cannot move the new user.
 */
export function refuseNavigationWhenSealed(target: Router): void {
  target.beforeEach(() => !isPageSealed());
}

/**
 * A navigation belongs to the user who started it (ADR-023 guardrail). It is
 * asynchronous — guards, lazily loaded screens — so one that user A starts can
 * otherwise complete after user B signed in, and leave B on A's address. The
 * owner is noted when `push` / `replace` is CALLED (in the caller's turn) and
 * checked again right before the navigation is confirmed.
 *
 * Owner ids are compared, not epochs: a navigation that began before the
 * owner was known (the first one, while `/me` is still loading) is allowed to
 * finish for the owner it turns out to be.
 */
export function bindNavigationsToOwner(target: Router): void {
  // Owners of push/replace calls whose navigation has not reached a guard yet.
  const started: (string | null)[] = [];
  const owners = new WeakMap<object, string | null>();
  for (const method of ['push', 'replace'] as const) {
    const navigate = target[method].bind(target);
    target[method] = (to) => {
      const owner = currentOwnerId();
      started.push(owner);
      const result = navigate(to);
      // A navigation that never reached a guard (a duplicate) must not leave its entry behind.
      const forget = (): void => {
        const index = started.indexOf(owner);
        if (index !== -1) started.splice(index, 1);
      };
      void result.then(forget, forget);
      return result;
    };
  }
  target.beforeEach((to) => {
    // A redirect continues the navigation it came from; history moves (back,
    // forward, the first load) start here.
    const inherited = to.redirectedFrom === undefined ? undefined : owners.get(to.redirectedFrom);
    owners.set(to, inherited !== undefined ? inherited : started.length > 0 ? (started.shift() ?? null) : currentOwnerId());
  });
  target.beforeResolve((to) => {
    const owner = owners.get(to);
    return owner === undefined || owner === null || owner === currentOwnerId();
  });
}

refuseNavigationWhenSealed(router);
bindNavigationsToOwner(router);
