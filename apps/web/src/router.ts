import { createRouter, createWebHistory, type RouteRecordRaw, type Router } from 'vue-router';
import AvailabilityView from './views/AvailabilityView.vue';
import CalendarSettingsView from './views/CalendarSettingsView.vue';
import CommitmentsView from './views/CommitmentsView.vue';
import FocusView from './views/FocusView.vue';
import InboxView from './views/InboxView.vue';
import LayoutSettingsView from './views/LayoutSettingsView.vue';
import LlmSettingsView from './views/LlmSettingsView.vue';
import LoginView from './views/LoginView.vue';
import MonthView from './views/MonthView.vue';
import OverviewView from './views/OverviewView.vue';
import PlanComparisonView from './views/PlanComparisonView.vue';
import PlanNewView from './views/PlanNewView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import ProjectListView from './views/ProjectListView.vue';
import PlanningWizardView from './views/PlanningWizardView.vue';
import PatternsView from './views/PatternsView.vue';
import ReplanListView from './views/ReplanListView.vue';
import ReplanProposalView from './views/ReplanProposalView.vue';
import TaskDetailView from './views/TaskDetailView.vue';
import TodayView from './views/TodayView.vue';
import { currentOwnerId, isPageSealed } from './session/ownerEpoch';

const NotesView = () => import('./views/NotesView.vue');

/** The app's route table (exported so tests can mount it on a memory history). */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/inbox' },
  { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },
  // HOLO-01: the dashboard. `/` still lands on the inbox (E2E pins that
  // landing); the brand link and the `o` key open this.
  { path: '/overview', name: 'overview', component: OverviewView },
  { path: '/inbox', name: 'inbox', component: InboxView },
  { path: '/projects', name: 'projects', component: ProjectListView },
  { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
  { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
  { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
  { path: '/today', name: 'today', component: TodayView },
  // CAL-01: the month page; the month is in the query (`?m=2026-11`).
  { path: '/month', name: 'month', component: MonthView },
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
  { path: '/plans/new', name: 'plans-new', component: PlanNewView },
  { path: '/plans/:id', name: 'plan', component: PlanComparisonView, props: true },
  { path: '/replan', name: 'replan', component: ReplanListView },
  { path: '/replan/:id', name: 'replan-proposal', component: ReplanProposalView, props: true },
  { path: '/patterns', name: 'patterns', component: PatternsView },
  { path: '/:pathMatch(.*)*', redirect: '/inbox' },
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
