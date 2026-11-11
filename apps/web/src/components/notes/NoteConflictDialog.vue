<script setup lang="ts">
import UiBanner from '../ui/UiBanner.vue';
import UiButton from '../ui/UiButton.vue';
import UiDialog from '../ui/UiDialog.vue';
import UiIcon from '../ui/UiIcon.vue';
import { t } from '../../i18n';

/**
 * 412 on save (07 §6): the note changed elsewhere. *Reload* shows the server
 * version (mine is dropped), *keep mine as a copy* saves my text as a new note
 * and leaves the server note alone, *keep editing* (also Escape) closes.
 */
withDefaults(
  defineProps<{
    serverVersion: number;
    serverTitle: string;
    localTitle: string;
    busy?: boolean;
    disabled?: boolean;
    error?: string | null;
  }>(),
  { busy: false, disabled: false, error: null },
);

const emit = defineEmits<{ reload: []; copy: []; keep: [] }>();
</script>

<template>
  <UiDialog
    labelledby="note-conflict-title"
    describedby="note-conflict-detail"
    role="alertdialog"
    class="conflict-dialog note-conflict-dialog"
    @close="emit('keep')"
  >
    <header class="dialog-header dialog-header--start">
      <span class="dialog-icon dialog-icon--warn"><UiIcon name="sync" :size="22" /></span>
      <div class="dialog-heading">
        <h2 id="note-conflict-title" class="dialog-title">{{ t('notes.conflict.title') }}</h2>
        <p id="note-conflict-detail" class="muted">{{ t('notes.conflict.body', { version: serverVersion }) }}</p>
      </div>
    </header>
    <dl class="conflict-summary">
      <dt>{{ t('notes.conflict.serverTitle') }}</dt>
      <dd>{{ serverTitle }}</dd>
      <dt>{{ t('conflict.yourEdit') }}</dt>
      <dd>{{ localTitle }}</dd>
    </dl>
    <UiBanner v-if="error" tone="error" role="alert">{{ error }}</UiBanner>
    <ul class="note-conflict-choices">
      <li>
        <UiButton variant="primary" data-autofocus :disabled="disabled || busy" data-conflict-reload @click="emit('reload')">
          {{ t('notes.conflict.reload') }}
        </UiButton>
        <span class="muted">{{ t('notes.conflict.reloadHelp') }}</span>
      </li>
      <li>
        <UiButton :disabled="disabled || busy" :busy="busy" data-conflict-copy @click="emit('copy')">
          {{ t('notes.conflict.copy') }}
        </UiButton>
        <span class="muted">{{ t('notes.conflict.copyHelp') }}</span>
      </li>
    </ul>
    <div class="dialog-actions">
      <UiButton variant="ghost" data-conflict-keep @click="emit('keep')">{{ t('notes.conflict.keep') }}</UiButton>
    </div>
  </UiDialog>
</template>
