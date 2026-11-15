import { createRouter, createWebHistory, type RouteRecordRaw, type Router } from 'vue-router';
import AvailabilityView from './views/AvailabilityView.vue';
import CalendarSettingsView from './views/CalendarSettingsView.vue';
import CommitmentsView from './views/CommitmentsView.vue';
import FocusView from './views/FocusView.vue';
import InboxView from './views/InboxView.vue';
import LayoutSettingsView from './views/LayoutSettingsView.vue';
import LlmSettingsView from './views/LlmSettingsView.vue';
import LoginView from './views/LoginView.vue';
import OverviewView from './views/OverviewView.vue';
import PlanScheduleView from './views/PlanScheduleView.vue';
import PlanScopeView from './views/PlanScopeView.vue';
import PlannerView from './views/PlannerView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import ProjectListView from './views/ProjectListView.vue';
import PlanningWizardView from './views/PlanningWizardView.vue';
import PatternsView from './views/PatternsView.vue';
import ReplanListView from './views/ReplanListView.vue';
import ReplanProposalView from './views/ReplanProposalView.vue';
import TaskDetailView from './views/TaskDetailView.vue';
import TodayView from './views/TodayView.vue';
import TrackerView from './views/TrackerView.vue';
import { currentOwnerId, isPageSealed } from './session/ownerEpoch';

const NotesView = () => import('./views/NotesView.vue');

/** The app's route table (exported so tests can mount it on a memory history). */
export const routes: RouteRecordRaw[] = [
  // HOLO-02: the app opens on 개요, the dashboard. (Signing in still goes to
  // the inbox by name — LoginView — and an owner reset reloads to the inbox:
  // session/ownerEpoch.ts.)
  { path: '/', redirect: '/overview' },
  { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },
  // HOLO-01: the dashboard; the brand link and the `o` key open it too.
  { path: '/overview', name: 'overview', component: OverviewView },
  { path: '/inbox', name: 'inbox', component: InboxView },
  { path: '/projects', name: 'projects', component: ProjectListView },
  { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
  { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
  { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
  { path: '/today', name: 'today', component: TodayView },
  // HOLO-02: the timer card and the week's focus sessions.
  { path: '/tracker', name: 'tracker', component: TrackerView },
  // HOLO-02: 플래너, the calendar screen with three views (`?view=day|week|month`,
  // 주 by default; the day, week or month is in the query too).
  { path: '/planner', name: 'planner', component: PlannerView },
  // CAL-01: the month page; the month is in the query (`?m=2026-11`). It is
  // the planner's 월 view and stays a valid address.
  { path: '/month', name: 'month', component: PlannerView },
  { path: '/focus/:sessionId', name: 'focus', component: FocusView, props: true },
  { path: '/commitments', name: 'commitments', component: CommitmentsView },
  { path: '/settings/availability', name: 'availability', component: AvailabilityView },
  { path: '/settings/ai', name: 'ai-settings', component: LlmSettingsView },
  { path: '/settings/layout', name: 'layout-settings', component: LayoutSettingsView },
  // CAL-04: Google Calendar (the OAuth callback comes back here with ?google=…).
  { path: '/settings/calendar', name: 'calendar-settings', component: CalendarSettingsView },
  // M6-03 notes workspace: one view for the list, a new note and an open note.
  // Loaded on demand, so the Markdown parser stays out of the main bundle.
  { path: '/notes', name: 'notes', component: NotesView },
  { path: '/notes/new', name: 'notes-new', component: NotesView },
  { path: '/notes/:id', name: 'notes-detail', component: NotesView },
  { path: '/tasks/:id', name: 'task', component: TaskDetailView, props: true },
  // HOLO-03A: 계획 세우기 is one flow. What goes into the schedules
  // (`?goalId`, `?taskIds`; `?session` names the planning session it came
  // from), then the three schedules of a plan and its confirmation.
  { path: '/plan/schedule', name: 'plan-scope', component: PlanScopeView },
  { path: '/plan/schedule/:id', name: 'plan-schedule', component: PlanScheduleView, props: true },
  // The addresses these screens had before HOLO-03A.
  { path: '/plans/new', redirect: (to) => ({ name: 'plan-scope', query: to.query }) },
  { path: '/plans/:id', redirect: (to) => ({ name: 'plan-schedule', params: { id: to.params['id'] }, query: to.query }) },
  { path: '/replan', name: 'replan', component: ReplanListView },
  { path: '/replan/:id', name: 'replan-proposal', component: ReplanProposalView, props: true },
  { path: '/patterns', name: 'patterns', component: PatternsView },
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
