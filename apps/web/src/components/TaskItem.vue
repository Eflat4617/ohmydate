<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { Task } from '../api';

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

const isDone = computed(() => props.task.status === 'done');
const statusLabel = computed(() => {
  switch (props.task.status) {
    case 'done':
      return 'Done';
    case 'in_progress':
      return 'In progress';
    default:
      return 'To do';
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
  <li class="task-item" :class="{ 'task-item--done': isDone }">
    <template v-if="editing">
      <form class="inline-edit" @submit.prevent="emit('save')">
        <label :for="`task-title-${task.id}`">Task title</label>
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
        <button
          type="submit"
          class="primary-action"
          :disabled="locked || draft.trim().length === 0"
        >
          Save
        </button>
        <button type="button" :disabled="locked" @click="emit('cancel')">Cancel</button>
      </form>
    </template>
    <template v-else>
      <div class="task-main">
        <span class="task-title">{{ task.title }}</span>
        <span class="task-status" :data-status="task.status">{{ statusLabel }}</span>
      </div>
      <div class="task-actions">
        <button
          type="button"
          :aria-label="`Edit title of ${task.title}`"
          :disabled="locked"
          @click="emit('start-edit')"
        >
          Edit
        </button>
        <button
          type="button"
          :aria-label="`Mark ${task.title} complete`"
          :disabled="locked || isDone"
          @click="emit('complete')"
        >
          {{ isDone ? 'Completed' : 'Complete' }}
        </button>
        <button
          type="button"
          class="danger"
          :aria-label="`Delete ${task.title}`"
          :disabled="locked"
          @click="emit('remove')"
        >
          Delete
        </button>
      </div>
    </template>
  </li>
</template>
