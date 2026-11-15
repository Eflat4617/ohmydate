<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { t } from '../i18n';
import UiIcon from '../components/ui/UiIcon.vue';
import InboxView from './InboxView.vue';
import ProjectListView from './ProjectListView.vue';

/**
 * 할 일 (HOLO-04, FLOW.md §4): everything put down, as ONE place. For now it
 * holds the two screens that were 인박스 and 프로젝트 as two views of it, picked
 * in the address (`/tasks`, `/tasks?view=projects`).
 *
 * This file is the mount point: HOLO-05 replaces what is inside it (a canvas
 * of to-dos and folders). The route name `tasks`, the address and the
 * `data-tasks-place` root stay.
 */
const route = useRoute();
const view = computed<'inbox' | 'projects'>(() => (route.query['view'] === 'projects' ? 'projects' : 'inbox'));

const VIEWS = [
  { id: 'inbox', label: 'tasks.views.inbox', icon: 'inbox', to: { name: 'tasks' } },
  { id: 'projects', label: 'tasks.views.projects', icon: 'projects', to: { name: 'tasks', query: { view: 'projects' } } },
] as const;
</script>

<template>
  <div class="tasks-place" data-tasks-place :data-tasks-view="view">
    <div class="tasks-place-head">
    <nav class="segmented glass glass--still glass--flat tasks-views" :aria-label="t('tasks.views.label')">
      <RouterLink
        v-for="item in VIEWS"
        :key="item.id"
        :to="item.to"
        class="btn segmented-item"
        :aria-current="view === item.id ? 'page' : undefined"
        :data-tasks-view-link="item.id"
      >
        <UiIcon :name="item.icon" :size="16" />
        {{ t(item.label) }}
      </RouterLink>
    </nav>
      <!-- ① → ②: what was put down goes on to the plan, picked there (FLOW §5). -->
      <RouterLink class="btn btn--sm tasks-to-plan" to="/plan/schedule" data-tasks-to-plan>
        <UiIcon name="plan" :size="16" class="btn-icon" />{{ t('tasks.toPlan') }}
      </RouterLink>
    </div>
    <InboxView v-if="view === 'inbox'" />
    <ProjectListView v-else />
  </div>
</template>
