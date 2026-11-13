<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import { t } from '../i18n';

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
      <h2 id="help-title" class="dialog-title">{{ t('help.title') }}</h2>
      <p class="muted">{{ t('help.lede') }}</p>
    </header>
    <dl class="shortcut-list">
      <dt><kbd>n</kbd></dt>
      <dd>{{ t('help.newTask') }}</dd>
      <dt><kbd>o</kbd></dt>
      <dd>{{ t('help.overview') }}</dd>
      <dt><kbd>t</kbd></dt>
      <dd>{{ t('help.today') }}</dd>
      <dt><kbd>m</kbd></dt>
      <dd>{{ t('help.month') }}</dd>
      <dt><kbd>f</kbd></dt>
      <dd>{{ t('help.focus') }}</dd>
      <dt><kbd>/</kbd></dt>
      <dd>{{ t('help.search') }}</dd>
      <dt><kbd>?</kbd></dt>
      <dd>{{ t('help.help') }}</dd>
      <dt><kbd>Esc</kbd></dt>
      <dd>{{ t('help.closeDialogs') }}</dd>
    </dl>
    <div class="dialog-actions">
      <UiButton variant="primary" data-autofocus @click="$emit('close')">{{ t('common.close') }}</UiButton>
    </div>
  </UiDialog>
</template>
