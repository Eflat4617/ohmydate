<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import { t } from '../i18n';
import { NAV_PLACES } from '../layout/navigation';

/** The places that have a key of their own, in the sidebar's order. */
const PLACES = NAV_PLACES.filter((item) => item.shortcut !== undefined);

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
      <template v-for="item in PLACES" :key="item.id">
        <dt>
          <kbd>{{ item.shortcut }}</kbd>
        </dt>
        <dd>{{ t(item.label) }}</dd>
      </template>
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
