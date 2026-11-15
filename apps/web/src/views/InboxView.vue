<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { ActionStore, findInboxProject, plannerClient, type Task } from '../api';
import { useTaskActions } from '../composables/useTaskActions';
import { runOwnerBound } from '../session/ownerBound';
import { useOfflineStore } from '../stores/offline';
import QuickAddForm from '../components/QuickAddForm.vue';
import TaskList from '../components/TaskList.vue';
import TaskParseSection from '../components/TaskParseSection.vue';
import { browserTimeZone } from '../i18n/format';
import { useAuthStore } from '../stores/auth';
import UiBadge from '../components/ui/UiBadge.vue';
import UiBanner from '../components/ui/UiBanner.vue';
import UiButton from '../components/ui/UiButton.vue';
import UiIcon from '../components/ui/UiIcon.vue';
import UiSkeleton from '../components/ui/UiSkeleton.vue';
import { t, tp } from '../i18n';

const offline = useOfflineStore();
const auth = useAuthStore();
const queryClient = useQueryClient();
const quickAdd = ref<InstanceType<typeof QuickAddForm> | null>(null);
const {
  create,
  busy: createBusy,
  error: createError,
} = useTaskActions(plannerClient, new ActionStore(), () => offline.online);

const inboxQuery = useQuery({
  queryKey: ['projects', 'inbox'],
  queryFn: () => findInboxProject(plannerClient),
});

const inboxProject = computed(() => inboxQuery.data.value ?? undefined);
const inboxProjectId = computed(() => inboxProject.value?.id);
const inboxMissing = computed(
  () => inboxQuery.isSuccess.value && inboxQuery.data.value === null,
);

const tasksQuery = useQuery({
  queryKey: computed(() => ['tasks', 'inbox', inboxProjectId.value ?? 'missing']),
  queryFn: () => {
    const projectId = inboxProjectId.value;
    if (projectId === undefined) throw new Error('Inbox project is missing');
    return plannerClient.listTasks({ projectId });
  },
  enabled: computed(() => inboxProjectId.value !== undefined),
});

const tasks = computed<Task[]>(() => tasksQuery.data.value?.items ?? []);
const isLoading = computed(
  () =>
    inboxQuery.isLoading.value ||
    (inboxProjectId.value !== undefined && tasksQuery.isLoading.value),
);
const isError = computed(() => inboxQuery.isError.value || tasksQuery.isError.value);
const openCount = computed(() => tasks.value.filter((task) => task.status !== 'done').length);
const quickAddDisabled = computed(
  () => !offline.mutationsEnabled || createBusy.value,
);

/**
 * CAL-05: the zone 말로 적기 reads deadlines in — the one the task detail
 * shows `dueAt` in. One filled button on the page: the quick add while it has
 * text, otherwise 말로 적기's next step when it has one, otherwise the quick add.
 */
const timeZone = computed(() => auth.user?.timeZone ?? browserTimeZone());
const quickAddFilled = ref(false);
const parseWantsPrimary = ref(false);
const quickAddPrimary = computed(() => quickAddFilled.value || !parseWantsPrimary.value);

async function refetchAll(): Promise<void> {
  const pending: Promise<unknown>[] = [inboxQuery.refetch()];
  if (inboxProjectId.value !== undefined) pending.push(tasksQuery.refetch());
  await Promise.all(pending);
}

// Owner isolation (ADR-023): clearing the form and refreshing the lists is
// part of the action, so it runs as an owner-bound task — after a user switch
// the form of the next user is not touched.
async function addTask(title: string): Promise<void> {
  if (!offline.mutationsEnabled) return;
  await runOwnerBound(function* (owner) {
    try {
      yield* owner.wait(create(title));
      quickAdd.value?.clear();
      yield* owner.wait(queryClient.invalidateQueries({ queryKey: ['tasks'] }));
      yield* owner.wait(queryClient.invalidateQueries({ queryKey: ['projects'] }));
    } catch {
      // `createError` carries the user-facing message and the form keeps its text.
    }
  });
}

async function refresh(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['tasks'] });
}
</script>

<template>
  <!-- HOLO-05: the inbox as rows — the first section of 할 일's list view (TodoListView). -->
  <section class="todo-list-section inbox-page" aria-labelledby="inbox-title" data-inbox>
    <header class="todo-list-head">
      <div class="todo-list-heading">
        <h2 id="inbox-title" class="todo-list-title">{{ t('inbox.title') }}</h2>
        <p class="page-lede">{{ t('inbox.lede') }}</p>
      </div>
      <div class="page-actions">
        <UiBadge v-if="!offline.mutationsEnabled" tone="offline" dot class="offline-note" role="status">
          {{ t('common.readOnlyOffline') }}
        </UiBadge>
        <UiBadge v-else-if="openCount > 0" tone="outline">{{ tp('inbox.openCount', openCount) }}</UiBadge>
      </div>
    </header>

    <!-- The quick add is the top field; 말로 적기 is folded under one disclosure. -->
    <div class="card inbox-add">
      <QuickAddForm
        ref="quickAdd"
        :disabled="quickAddDisabled"
        :primary="quickAddPrimary"
        @submit="addTask"
        @filled-change="quickAddFilled = $event"
      />
      <UiBanner v-if="createError" tone="error" role="alert">{{ createError }}</UiBanner>
      <details class="inbox-fold" data-task-parse-fold>
        <summary class="inbox-fold-summary">
          <UiIcon name="chevron-down" :size="16" class="inbox-fold-icon" />
          {{ t('inbox.parseFold') }}
        </summary>
        <TaskParseSection
          :quick-add-active="quickAddFilled"
          :time-zone="timeZone"
          @primary-change="parseWantsPrimary = $event"
        />
      </details>
    </div>

    <div v-if="isLoading" class="list-loading">
      <p class="visually-hidden" role="status">{{ t('inbox.loading') }}</p>
      <UiSkeleton variant="card" :count="3" :lines="1" />
    </div>
    <UiBanner v-else-if="isError" tone="error" class="error-panel">
      <p class="error-text" role="alert">{{ t('inbox.loadError') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetchAll()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <UiBanner v-else-if="inboxMissing" tone="warn" class="error-panel">
      <p class="error-text" role="alert">{{ t('inbox.missing') }}</p>
      <template #actions>
        <UiButton size="sm" icon="sync" @click="refetchAll()">{{ t('common.retry') }}</UiButton>
      </template>
    </UiBanner>
    <TaskList
      v-else
      :tasks="tasks"
      :disabled="!offline.mutationsEnabled"
      :empty-text="t('inbox.empty')"
      @refresh="refresh"
    />
  </section>
</template>
