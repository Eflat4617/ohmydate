<script setup lang="ts">
import { computed } from 'vue';
import type { ConflictOperation } from '../composables/useTaskActions';
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiIcon from './ui/UiIcon.vue';

const props = withDefaults(
  defineProps<{
    serverVersion: number;
    serverTitle: string;
    localTitle?: string | null;
    operation?: ConflictOperation;
    disabled?: boolean;
    busy?: boolean;
  }>(),
  { localTitle: null, operation: 'rename', disabled: false, busy: false },
);

const emit = defineEmits<{ reload: []; overwrite: []; cancel: [] }>();

const heading = computed(() => {
  switch (props.operation) {
    case 'complete':
      return 'This task changed before completion';
    case 'delete':
      return 'This task changed before deletion';
    default:
      return 'This task changed elsewhere';
  }
});

const overwriteLabel = computed(() => {
  switch (props.operation) {
    case 'complete':
      return 'Complete anyway';
    case 'delete':
      return 'Delete anyway';
    default:
      return 'Overwrite with my edit';
  }
});

const cancelLabel = computed(() => (props.operation === 'rename' ? 'Keep editing' : 'Cancel'));
</script>

<template>
  <!-- FU-09: focus trap, Escape = Keep editing, inert editor and global-shortcut
       isolation all come from UiDialog. -->
  <UiDialog
    labelledby="conflict-title"
    describedby="conflict-detail"
    class="conflict-dialog"
    @close="emit('cancel')"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
      <div class="dialog-heading">
        <h2 id="conflict-title" class="dialog-title">{{ heading }}</h2>
        <p id="conflict-detail" class="muted">
          The server has version <strong>{{ serverVersion }}</strong
          >. Your change was based on an older version.
        </p>
      </div>
    </header>
    <dl class="conflict-summary">
      <template v-if="operation === 'rename'">
        <dt>Server title</dt>
        <dd>{{ serverTitle }}</dd>
        <dt>Your edit</dt>
        <dd>{{ localTitle ?? '' }}</dd>
      </template>
      <template v-else>
        <dt>Server title</dt>
        <dd>{{ serverTitle }}</dd>
        <dt>Your change</dt>
        <dd>{{ operation === 'complete' ? 'Mark as complete' : 'Delete this task' }}</dd>
      </template>
    </dl>
    <p class="muted">Reload keeps the server version. Overwrite re-fetches and re-applies your change.</p>
    <div class="dialog-actions dialog-actions--start" :aria-busy="busy ? 'true' : undefined">
      <UiButton
        variant="primary"
        data-autofocus
        :disabled="disabled || busy"
        @click="emit('reload')"
      >
        Reload server version
      </UiButton>
      <UiButton :disabled="disabled || busy" @click="emit('overwrite')">
        {{ overwriteLabel }}
      </UiButton>
      <UiButton variant="ghost" @click="emit('cancel')">
        {{ cancelLabel }}
      </UiButton>
    </div>
  </UiDialog>
</template>
