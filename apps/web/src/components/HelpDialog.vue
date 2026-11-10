<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

const props = defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();

const closeButton = ref<HTMLButtonElement | null>(null);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    await nextTick();
    closeButton.value?.focus();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="open" class="dialog-backdrop" @click.self="$emit('close')">
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-title"
      @keydown.esc.stop="$emit('close')"
    >
      <h2 id="help-title">Keyboard shortcuts</h2>
      <dl class="shortcut-list">
        <dt><kbd>n</kbd></dt>
        <dd>New task</dd>
        <dt><kbd>t</kbd></dt>
        <dd>Today</dd>
        <dt><kbd>/</kbd></dt>
        <dd>Search</dd>
        <dt><kbd>?</kbd></dt>
        <dd>This help</dd>
        <dt><kbd>Esc</kbd></dt>
        <dd>Close dialogs</dd>
      </dl>
      <button ref="closeButton" type="button" class="primary-action" @click="$emit('close')">
        Close
      </button>
    </div>
  </div>
</template>
