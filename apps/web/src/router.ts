import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import AvailabilityView from './views/AvailabilityView.vue';
import CommitmentsView from './views/CommitmentsView.vue';
import FocusView from './views/FocusView.vue';
import InboxView from './views/InboxView.vue';
import LayoutSettingsView from './views/LayoutSettingsView.vue';
import LlmSettingsView from './views/LlmSettingsView.vue';
import LoginView from './views/LoginView.vue';
import NotesView from './views/NotesView.vue';
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

/** The app's route table (exported so tests can mount it on a memory history). */
export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/inbox' },
  { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },
  { path: '/inbox', name: 'inbox', component: InboxView },
  { path: '/projects', name: 'projects', component: ProjectListView },
  { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
  { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
  { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
  { path: '/today', name: 'today', component: TodayView },
  { path: '/focus/:sessionId', name: 'focus', component: FocusView, props: true },
  { path: '/commitments', name: 'commitments', component: CommitmentsView },
  { path: '/settings/availability', name: 'availability', component: AvailabilityView },
  { path: '/settings/ai', name: 'ai-settings', component: LlmSettingsView },
  { path: '/settings/layout', name: 'layout-settings', component: LayoutSettingsView },
  // M6-03 notes workspace: one view for the list, a new note and an open note.
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
