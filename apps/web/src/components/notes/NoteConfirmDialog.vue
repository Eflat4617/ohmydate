<script setup lang="ts">
import { useId } from 'vue';
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiIcon from '../ui/UiIcon.vue';

/**
 * Confirmation for a destructive or lossy step (delete a note, leave with
 * unsaved changes). An `alertdialog` whose focus starts on the safe choice;
 * Escape is the safe choice too.
 */
withDefaults(
  defineProps<{
    title: string;
    body: string;
    confirmLabel: string;
    cancelLabel: string;
    danger?: boolean;
    busy?: boolean;
    error?: string | null;
  }>(),
  { danger: true, busy: false, error: null },
);

const emit = defineEmits<{ confirm: []; cancel: [] }>();
const id = useId();
</script>

<template>
  <UiDialog
    :labelledby="`${id}-title`"
    :describedby="`${id}-body`"
    role="alertdialog"
    size="sm"
    class="note-confirm-dialog"
    @close="emit('cancel')"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon" :class="{ 'dialog-icon--warn': danger }"><UiIcon :name="danger ? 'trash' : 'warn'" :size="22" /></span>
      <div class="dialog-heading">
        <h2 :id="`${id}-title`" class="dialog-title">{{ title }}</h2>
        <p :id="`${id}-body`" class="muted">{{ body }}</p>
      </div>
    </header>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <div class="dialog-actions" :aria-busy="busy ? 'true' : undefined">
      <UiButton variant="ghost" data-autofocus :disabled="busy" @click="emit('cancel')">{{ cancelLabel }}</UiButton>
      <UiButton :variant="danger ? 'danger' : 'primary'" :busy="busy" :disabled="busy" data-confirm @click="emit('confirm')">
        {{ confirmLabel }}
      </UiButton>
    </div>
  </UiDialog>
</template>
