<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { plannerClient, type Project, type Task } from '../api';
import { useOfflineStore } from '../stores/offline';
import LinkedNotesList from '../components/notes/LinkedNotesList.vue';
import TaskList from '../components/TaskList.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { useLinkedNotes } from '../composables/notes';
import { t, tp } from '../i18n';

const props = defineProps<{ id: string }>();

const route = useRoute();
const router = useRouter();
const offline = useOfflineStore();
const queryClient = useQueryClient();

const projectsQuery = useQuery({
  queryKey: ['projects'],
  queryFn: () => plannerClient.listProjects(),
});

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'project', props.id]),
  queryFn: () => plannerClient.listTasks({ projectId: props.id }),
});

const project = computed<Project | undefined>(() =>
  projectsQuery.data.value?.items.find((item) => item.id === props.id),
);
const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);

const heading = computed(() => {
  const current = project.value;
  if (current === undefined) return t('projects.fallbackTitle');
  return current.kind === 'inbox' ? t('nav.inbox') : current.title;
});

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}

// ── Tabs: 작업 | 노트 (07 §3.5 "작업 목록 + 노트 탭"), kept in `?tab=` ──
const TABS = ['tasks', 'notes'] as const;
type Tab = (typeof TABS)[number];
const tab = computed<Tab>(() => (route.query['tab'] === 'notes' ? 'notes' : 'tasks'));
const tabRefs = ref<Record<Tab, HTMLButtonElement | null>>({ tasks: null, notes: null });

function selectTab(next: Tab, focus = false): void {
  if (next !== tab.value) {
    const query = { ...route.query };
    if (next === 'tasks') delete query['tab'];
    else query['tab'] = next;
    void router.replace({ query });
  }
  if (focus) void nextTick(() => tabRefs.value[next]?.focus());
}

function onTabKeydown(event: KeyboardEvent): void {
  const index = TABS.indexOf(tab.value);
  let next: Tab | undefined;
  if (event.key === 'ArrowRight') next = TABS[(index + 1) % TABS.length];
  else if (event.key === 'ArrowLeft') next = TABS[(index + TABS.length - 1) % TABS.length];
  else if (event.key === 'Home') next = TABS[0];
  else if (event.key === 'End') next = TABS[TABS.length - 1];
  if (next === undefined) return;
  event.preventDefault();
  selectTab(next, true);
}

const notesQuery = useLinkedNotes(
  () => 'project',
  () => (tab.value === 'notes' ? props.id : null),
);
const notes = computed(() => notesQuery.data.value?.items ?? []);
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div class="page-heading">
        <p class="breadcrumb">
          <RouterLink to="/projects"><UiIcon name="arrow-left" :size="16" />{{ t('projects.back') }}</RouterLink>
        </p>
        <h1>{{ heading }}</h1>
        <p v-if="tasksQuery.data.value" class="page-lede">{{ tp('projects.taskCount', tasks.length) }}</p>
      </div>
    </header>

    <div class="tabs" role="tablist" :aria-label="t('projects.tabs.label')" data-project-tabs>
      <button
        v-for="item in TABS"
        :id="`project-tab-${item}`"
        :key="item"
        :ref="(el) => (tabRefs[item] = el as HTMLButtonElement | null)"
        type="button"
        role="tab"
        class="tab"
        :class="{ 'tab--active': tab === item }"
        :aria-selected="tab === item ? 'true' : 'false'"
        :aria-controls="`project-panel-${item}`"
        :tabindex="tab === item ? 0 : -1"
        :data-project-tab="item"
        @click="selectTab(item)"
        @keydown="onTabKeydown"
      >
        <UiIcon :name="item === 'tasks' ? 'check-circle' : 'note'" :size="18" />
        {{ t(`projects.tabs.${item}`) }}
      </button>
    </div>

    <div
      v-if="tab === 'tasks'"
      id="project-panel-tasks"
      role="tabpanel"
      aria-labelledby="project-tab-tasks"
      class="tab-panel"
      tabindex="0"
    >
      <div v-if="tasksQuery.isLoading.value">
        <p class="visually-hidden" role="status">{{ t('projects.tasksLoading') }}</p>
        <UiSkeleton variant="card" :count="3" :lines="1" />
      </div>
      <UiBanner v-else-if="tasksQuery.isError.value" tone="error" class="error-panel">
        <p class="error-text" role="alert">{{ t('projects.tasksLoadError') }}</p>
        <template #actions>
          <UiButton size="sm" icon="sync" @click="tasksQuery.refetch()">{{ t('common.retry') }}</UiButton>
        </template>
      </UiBanner>
      <TaskList
        v-else
        :tasks="tasks"
        :disabled="!offline.mutationsEnabled"
        :empty-text="t('projects.tasksEmpty')"
        @refresh="refresh"
      />
    </div>

    <div
      v-else
      id="project-panel-notes"
      role="tabpanel"
      aria-labelledby="project-tab-notes"
      class="tab-panel project-notes"
      tabindex="0"
      data-project-notes
    >
      <header class="note-section-header">
        <h2 class="card-title">{{ t('projects.notes.title') }}</h2>
        <RouterLink :to="`/notes/new?link=project:${props.id}`" class="btn btn--secondary btn--sm" data-project-new-note>
          <UiIcon name="plus" :size="16" /><span>{{ t('projects.notes.newNote') }}</span>
        </RouterLink>
      </header>
      <p class="muted">{{ t('projects.notes.lede') }}</p>
      <LinkedNotesList
        :notes="notes"
        :loading="notesQuery.isLoading.value"
        :failed="notesQuery.isError.value"
        :empty-text="t('projects.notes.empty')"
        :loading-text="t('projects.notes.loading')"
        :error-text="t('projects.notes.loadError')"
        :label="t('projects.notes.title')"
        @retry="notesQuery.refetch()"
      />
    </div>
  </section>
</template>
