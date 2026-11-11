<script setup lang="ts">
import UiButton from './ui/UiButton.vue';
import UiDialog from './ui/UiDialog.vue';
import UiField from './ui/UiField.vue';
import { t } from '../i18n';

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();
</script>

<template>
  <UiDialog v-if="open" labelledby="search-title" close-on-backdrop @close="$emit('close')">
    <h2 id="search-title" class="dialog-title">{{ t('search.title') }}</h2>
    <UiField
      id="global-search"
      :label="t('search.label')"
      :help="t('search.help')"
    >
      <template #default="{ describedby }">
        <input
          id="global-search"
          type="search"
          :placeholder="t('search.placeholder')"
          autocomplete="off"
          data-autofocus
          :aria-describedby="describedby"
        />
      </template>
    </UiField>
    <div class="dialog-actions">
      <UiButton variant="primary" @click="$emit('close')">{{ t('common.close') }}</UiButton>
    </div>
  </UiDialog>
</template>
