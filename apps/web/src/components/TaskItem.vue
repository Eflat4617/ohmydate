<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import type { Task } from '../api';

const props = defineProps<{ task: Task; disabled?: boolean }>();
const emit = defineEmits<{ rename: [title: string]; complete: []; remove: [] }>();

const editing = ref(false);
const draft = ref('');
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

async function startEdit(): Promise<void> {
  if (props.disabled === true) return;
  draft.value = props.task.title;
  editing.value = true;
  await nextTick();
  editInput.value?.focus();
  editInput.value?.select();
}

function cancelEdit(): void {
  editing.value = false;
  draft.value = '';
}

function saveEdit(): void {
  const value = draft.value.trim();
  if (value.length === 0 || value === props.task.title) {
    cancelEdit();
    return;
  }
  emit('rename', value);
  editing.value = false;
}
</script>

<template>
  <li class="task-item" :class="{ 'task-item--done': isDone }">
    <template v-if="editing">
      <form class="inline-edit" @submit.prevent="saveEdit">
        <label :for="`task-title-${task.id}`">Task title</label>
        <input
          :id="`task-title-${task.id}`"
          ref="editInput"
          v-model="draft"
          type="text"
          maxlength="200"
          @keydown.esc.prevent="cancelEdit"
        />
        <button type="submit" class="primary-action" :disabled="draft.trim().length === 0">Save</button>
        <button type="button" @click="cancelEdit">Cancel</button>
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
          :disabled="disabled"
          @click="startEdit"
        >
          Edit
        </button>
        <button
          type="button"
          :aria-label="`Mark ${task.title} complete`"
          :disabled="disabled || isDone"
          @click="emit('complete')"
        >
          {{ isDone ? 'Completed' : 'Complete' }}
        </button>
        <button
          type="button"
          class="danger"
          :aria-label="`Delete ${task.title}`"
          :disabled="disabled"
          @click="emit('remove')"
        >
          Delete
        </button>
      </div>
    </template>
  </li>
</template>
