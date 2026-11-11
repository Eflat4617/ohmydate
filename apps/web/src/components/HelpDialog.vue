<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <UiDialog
    v-if="open"
    labelledby="help-title"
    size="sm"
    close-on-backdrop
    @close="$emit('close')"
  >
    <header class="dialog-heading">
      <h2 id="help-title" class="dialog-title">Keyboard shortcuts</h2>
      <p class="muted">Single keys work anywhere outside a text field.</p>
    </header>
    <dl class="shortcut-list">
      <dt><kbd>n</kbd></dt>
      <dd>New task</dd>
      <dt><kbd>t</kbd></dt>
      <dd>Today</dd>
      <dt><kbd>f</kbd></dt>
      <dd>Focus session</dd>
      <dt><kbd>/</kbd></dt>
      <dd>Search</dd>
      <dt><kbd>?</kbd></dt>
      <dd>This help</dd>
      <dt><kbd>Esc</kbd></dt>
      <dd>Close dialogs</dd>
    </dl>
    <div class="dialog-actions">
      <UiButton variant="primary" data-autofocus @click="$emit('close')">Close</UiButton>
    </div>
  </UiDialog>
</template>
