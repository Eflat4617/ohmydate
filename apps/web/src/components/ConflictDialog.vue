<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { ConflictOperation } from '../composables/useTaskActions';

const props = withDefaults(
  defineProps<{
    serverVersion: number;
    serverTitle: string;
    localTitle?: string | null;
    operation?: ConflictOperation;
    disabled?: boolean;
  }>(),
  { localTitle: null, operation: 'rename', disabled: false },
);

const emit = defineEmits<{ reload: []; overwrite: []; cancel: [] }>();

const reloadButton = ref<HTMLButtonElement | null>(null);

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

onMounted(() => {
  void nextTick().then(() => reloadButton.value?.focus());
});
</script>

<template>
  <div class="dialog-backdrop">
    <div
      class="dialog conflict-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-title"
      aria-describedby="conflict-detail"
    >
      <h2 id="conflict-title">{{ heading }}</h2>
      <p id="conflict-detail">
        The server has version <strong>{{ serverVersion }}</strong
        >. Your change was based on an older version.
      </p>
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
      <div class="dialog-actions">
        <button ref="reloadButton" type="button" class="primary-action" @click="emit('reload')">
          Reload server version
        </button>
        <button type="button" :disabled="disabled" @click="emit('overwrite')">
          {{ overwriteLabel }}
        </button>
        <button type="button" class="link-button" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
