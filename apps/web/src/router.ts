import { createRouter, createWebHistory } from 'vue-router';
import InboxView from './views/InboxView.vue';
import LoginView from './views/LoginView.vue';
import ProjectDetailView from './views/ProjectDetailView.vue';
import ProjectListView from './views/ProjectListView.vue';
import TodayView from './views/TodayView.vue';

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/inbox' },
    { path: '/login', name: 'login', component: LoginView, meta: { layout: 'blank' } },
    { path: '/inbox', name: 'inbox', component: InboxView },
    { path: '/projects', name: 'projects', component: ProjectListView },
    { path: '/projects/:id', name: 'project', component: ProjectDetailView, props: true },
    { path: '/today', name: 'today', component: TodayView },
    { path: '/:pathMatch(.*)*', redirect: '/inbox' },
  ],
});
