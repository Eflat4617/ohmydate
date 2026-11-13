<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { RouterLink, routerKey } from 'vue-router';
import { getActivePinia } from 'pinia';
import type { Task } from '../api';
import UiBadge from './ui/UiBadge.vue';
import UiButton from './ui/UiButton.vue';
import UiIcon from './ui/UiIcon.vue';
import { t } from '../i18n';
import { browserTimeZone, formatDateTime } from '../i18n/format';
import { useAuthStore } from '../stores/auth';

const props = withDefaults(
  defineProps<{
    task: Task;
    disabled?: boolean;
    pending?: boolean;
    editing?: boolean;
    draft?: string;
    focusNonce?: number;
  }>(),
  { disabled: false, pending: false, editing: false, draft: '', focusNonce: 0 },
);

const emit = defineEmits<{
  'start-edit': [];
  'update:draft': [value: string];
  save: [];
  cancel: [];
  complete: [];
  remove: [];
}>();

const editInput = ref<HTMLInputElement | null>(null);
// The title opens the task detail (linked notes, "설명을 노트로 승격") when a
// router is installed; isolated mounts (component tests) keep plain text.
const hasRouter = inject(routerKey, null) !== null;

const isDone = computed(() => props.task.status === 'done');

// CAL-05: the deadline, in the user's zone like the task detail (isolated
// mounts without a store fall back to the browser's zone).
const auth = getActivePinia() === undefined ? null : useAuthStore();
const dueText = computed(() => {
  const dueAt = props.task.dueAt;
  if (dueAt === undefined) return null;
  return t('task.due', { when: formatDateTime(dueAt, auth?.user?.timeZone ?? browserTimeZone()) });
});
const overdue = computed(
  () => !isDone.value && props.task.dueAt !== undefined && Date.parse(props.task.dueAt) < Date.now(),
);
const statusLabel = computed(() => {
  switch (props.task.status) {
    case 'done':
      return t('task.status.done');
    case 'in_progress':
      return t('task.status.in_progress');
    default:
      return t('task.status.todo');
  }
});

const statusTone = computed(() => {
  switch (props.task.status) {
    case 'done':
      return 'success' as const;
    case 'in_progress':
      return 'info' as const;
    default:
      return 'neutral' as const;
  }
});

const locked = computed(() => props.disabled || props.pending);

async function focusEditor(): Promise<void> {
  await nextTick();
  editInput.value?.focus();
  editInput.value?.select();
}

watch(
  () => props.editing,
  (editing) => {
    if (editing) void focusEditor();
  },
);

watch(
  () => props.focusNonce,
  () => {
    if (props.editing) void focusEditor();
  },
);

function onInput(event: Event): void {
  emit('update:draft', (event.target as HTMLInputElement).value);
}
</script>

<template>
  <li class="task-item" :class="{ 'task-item--done': isDone, 'task-item--editing': editing }">
    <template v-if="editing">
      <form class="inline-edit" @submit.prevent="emit('save')">
        <label :for="`task-title-${task.id}`" class="field-label">{{ t('task.titleLabel') }}</label>
        <div class="inline-edit-row">
          <input
            :id="`task-title-${task.id}`"
            ref="editInput"
            :value="draft"
            type="text"
            maxlength="200"
            :disabled="locked"
            @input="onInput"
            @keydown.esc.prevent="emit('cancel')"
          />
          <div class="inline-edit-actions">
            <UiButton
              type="submit"
              variant="primary"
              size="sm"
              :disabled="locked || draft.trim().length === 0"
            >
              {{ t('common.save') }}
            </UiButton>
            <UiButton variant="ghost" size="sm" :disabled="locked" @click="emit('cancel')">{{ t('common.cancel') }}</UiButton>
          </div>
        </div>
      </form>
    </template>
    <template v-else>
      <span class="task-mark" :class="{ 'task-mark--done': isDone }" aria-hidden="true">
        <UiIcon v-if="isDone" name="check" :size="10" />
      </span>
      <div class="task-main">
        <RouterLink v-if="hasRouter" :to="`/tasks/${task.id}`" class="task-title task-title-link" data-task-detail-link>
          {{ task.title }}
        </RouterLink>
        <span v-else class="task-title">{{ task.title }}</span>
        <UiBadge class="task-status" :tone="statusTone" :data-status="task.status">{{ statusLabel }}</UiBadge>
        <span v-if="dueText" class="task-due tabular" data-testid="task-due">
          {{ dueText }}<UiBadge v-if="overdue" tone="warn" class="task-due-overdue">{{ t('task.overdue') }}</UiBadge>
        </span>
      </div>
      <div class="task-actions">
        <UiButton
          variant="ghost"
          size="sm"
          icon="edit"
          class="task-action--edit"
          :aria-label="t('task.editAria', { title: task.title })"
          :disabled="locked"
          @click="emit('start-edit')"
        >
          <span class="task-action-label">{{ t('task.edit') }}</span>
        </UiButton>
        <UiButton
          variant="ghost"
          size="sm"
          icon="check"
          class="task-action--complete"
          :aria-label="t('task.completeAria', { title: task.title })"
          :disabled="locked || isDone"
          @click="emit('complete')"
        >
          <span class="task-action-label">{{ isDone ? t('task.completed') : t('task.complete') }}</span>
        </UiButton>
        <UiButton
          variant="danger-ghost"
          size="sm"
          icon="trash"
          class="danger task-action--delete"
          :aria-label="t('task.deleteAria', { title: task.title })"
          :disabled="locked"
          @click="emit('remove')"
        >
          <span class="task-action-label">{{ t('task.delete') }}</span>
        </UiButton>
      </div>
    </template>
  </li>
</template>
