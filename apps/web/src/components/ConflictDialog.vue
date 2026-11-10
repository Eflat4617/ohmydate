<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ConflictOperation } from '../composables/useTaskActions';

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

const dialog = ref<HTMLElement | null>(null);
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

function focusableElements(): HTMLElement[] {
  const root = dialog.value;
  if (root === null) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('cancel');
    return;
  }
  if (event.key !== 'Tab') return;

  const items = focusableElements();
  if (items.length === 0) {
    event.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  const inside = dialog.value?.contains(active ?? null) === true;

  if (event.shiftKey) {
    if (!inside || active === first) {
      event.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}

function trapFocus(event: FocusEvent): void {
  const root = dialog.value;
  if (root === null) return;
  const target = event.target;
  if (target instanceof Node && root.contains(target)) return;
  if (reloadButton.value !== null && !reloadButton.value.disabled) {
    reloadButton.value.focus();
    return;
  }
  root.focus();
}

onMounted(() => {
  document.addEventListener('focusin', trapFocus, true);
  void nextTick().then(() => reloadButton.value?.focus());
});

onBeforeUnmount(() => {
  document.removeEventListener('focusin', trapFocus, true);
});
</script>

<template>
  <div class="dialog-backdrop">
    <div
      ref="dialog"
      class="dialog conflict-dialog"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="conflict-title"
      aria-describedby="conflict-detail"
      @keydown="onKeydown"
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
        <button
          ref="reloadButton"
          type="button"
          class="primary-action"
          :disabled="disabled || busy"
          @click="emit('reload')"
        >
          Reload server version
        </button>
        <button type="button" :disabled="disabled || busy" @click="emit('overwrite')">
          {{ overwriteLabel }}
        </button>
        <button type="button" class="link-button" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
