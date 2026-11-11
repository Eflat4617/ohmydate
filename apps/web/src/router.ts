import { createRouter, createWebHistory } from 'vue-router';
import AvailabilityView from './views/AvailabilityView.vue';
import CommitmentsView from './views/CommitmentsView.vue';
import InboxView from './views/InboxView.vue';
import LoginView from './views/LoginView.vue';
import PlanComparisonView from './views/PlanComparisonView.vue';
import PlanNewView from './views/PlanNewView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import ProjectListView from './views/ProjectListView.vue';
import PlanningWizardView from './views/PlanningWizardView.vue';
import TodayView from './views/TodayView.vue';

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/inbox' },
    { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },
    { path: '/inbox', name: 'inbox', component: InboxView },
    { path: '/projects', name: 'projects', component: ProjectListView },
    { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
    { path: '/plan/new', name: 'plan-new', component: PlanningWizardView },
    { path: '/plan/:sessionId', name: 'plan-session', component: PlanningWizardView, props: true },
    { path: '/today', name: 'today', component: TodayView },
    { path: '/commitments', name: 'commitments', component: CommitmentsView },
    { path: '/settings/availability', name: 'availability', component: AvailabilityView },
    { path: '/plans/new', name: 'plans-new', component: PlanNewView },
    { path: '/plans/:id', name: 'plan', component: PlanComparisonView, props: true },
    { path: '/:pathMatch(.*)*', redirect: '/inbox' },
  ],
});
